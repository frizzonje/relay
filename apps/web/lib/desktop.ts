// Мост между web-UI и десктоп-оболочкой (Tauri v2, clients/desktop). В обычном
// браузере — полный no-op: всё гейтится наличием window.__TAURI__ (появляется
// только внутри оболочки, включён `withGlobalTauri` в tauri.conf.json). Оболочка
// не форкает фронт — связь только через события Tauri:
//
//   • Rust → сюда: `ptt` (bool) от глобального хоткея → микрофон (desktopPtt);
//   • сюда → Rust: `voice-status` ({ in_call, muted }) → статус в трее,
//     `switch-server` → вернуть окно на экран выбора сервера.
//
// Права удалённого origin ограничены core:event (capabilities/remote.json).

import { desktopPtt } from '@/lib/voice';
import { useDesktopStore, type UpdateStatus } from '@/stores/desktop';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';

type TauriEvent<T> = { payload: T };
type UnlistenFn = () => void;

/** Сырой статус обновления от Rust (событие `update-status`). */
interface UpdateStatusPayload {
  state: 'checking' | 'up-to-date' | 'available' | 'installing' | 'error';
  version?: string;
  message?: string;
}

/** Перевод payload'а Rust в стор-состояние UpdateStatus. */
function toUpdateStatus(p: UpdateStatusPayload): UpdateStatus {
  switch (p.state) {
    case 'available':
      return { kind: 'available', version: p.version ?? '' };
    case 'installing':
      return { kind: 'installing', version: p.version ?? '' };
    case 'error':
      return { kind: 'error', message: p.message ?? 'неизвестная ошибка' };
    case 'up-to-date':
      return { kind: 'up-to-date' };
    default:
      return { kind: 'checking' };
  }
}

interface TauriGlobal {
  event: {
    listen: <T>(event: string, handler: (e: TauriEvent<T>) => void) => Promise<UnlistenFn>;
    emit: (event: string, payload?: unknown) => Promise<void>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

let initialized = false;

/**
 * Сторож «зависшей» проверки. UI-состояние `checking`/`installing` снимается
 * только терминальным `update-status` от Rust. Если это событие потеряется в
 * IPC (удалённый origin, core:event) или Rust не ответит — кнопка навсегда
 * застрянет на «Проверяю…». Поэтому на время проверки/установки заводим таймер:
 * не пришёл терминальный статус за отведённый срок → показываем ошибку и снова
 * даём нажать. Терминальный статус (в т.ч. запоздавший) чинит стор сам.
 */
let watchdog: ReturnType<typeof setTimeout> | null = null;

function clearWatchdog() {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/** Взвести сторож на `ms`; по срабатыванию — ошибка, если всё ещё «в процессе». */
function armWatchdog(ms: number) {
  clearWatchdog();
  watchdog = setTimeout(() => {
    watchdog = null;
    const kind = useDesktopStore.getState().update.kind;
    if (kind === 'checking' || kind === 'installing') {
      useDesktopStore
        .getState()
        .setUpdate({ kind: 'error', message: 'нет ответа — попробуйте ещё раз' });
    }
  }, ms);
}

// Проверка укладывается в ~41с (2 попытки по 20с + пауза, см. run_check в
// main.rs); ставим сторож с запасом, чтобы бить только по реально потерянному
// событию, а не по медленной сети. Установка качает ~3 МБ — срок щедрее.
const CHECK_WATCHDOG_MS = 45_000;
const INSTALL_WATCHDOG_MS = 240_000;

/**
 * Навесить десктоп-мост. Идемпотентно; вне Tauri ничего не делает, поэтому
 * безопасно звать из общего провайдера (SocketProvider) вместе с initVoice.
 */
export async function initDesktopBridge() {
  if (initialized || typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  if (!tauri) return; // обычный браузер — нативных фич нет
  initialized = true;

  // Мы внутри оболочки — настройки покажут блок обновлений.
  useDesktopStore.getState().setDesktop(true);

  // Rust эмитит `ptt` при нажатии/отпускании глобального хоткея.
  void tauri.event.listen<boolean>('ptt', (e) => desktopPtt(e.payload === true));

  // Статус обновления от Rust (up-to-date/available/installing/error): применяем
  // и снимаем/переводим сторож. Терминальный статус гасит сторож; `installing`
  // продлевает его на время загрузки. `check-updates` фоновые (авто/трей) сюда
  // `checking` больше НЕ шлют — «Проверяю…» ставит только кнопка (checkForUpdates),
  // иначе запоздавший фоновый `checking` мог перекрыть уже показанный результат.
  await tauri.event.listen<UpdateStatusPayload>('update-status', (e) => {
    const status = toUpdateStatus(e.payload);
    useDesktopStore.getState().setUpdate(status);
    if (status.kind === 'installing') armWatchdog(INSTALL_WATCHDOG_MS);
    else if (status.kind !== 'checking') clearWatchdog();
  });

  // Тихая проверка при старте: notify=true разрешает Rust показать системную
  // подсказку, если апдейт вышел. Установку не запускаем — только осведомляем.
  // Эмитим ПОСЛЕ навешивания слушателя выше (listen асинхронный) — иначе первый
  // ответ Rust мог прийти в пустоту.
  void tauri.event.emit('check-updates', { notify: true });

  // Отражаем состояние звонка в трее оболочки: в эфире (есть voiceRoom) и mute.
  const pushStatus = () => {
    void tauri.event.emit('voice-status', {
      in_call: useUiStore.getState().voiceRoom !== null,
      muted: !useVoiceStore.getState().micOn,
    });
  };

  pushStatus(); // стартовое состояние (обычно «не в эфире»)
  useVoiceStore.subscribe((s, p) => {
    if (s.micOn !== p.micOn) pushStatus();
  });
  useUiStore.subscribe((s, p) => {
    if (s.voiceRoom !== p.voiceRoom) pushStatus();
  });
}

/**
 * Вернуть оболочку на экран выбора сервера (кнопка «Сменить сервер» в
 * настройках). Навигацию делает Rust — у удалённого origin прав на окно нет,
 * только события. Вне Tauri — no-op: в браузере адрес и так в адресной строке.
 */
export function switchServer() {
  if (typeof window === 'undefined') return;
  void window.__TAURI__?.event.emit('switch-server');
}

/**
 * Запросить проверку обновлений (кнопка «Проверить обновления»). Вне Tauri —
 * no-op. Результат придёт событием `update-status` в стор. notify=false: UI и
 * так покажет статус, системная подсказка не нужна.
 */
export function checkForUpdates() {
  if (typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  if (!tauri) return;
  useDesktopStore.getState().setUpdate({ kind: 'checking' });
  armWatchdog(CHECK_WATCHDOG_MS); // не залипнуть на «Проверяю…», если ответ потеряется
  void tauri.event.emit('check-updates', { notify: false });
}

/**
 * Установить найденное обновление и перезапустить приложение (кнопка «Установить
 * и перезапустить»). Явное действие пользователя — только так Rust ставит апдейт.
 */
export function installUpdate() {
  if (typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  if (!tauri) return;
  // Оптимистично переводим в «Устанавливаю…»: прячем кнопку (нет двойного клика)
  // и взводим сторож сразу — Rust сначала перепроверит релиз (до ~120с) и лишь
  // потом пришлёт свой `installing`. Версию берём из уже найденного апдейта.
  const cur = useDesktopStore.getState().update;
  const version = cur.kind === 'available' ? cur.version : '';
  useDesktopStore.getState().setUpdate({ kind: 'installing', version });
  armWatchdog(INSTALL_WATCHDOG_MS);
  void tauri.event.emit('install-update');
}

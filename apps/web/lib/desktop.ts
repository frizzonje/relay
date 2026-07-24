// Мост между web-UI и десктоп-оболочкой (Tauri v2, clients/desktop). В обычном
// браузере — полный no-op: всё гейтится наличием window.__TAURI__ (появляется
// только внутри оболочки, включён `withGlobalTauri` в tauri.conf.json). Оболочка
// не форкает фронт — связь только через события Tauri:
//
//   • Rust → сюда: `ptt` (bool) от глобального хоткея → микрофон (desktopPtt),
//     `desktop-settings` → текущие настройки оболочки (хоткей, автозапуск);
//   • сюда → Rust: `voice-status` ({ in_call, muted }) → статус в трее,
//     `desktop-settings-get` → запрос настроек, `set-ptt-shortcut` /
//     `set-autostart` → их правка, `switch-server` → экран выбора сервера.
//
// Права удалённого origin ограничены core:event (capabilities/remote.json).

import { desktopPtt } from '@/lib/voice';
import { useDesktopStore, type ShellSettings, type UpdateStatus } from '@/stores/desktop';
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
 * Отправить событие оболочке, не проглотив отказ. Права удалённого origin
 * выдаёт capabilities/remote.json; если origin под них не подошёл, Tauri
 * отклоняет вызов — а `void emit(...)` делал это молча, и снаружи выглядело
 * так, будто оболочка просто ничего не умеет: нативные настройки не
 * появляются, ошибки нет. Теперь причина видна в консоли.
 */
function send(event: string, payload?: unknown) {
  if (typeof window === 'undefined') return;
  const ev = window.__TAURI__?.event;
  if (!ev) return;
  // Без payload'а зовём emit одним аргументом: у события-запроса (например
  // `desktop-settings-get`) payload'а нет вовсе, и подсовывать undefined незачем.
  const sent = payload === undefined ? ev.emit(event) : ev.emit(event, payload);
  sent.catch((err: unknown) => {
    console.error(`[desktop] оболочка отклонила событие «${event}»:`, err);
  });
}

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

  // Подписки требуют права `core:event` у ЭТОГО origin. Нет права — listen
  // отклоняется, и без catch первый же `await` тихо ронял всю инициализацию:
  // мост выглядел живым (isDesktop=true), но событий не было ни в одну сторону.
  try {
    // Rust эмитит `ptt` при нажатии/отпускании глобального хоткея.
    await tauri.event.listen<boolean>('ptt', (e) => desktopPtt(e.payload === true));

    // Настройки оболочки. Ответ на них — заодно признак того, что оболочка вообще
    // умеет в настройки: клиенты до 0.4.0 промолчат, и UI их не покажет.
    await tauri.event.listen<ShellSettings>('desktop-settings', (e) => {
      useDesktopStore.getState().setShell(e.payload);
    });

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
  } catch (err) {
    console.error(
      '[desktop] мост не поднялся: оболочка отклонила подписку на события. ' +
        'Обычно это origin вне capabilities/remote.json (например, нестандартный порт).',
      err,
    );
    return;
  }

  // Эмитим ПОСЛЕ навешивания слушателей выше (listen асинхронный) — иначе первый
  // ответ Rust мог прийти в пустоту.
  requestShellSettings();

  // Тихая проверка при старте: notify=true разрешает Rust показать системную
  // подсказку, если апдейт вышел. Установку не запускаем — только осведомляем.
  send('check-updates', { notify: true });

  // Отражаем состояние звонка в трее оболочки: в эфире (есть voiceRoom) и mute.
  const pushStatus = () => {
    send('voice-status', {
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
 * Спросить оболочку о её настройках (хоткей, автозапуск). Ответ придёт событием
 * `desktop-settings` в стор. Зовём при инициализации моста и при открытии
 * настроек: во-первых, лечит потерянный стартовый ответ, во-вторых, тумблер
 * автозапуска обязан показывать ФАКТИЧЕСКОЕ состояние — его могли снять
 * средствами системы, пока клиент работал.
 */
export function requestShellSettings() {
  send('desktop-settings-get');
}

/**
 * Назначить глобальный push-to-talk (комбинация в формате lib/hotkeys) или
 * выключить его (null). Применяет и проверяет Rust: только он знает, удалось ли
 * перехватить клавишу в системе, — ответ придёт событием `desktop-settings`
 * (с `pttError`, если не удалось). Поэтому локально ничего не «оптимистично»
 * не меняем: показываем ровно то, что реально применилось.
 */
export function setPttShortcut(combo: string | null) {
  send('set-ptt-shortcut', combo);
}

/** Включить/выключить автозапуск при входе в систему (применяет Rust). */
export function setAutostart(on: boolean) {
  send('set-autostart', on);
}

/**
 * Вернуть оболочку на экран выбора сервера (кнопка «Сменить сервер» в
 * настройках). Навигацию делает Rust — у удалённого origin прав на окно нет,
 * только события. Вне Tauri — no-op: в браузере адрес и так в адресной строке.
 */
export function switchServer() {
  send('switch-server');
}

/**
 * Запросить проверку обновлений (кнопка «Проверить обновления»). Вне Tauri —
 * no-op. Результат придёт событием `update-status` в стор. notify=false: UI и
 * так покажет статус, системная подсказка не нужна.
 */
export function checkForUpdates() {
  if (typeof window === 'undefined' || !window.__TAURI__) return;
  useDesktopStore.getState().setUpdate({ kind: 'checking' });
  armWatchdog(CHECK_WATCHDOG_MS); // не залипнуть на «Проверяю…», если ответ потеряется
  send('check-updates', { notify: false });
}

/**
 * Установить найденное обновление и перезапустить приложение (кнопка «Установить
 * и перезапустить»). Явное действие пользователя — только так Rust ставит апдейт.
 */
export function installUpdate() {
  if (typeof window === 'undefined' || !window.__TAURI__) return;
  // Оптимистично переводим в «Устанавливаю…»: прячем кнопку (нет двойного клика)
  // и взводим сторож сразу — Rust сначала перепроверит релиз (до ~120с) и лишь
  // потом пришлёт свой `installing`. Версию берём из уже найденного апдейта.
  const cur = useDesktopStore.getState().update;
  const version = cur.kind === 'available' ? cur.version : '';
  useDesktopStore.getState().setUpdate({ kind: 'installing', version });
  armWatchdog(INSTALL_WATCHDOG_MS);
  send('install-update');
}

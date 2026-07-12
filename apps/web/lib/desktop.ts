// Мост между web-UI и десктоп-оболочкой (Tauri v2, clients/desktop). В обычном
// браузере — полный no-op: всё гейтится наличием window.__TAURI__ (появляется
// только внутри оболочки, включён `withGlobalTauri` в tauri.conf.json). Оболочка
// не форкает фронт — связь только через события Tauri:
//
//   • Rust → сюда: `ptt` (bool) от глобального хоткея → микрофон (desktopPtt);
//   • сюда → Rust: `voice-status` ({ in_call, muted }) → статус в трее.
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
 * Навесить десктоп-мост. Идемпотентно; вне Tauri ничего не делает, поэтому
 * безопасно звать из общего провайдера (SocketProvider) вместе с initVoice.
 */
export function initDesktopBridge() {
  if (initialized || typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  if (!tauri) return; // обычный браузер — нативных фич нет
  initialized = true;

  // Мы внутри оболочки — настройки покажут блок обновлений.
  useDesktopStore.getState().setDesktop(true);

  // Rust эмитит `ptt` при нажатии/отпускании глобального хоткея.
  void tauri.event.listen<boolean>('ptt', (e) => desktopPtt(e.payload === true));

  // Статус обновления от Rust (checking/up-to-date/available/installing/error).
  void tauri.event.listen<UpdateStatusPayload>('update-status', (e) => {
    useDesktopStore.getState().setUpdate(toUpdateStatus(e.payload));
  });

  // Тихая проверка при старте: notify=true разрешает Rust показать системную
  // подсказку, если апдейт вышел. Установку не запускаем — только осведомляем.
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
 * Запросить проверку обновлений (кнопка «Проверить обновления»). Вне Tauri —
 * no-op. Результат придёт событием `update-status` в стор. notify=false: UI и
 * так покажет статус, системная подсказка не нужна.
 */
export function checkForUpdates() {
  if (typeof window === 'undefined') return;
  const tauri = window.__TAURI__;
  if (!tauri) return;
  useDesktopStore.getState().setUpdate({ kind: 'checking' });
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
  void tauri.event.emit('install-update');
}

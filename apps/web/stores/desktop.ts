import { create } from 'zustand';

/**
 * Состояние десктоп-оболочки (Tauri). В обычном браузере `isDesktop=false` и
 * блок обновлений в настройках просто не рендерится. Обновления идут через
 * события Tauri (см. lib/desktop.ts): web просит проверить/установить, Rust
 * присылает статус. Ничего не ставится без явного клика — решает пользователь.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string };

/**
 * Настройки оболочки. Источник истины — Rust (файл `settings.json` рядом с
 * приложением): они переживают смену сервера и перезапуск, а глобальный хоткей
 * поднимается ещё до загрузки web-UI. Здесь — только зеркало ответа оболочки.
 */
export interface ShellSettings {
  /** Комбинация глобального push-to-talk; null — пользователь его выключил. */
  ptt: string | null;
  /** Комбинация «из коробки» — показываем как подсказку при сбросе. */
  pttDefault: string;
  /** Почему хоткей не применился (занят другой программой и т.п.). */
  pttError: string | null;
  /** Фактическое состояние автозапуска (оболочка спрашивает систему). */
  autostart: boolean;
  autostartError: string | null;
  /** Версия оболочки — она может отличаться от версии web-UI. */
  version: string;
}

interface DesktopState {
  /** true только внутри Tauri-оболочки (window.__TAURI__). */
  isDesktop: boolean;
  update: UpdateStatus;
  /**
   * null — оболочка про настройки не ответила: либо мы в браузере, либо это
   * старая версия клиента (до 0.4.0). В обоих случаях блоки настроек оболочки
   * не рендерим: показывать тумблеры, которые ничего не переключают, хуже, чем
   * не показывать их вовсе.
   */
  shell: ShellSettings | null;
  setDesktop: (v: boolean) => void;
  setUpdate: (u: UpdateStatus) => void;
  setShell: (s: ShellSettings) => void;
}

export const useDesktopStore = create<DesktopState>((set) => ({
  isDesktop: false,
  update: { kind: 'idle' },
  shell: null,
  setDesktop: (v) => set({ isDesktop: v }),
  setUpdate: (u) => set({ update: u }),
  setShell: (s) => set({ shell: s }),
}));

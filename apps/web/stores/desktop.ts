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

interface DesktopState {
  /** true только внутри Tauri-оболочки (window.__TAURI__). */
  isDesktop: boolean;
  update: UpdateStatus;
  setDesktop: (v: boolean) => void;
  setUpdate: (u: UpdateStatus) => void;
}

export const useDesktopStore = create<DesktopState>((set) => ({
  isDesktop: false,
  update: { kind: 'idle' },
  setDesktop: (v) => set({ isDesktop: v }),
  setUpdate: (u) => set({ update: u }),
}));

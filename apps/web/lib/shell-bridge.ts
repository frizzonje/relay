/**
 * Связь с нативной оболочкой — одна на две реализации.
 *
 * Оболочек у relay две, и это не дублирование, а следствие движков:
 *   • Windows и macOS — Tauri v2 (`clients/desktop`), мост живёт в
 *     `window.__TAURI__.event`;
 *   • Linux — Electron (`clients/desktop-linux`), мост живёт в
 *     `window.__RELAY_SHELL__`. Он там потому, что системный WebKitGTK, который
 *     берёт Tauri, собран без WebRTC — звонков в нём нет и не будет
 *     (см. lib/voice-support.ts и clients/desktop-linux/README.md).
 *
 * Веб-UI об этой разнице знать не должен: имена событий, payload'ы и форма
 * вызовов у обеих оболочек одинаковые (listen → Promise<unlisten>, handler
 * получает `{ payload }`, emit → Promise, который ОТКЛОНЯЕТСЯ при отказе).
 * Поэтому весь остальной код спрашивает мост здесь и больше нигде не трогает
 * ни `__TAURI__`, ни `__RELAY_SHELL__`.
 */

/** События оболочки в том объёме, в каком они нужны web-UI. */
export interface ShellBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  emit(event: string, payload?: unknown): Promise<void>;
}

/** Какая оболочка вокруг нас; null — обычный браузер. */
export type ShellKind = 'tauri' | 'electron';

declare global {
  interface Window {
    __TAURI__?: { event: ShellBridge };
    __RELAY_SHELL__?: ShellBridge & { kind?: string };
  }
}

/** Мост к оболочке или null, если мы в обычном браузере. */
export function shellBridge(): ShellBridge | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__?.event ?? window.__RELAY_SHELL__ ?? null;
}

/** Мы внутри нативной оболочки? */
export function inShell(): boolean {
  return shellBridge() !== null;
}

/**
 * Какая именно оболочка. Нужно там, где поведение зависит от движка, а не от
 * самого факта оболочки, — например в диагностике «почему нет звонков».
 */
export function shellKind(): ShellKind | null {
  if (typeof window === 'undefined') return null;
  if (window.__TAURI__?.event) return 'tauri';
  if (window.__RELAY_SHELL__) return 'electron';
  return null;
}

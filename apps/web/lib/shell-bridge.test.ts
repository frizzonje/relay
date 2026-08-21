// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { inShell, shellBridge, shellKind } from '@/lib/shell-bridge';

/**
 * Одна дверь в оболочку на две реализации. Тест держит именно её: остальной код
 * не должен знать ни про `__TAURI__`, ни про `__RELAY_SHELL__`, и если завтра
 * появится третья оболочка, править надо будет только shell-bridge.ts.
 */

const fakeBridge = () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
});

afterEach(() => {
  window.__TAURI__ = undefined;
  window.__RELAY_SHELL__ = undefined;
});

describe('shellBridge', () => {
  it('в браузере оболочки нет', () => {
    expect(shellBridge()).toBeNull();
    expect(inShell()).toBe(false);
    expect(shellKind()).toBeNull();
  });

  it('Tauri: мост берётся из window.__TAURI__.event', () => {
    const event = fakeBridge();
    window.__TAURI__ = { event };
    expect(shellBridge()).toBe(event);
    expect(shellKind()).toBe('tauri');
  });

  it('Electron: мост берётся из window.__RELAY_SHELL__', () => {
    const bridge = { kind: 'electron', ...fakeBridge() };
    window.__RELAY_SHELL__ = bridge;
    expect(shellBridge()).toBe(bridge);
    expect(shellKind()).toBe('electron');
  });

  it('пустой __TAURI__ без event — не оболочка, а мусор в window', () => {
    // Настоящая Tauri-сборка всегда кладёт `event` (withGlobalTauri). Объект без
    // него означал бы мост, через который ничего не ходит, — и весь код выше по
    // течению ждал бы ответов, которых не будет.
    window.__TAURI__ = {} as unknown as typeof window.__TAURI__;
    expect(shellBridge()).toBeNull();
    expect(inShell()).toBe(false);
  });
});

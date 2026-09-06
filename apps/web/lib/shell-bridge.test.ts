// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { inShell, shellBridge, shellKind, shellRingStart, shellRingStop } from '@/lib/shell-bridge';

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

/**
 * Входящий звонок → оболочка (задача 9 плана B). Живут здесь, а не в
 * `lib/desktop.ts`: это ровно то, что зовёт `lib/notify.ts`, и держать эти
 * функции рядом с голосом/сокетом/сторами значило бы тащить их в модуль,
 * который импортирует половина чата (см. комментарий у `shellSend` выше).
 *
 * Оболочка умеет то, чего вкладка не может: поднять окно поверх всего и
 * написать в трее, что звонят. Событие одно на оба края вызова
 * (`ringing: true|false`) — трей обязан вернуться к обычному статусу, чем бы
 * вызов ни кончился, а два разных события однажды разошлись бы: одно
 * послали, второе забыли.
 *
 * `notify` — это «системное окошко покажи ТЫ»: в оболочке вкладка своего не
 * рисует вовсе (в WKWebView его и нет), и решение принимается в одном месте,
 * а не двумя сторонами независимо (см. lib/notify.ts).
 */
describe('входящий вызов', () => {
  it('шлёт оболочке ник, вид вызова и просьбу показать окошко', () => {
    const emit = vi.fn(() => Promise.resolve());
    window.__TAURI__ = { event: { listen: fakeBridge().listen, emit } };
    shellRingStart({ nick: 'Аня', video: true, notify: true });
    expect(emit).toHaveBeenCalledWith('call-ringing', {
      ringing: true,
      nick: 'Аня',
      video: true,
      notify: true,
    });
  });

  it('конец вызова гасит звонок тем же событием', () => {
    const emit = vi.fn(() => Promise.resolve());
    window.__TAURI__ = { event: { listen: fakeBridge().listen, emit } };
    shellRingStop();
    expect(emit).toHaveBeenCalledWith('call-ringing', { ringing: false });
  });

  it('вне оболочки молчит — в браузере окно поднимать нечем', () => {
    const emit = vi.fn(() => Promise.resolve());
    window.__TAURI__ = undefined;
    shellRingStart({ nick: 'Аня', video: false, notify: true });
    shellRingStop();
    expect(emit).not.toHaveBeenCalled();
  });
});

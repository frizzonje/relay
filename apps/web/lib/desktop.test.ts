// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Мост web ↔ десктоп-оболочка (lib/desktop.ts). Контракт держится на строковых
 * именах событий и форме payload'ов — TypeScript через границу оболочки их не
 * проверяет, а опечатка означает молча неработающую фичу (оболочка просто
 * никогда не получит событие). Поэтому имена и payload'ы фиксируем тестом;
 * парные стороны — `handle.listen(...)` в clients/desktop/src-tauri/src/main.rs
 * (Tauri, Windows/macOS) и `handle(...)` в clients/desktop-linux/src/main.js
 * (Electron, Linux).
 *
 * Голоса и сторов тут нет: проверяем ровно мост, остальное замокано.
 */

vi.mock('@/lib/voice', () => ({ desktopPtt: vi.fn() }));

import { useDesktopStore } from '@/stores/desktop';
import {
  initDesktopBridge,
  requestShellSettings,
  setAutostart,
  setPttShortcut,
} from '@/lib/desktop';

type Handler = (e: { payload: unknown }) => void;

const listeners: Record<string, Handler> = {};
// Настоящий `emit` из Tauri возвращает Promise и ОТКЛОНЯЕТСЯ, если у origin нет
// права core:event, — мост обязан это ловить, поэтому мок тоже промисовый.
const emit = vi.fn(() => Promise.resolve());

beforeEach(() => {
  emit.mockClear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  window.__TAURI__ = {
    event: {
      listen: (event: string, handler: Handler) => {
        listeners[event] = handler;
        return Promise.resolve(() => {});
      },
      emit,
    },
  } as unknown as typeof window.__TAURI__;
});

const SETTINGS = {
  ptt: 'Ctrl+Shift+KeyT',
  pttDefault: 'F8',
  pttError: null,
  autostart: false,
  autostartError: null,
  version: '0.4.0',
};

describe('мост настроек оболочки', () => {
  it('запрашивает настройки и раскладывает ответ в стор', async () => {
    // Мост навешивается один раз на приложение (initialized-флаг), поэтому
    // стартовый handshake проверяем здесь же, до остальных кейсов.
    await initDesktopBridge();
    expect(emit).toHaveBeenCalledWith('desktop-settings-get');
    expect(useDesktopStore.getState().shell).toBeNull(); // ответа ещё не было

    listeners['desktop-settings']({ payload: SETTINGS });
    expect(useDesktopStore.getState().shell).toEqual(SETTINGS);
  });

  it('шлёт комбинацию и null (выключение) одним и тем же событием', () => {
    setPttShortcut('Ctrl+Shift+KeyT');
    expect(emit).toHaveBeenCalledWith('set-ptt-shortcut', 'Ctrl+Shift+KeyT');

    // null — «хоткей выключить»; Rust разбирает payload как Option<String>,
    // поэтому именно null, а не пустая строка и не отсутствие payload'а.
    setPttShortcut(null);
    expect(emit).toHaveBeenCalledWith('set-ptt-shortcut', null);
  });

  it('шлёт автозапуск булевым payload', () => {
    setAutostart(true);
    expect(emit).toHaveBeenCalledWith('set-autostart', true);
    setAutostart(false);
    expect(emit).toHaveBeenCalledWith('set-autostart', false);
  });

  it('вне Tauri молчит: в браузере оболочки нет', () => {
    window.__TAURI__ = undefined;
    requestShellSettings();
    setPttShortcut('F8');
    setAutostart(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('отказ оболочки в правах не роняет вызывающий код, а логируется', async () => {
    const err = new Error('event.emit not allowed on this origin');
    window.__TAURI__ = {
      event: { listen: () => Promise.resolve(() => {}), emit: () => Promise.reject(err) },
    } as unknown as typeof window.__TAURI__;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => setAutostart(true)).not.toThrow();
    await Promise.resolve(); // дать сработать catch'у
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('set-autostart'), err);
    spy.mockRestore();
  });
});

/**
 * Реальный баг 0.4.0: capability для удалённого origin (capabilities/remote.json)
 * не покрывала адреса с явным портом, и `listen` отклонялся. Мост при этом
 * «выглядел живым» — isDesktop=true, кнопки на месте, — но события не ходили ни
 * в одну сторону, и нативные настройки просто не появлялись без единой ошибки.
 * Фиксируем: отказ подписки не должен молча проглатываться.
 */
describe('оболочка отказала в подписке на события', () => {
  it('мост сдаётся с явной ошибкой в консоли, не бросая наружу', async () => {
    vi.resetModules(); // сбросить одноразовый `initialized` внутри модуля
    const denied = new Error('event.listen not allowed on this origin');
    window.__TAURI__ = {
      event: { listen: () => Promise.reject(denied), emit },
    } as unknown as typeof window.__TAURI__;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fresh = await import('@/lib/desktop');
    await expect(fresh.initDesktopBridge()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('мост не поднялся'), denied);
    expect(emit).not.toHaveBeenCalled(); // без подписок ничего не шлём
    spy.mockRestore();
  });
});

/**
 * Вторая оболочка. На Linux мост живёт не в `window.__TAURI__`, а в
 * `window.__RELAY_SHELL__` (движок там Electron — WebKitGTK не умеет WebRTC),
 * и весь смысл lib/shell-bridge.ts в том, что остальной код разницы не видит.
 * Проверяем именно это: те же имена событий ходят через другой транспорт.
 */
describe('оболочка на Electron (Linux)', () => {
  it('мост поднимается и шлёт те же события', async () => {
    vi.resetModules(); // сбросить одноразовый `initialized` внутри модуля
    window.__TAURI__ = undefined;
    const shellEmit = vi.fn(() => Promise.resolve());
    const shellListeners: Record<string, Handler> = {};
    window.__RELAY_SHELL__ = {
      kind: 'electron',
      listen: (event: string, handler: Handler) => {
        shellListeners[event] = handler;
        return Promise.resolve(() => {});
      },
      emit: shellEmit,
    } as unknown as typeof window.__RELAY_SHELL__;

    // resetModules даёт мосту СВОЙ экземпляр стора — спрашивать надо его же,
    // иначе проверка читает стор из прошлых кейсов файла.
    const fresh = await import('@/lib/desktop');
    const { useDesktopStore: freshStore } = await import('@/stores/desktop');
    await fresh.initDesktopBridge();

    expect(freshStore.getState().isDesktop).toBe(true);
    expect(shellEmit).toHaveBeenCalledWith('desktop-settings-get');
    expect(Object.keys(shellListeners).sort()).toEqual([
      'desktop-settings',
      'ptt',
      'update-status',
    ]);

    // Ответ оболочки без полей хоткея — «фичи нет», а не «хоткей выключен».
    shellListeners['desktop-settings']({
      payload: { autostart: false, autostartError: null, version: '1.0.0' },
    });
    expect(freshStore.getState().shell).toEqual({
      autostart: false,
      autostartError: null,
      version: '1.0.0',
    });

    window.__RELAY_SHELL__ = undefined;
  });
});

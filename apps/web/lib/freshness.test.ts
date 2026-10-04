// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

import { initFreshness } from './freshness';
import { useUiStore } from '@/stores/ui';

/** Сокет, у которого можно дёрнуть `connect` руками. */
function fakeSocket() {
  const handlers = new Set<() => void>();
  return {
    on: (_: 'connect', fn: () => void) => handlers.add(fn),
    off: (_: 'connect', fn: () => void) => handlers.delete(fn),
    connect: () => handlers.forEach((fn) => fn()),
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('initFreshness', () => {
  let server = 'b1';
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = '<meta name="relay-build" content="b1">';
    sessionStorage.clear();
    toast.mockClear();
    server = 'b1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ build: server }) })),
    );
    useUiStore.setState({ voiceRoom: null });
    setVisibility('visible');
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start() {
    const socket = fakeSocket();
    const reload = vi.fn();
    stop = initFreshness(socket, { reload });
    return { socket, reload };
  }

  /** Переподключение после деплоя: проверка через 3 с. */
  async function reconnect(socket: ReturnType<typeof fakeSocket>) {
    socket.connect();
    await vi.advanceTimersByTimeAsync(3_000);
  }

  it('сборка та же — ничего не происходит', async () => {
    const { socket, reload } = await start();
    await reconnect(socket);
    expect(reload).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('окно скрыто (трей) — перезагружается сразу', async () => {
    const { socket, reload } = await start();
    setVisibility('hidden');
    server = 'b2';
    await reconnect(socket);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('окно перед глазами — кнопка, а перезагрузка, когда окно уйдёт', async () => {
    const { socket, reload } = await start();
    server = 'b2';
    await reconnect(socket);
    expect(reload).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('в звонке — ждёт его конца', async () => {
    const { socket, reload } = await start();
    useUiStore.setState({ voiceRoom: 'efir' });
    setVisibility('hidden');
    server = 'b2';
    await reconnect(socket);
    expect(reload).not.toHaveBeenCalled();
    useUiStore.setState({ voiceRoom: null });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('уже перезагружались ради этой сборки — второй раз не крутит', async () => {
    sessionStorage.setItem('relay-reloaded-for', 'b2');
    const { socket, reload } = await start();
    setVisibility('hidden');
    server = 'b2';
    await reconnect(socket);
    expect(reload).not.toHaveBeenCalled();
  });

  it('dev-сервер — молчит', async () => {
    document.head.innerHTML = '<meta name="relay-build" content="dev">';
    const { socket, reload } = await start();
    server = 'b2';
    setVisibility('hidden');
    await reconnect(socket);
    expect(reload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

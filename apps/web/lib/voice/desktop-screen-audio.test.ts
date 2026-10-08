import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Нативный звук демонстрации (оболочка на Windows): граф Web Audio, который
 * собирается по формату от оболочки и разбирается остановкой. Остановка
 * асинхронна (`AudioContext.close`), и следующий старт успевает начаться, пока
 * она не кончилась, — проверяется, что они не затирают друг друга и что
 * старт, который остановили, не повисает навсегда.
 */

type Handler = (e: { payload: unknown }) => void;
const shell = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  emit: vi.fn(async () => {}),
}));
vi.mock('@/lib/shell-bridge', () => ({
  shellBridge: () => ({
    listen: async (event: string, handler: Handler) => {
      shell.handlers.set(event, handler);
      return () => shell.handlers.delete(event);
    },
    emit: shell.emit,
  }),
}));

const contexts: FakeCtx[] = [];
class FakeCtx {
  state: AudioContextState = 'running';
  audioWorklet = { addModule: async () => {} };
  /** Закрытие, которое тест отпускает сам. */
  release: () => void = () => {};
  close = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        this.release = () => {
          this.state = 'closed';
          resolve();
        };
      }),
  );
  constructor() {
    contexts.push(this);
  }
  createMediaStreamDestination() {
    return {
      stream: { getAudioTracks: () => [{ id: `track-${contexts.length}` }] },
      disconnect: () => {},
    };
  }
}
class FakeNode {
  port = { postMessage: () => {} };
  connect() {}
  disconnect() {}
}

let audio: typeof import('./desktop-screen-audio');

beforeEach(async () => {
  vi.resetModules();
  contexts.length = 0;
  shell.handlers.clear();
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  audio = await import('./desktop-screen-audio');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Оболочка прислала формат — граф собирается. */
async function format() {
  await vi.waitFor(() => expect(shell.handlers.has('screen-audio-format')).toBe(true));
  shell.handlers.get('screen-audio-format')!({ payload: { sampleRate: 48000 } });
}

describe('нативный звук демонстрации', () => {
  it('остановка посреди старта отпускает старт, а не оставляет его висеть', async () => {
    let settled = false;
    const starting = audio.startNativeScreenAudio().then((t) => {
      settled = true;
      return t;
    });
    await vi.waitFor(() => expect(shell.emit).toHaveBeenCalledWith('screen-audio-start'));
    void audio.stopNativeScreenAudio();
    await vi.waitFor(() => expect(settled).toBe(true));
    await expect(starting).resolves.toBeNull();
  });

  it('новый старт, пока закрывается прошлый граф, остаётся живым', async () => {
    const first = audio.startNativeScreenAudio();
    await format();
    expect(await first).not.toBeNull();

    // Показ остановили и сразу начали снова; закрытие первого ещё идёт.
    const stopping = audio.stopNativeScreenAudio();
    const second = audio.startNativeScreenAudio();
    await format();
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    contexts[0].release();
    await stopping;
    expect(await second).not.toBeNull();

    // Модуль по-прежнему знает второй граф: следующая остановка закрывает его.
    void audio.stopNativeScreenAudio();
    expect(contexts[1].close).toHaveBeenCalled();
  });
});

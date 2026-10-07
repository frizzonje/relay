import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Единственная дорога вопросов с ответом. Сторожим здесь то, ради чего она
 * заведена: срок есть у каждого вопроса, и молчание сервера приезжает `null`,
 * а не вечным ожиданием.
 */

const emit = vi.hoisted(() => vi.fn());
const timeout = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', async () => {
  const { timeoutOf } = await import('@/lib/testing/socket');
  const timed = timeoutOf(emit);
  timeout.mockImplementation(timed);
  return { getSocket: () => ({ emit, timeout }) };
});

import { REQUEST_TIMEOUT_MS, request, requestWithin } from './request';

/** Ответить за сервер на последний вопрос. */
function reply(res: unknown) {
  const cb = emit.mock.calls.at(-1)?.at(-1) as (r: unknown) => void;
  cb(res);
}

beforeEach(() => {
  vi.useFakeTimers();
  emit.mockClear();
  timeout.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('request', () => {
  it('отдаёт ответ сервера и уходит с аргументами события', async () => {
    const p = request('channel-delete', { id: 'ch-1' });
    expect(emit).toHaveBeenCalledWith('channel-delete', { id: 'ch-1' }, expect.any(Function));
    reply({ ok: true });
    expect(await p).toEqual({ ok: true });
  });

  it('событие без аргументов уходит одним колбэком', async () => {
    const p = request('dm-list');
    expect(emit).toHaveBeenCalledWith('dm-list', expect.any(Function));
    reply({ ok: true, conversations: [] });
    expect(await p).toEqual({ ok: true, conversations: [] });
  });

  it('спрашивает через timeout() socket.io — он вынимает вопрос из буфера', () => {
    void request('channel-stats', { id: 'ch-1' });
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it('без ответа не висит вечно — через срок приходит null', async () => {
    const p = request('channel-delete', { id: 'ch-1' });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(await p).toBeNull();
  });

  it('поздний ответ после срока ничего не ломает', async () => {
    const p = request('channel-delete', { id: 'ch-1' });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(() => reply({ ok: true })).not.toThrow();
  });

  it('свой срок — у requestWithin', async () => {
    const p = requestWithin(3000, 'channel-stats', { id: 'ch-1' });
    expect(timeout).toHaveBeenCalledWith(3000);
    vi.advanceTimersByTime(3000);
    expect(await p).toBeNull();
  });
});

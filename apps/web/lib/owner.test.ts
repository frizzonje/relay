import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerError, amIOwner, claimOwner } from './owner';

/**
 * Клиентская половина владельца. Проверять тут особенно нечего — и это ровно
 * то, что стоит закрепить: ключ уезжает на сервер как приехал, а решения
 * принимает сервер. За клиентом остаются две вещи, и обе видит человек:
 * оборванная ссылка отбивается до запроса, а каждый отказ сервера получает свою
 * причину — потому что действия у них разные (взять ссылку заново, сходить в
 * ssh, просто повторить).
 */

const TOKEN = 'x'.repeat(43);

function server(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[path] ?? { status: 404 };
      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => route.body,
      } as Response;
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('взятие власти', () => {
  it('ключ уезжает на сервер как есть', async () => {
    const { calls } = server({ '/api/identity/owner/claim': { body: { ok: true } } });
    await claimOwner(TOKEN);
    expect(calls).toEqual([{ url: '/api/identity/owner/claim', body: { token: TOKEN } }]);
  });

  it('оборванная ссылка отбивается до запроса', async () => {
    // Самый вероятный исход при копировании из терминала — и гонять сервер
    // ради того же ответа незачем.
    const { calls } = server({});
    await expect(claimOwner(TOKEN.slice(0, 40))).rejects.toMatchObject({ reason: 'bad-token' });
    expect(calls).toEqual([]);
  });

  it.each([
    [400, 'bad-token'],
    [409, 'used'],
    [410, 'expired'],
    [401, 'no-identity'],
    [500, 'network'],
  ])('%i → %s', async (status, reason) => {
    server({ '/api/identity/owner/claim': { status } });
    await expect(claimOwner(TOKEN)).rejects.toMatchObject({ reason });
  });

  it('обрыв сети — это отказ, а не молчание', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch');
      }),
    );
    const err = await claimOwner(TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerError);
    expect((err as OwnerError).reason).toBe('network');
  });
});

describe('вопрос о себе', () => {
  it('отвечает тем, что сказал сервер', async () => {
    server({ '/api/identity/owner': { body: { owner: true } } });
    expect(await amIOwner()).toBe(true);
  });

  it('без сессии и без сети — просто «нет»', async () => {
    // Значок в карточке личности не стоит ни одного экрана ошибки.
    server({ '/api/identity/owner': { status: 401 } });
    expect(await amIOwner()).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch');
      }),
    );
    expect(await amIOwner()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Клиентская половина модерации. Решений здесь нет — их принимает сервер, — и
 * проверять поэтому стоит ровно две вещи, обе про честность перед человеком:
 * охват уезжает таким, каким его выбрали, и молчание сервера не выглядит как
 * успех. У бана нет отката, а «нажал, ничего не произошло» — худший из ответов.
 */

const emit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/socket', () => ({ getSocket: () => ({ emit }) }));

import { banAuthor, listBans, unban } from './moderation';

/** Ответить на последний вызов так, как ответил бы сервер. */
function reply(res: unknown) {
  const call = emit.mock.calls.at(-1);
  (call?.[2] as (r: unknown) => void)(res);
}

beforeEach(() => {
  emit.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('бан', () => {
  it('охват по умолчанию — этот сервер, и лишнего поля в запросе нет', async () => {
    // `everywhere: false` и отсутствие поля значат для сервера одно и то же, но
    // отправлять «нет» там, где ничего не просили, — способ однажды отправить
    // «да» опечаткой.
    const promise = banAuthor('msg-1');
    expect(emit).toHaveBeenCalledWith('moderation-ban', { id: 'msg-1' }, expect.any(Function));
    reply({ ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('бан на всю инсталляцию просят явно', async () => {
    const promise = banAuthor('msg-1', true);
    expect(emit).toHaveBeenCalledWith(
      'moderation-ban',
      { id: 'msg-1', everywhere: true },
      expect.any(Function),
    );
    reply({ ok: true });
    await promise;
  });

  it('отказ доезжает целиком: причина решает, что показать', async () => {
    const promise = banAuthor('msg-1');
    reply({ ok: false, error: 'forbidden' });
    await expect(promise).resolves.toEqual({ ok: false, error: 'forbidden' });
  });

  it('молчание сервера — это отказ, а не бесконечное ожидание', async () => {
    const promise = banAuthor('msg-1');
    await vi.advanceTimersByTimeAsync(9000);
    await expect(promise).resolves.toMatchObject({ ok: false });
  });

  it('опоздавший ответ уже ничего не меняет', async () => {
    // Иначе диалог, закрывшийся по тайм-ауту, ожил бы через минуту.
    const promise = banAuthor('msg-1');
    await vi.advanceTimersByTimeAsync(9000);
    reply({ ok: true });
    await expect(promise).resolves.toMatchObject({ ok: false });
  });
});

describe('разбан', () => {
  it('ручка — отпечаток, охват — сервер', async () => {
    const promise = unban('a1b2-c3d4-e5f6-7890', 'srv');
    expect(emit).toHaveBeenCalledWith(
      'moderation-unban',
      { fingerprint: 'a1b2-c3d4-e5f6-7890', server: 'srv' },
      expect.any(Function),
    );
    reply({ ok: true });
    await promise;
  });

  it('без сервера — охват всей инсталляции', async () => {
    const promise = unban('a1b2-c3d4-e5f6-7890');
    expect(emit).toHaveBeenCalledWith(
      'moderation-unban',
      { fingerprint: 'a1b2-c3d4-e5f6-7890' },
      expect.any(Function),
    );
    reply({ ok: true });
    await promise;
  });
});

describe('список забаненных', () => {
  it('отдаёт то, что прислал сервер', async () => {
    const bans = [{ fingerprint: 'a1b2-c3d4-e5f6-7890', nick: 'Аня', at: '2026-08-14', by: null }];
    const promise = listBans('srv');
    reply({ ok: true, bans });
    await expect(promise).resolves.toEqual(bans);
  });

  it('отказ и молчание выглядят одинаково: пустой список', async () => {
    // Показывать «ошибка» там, где сервер ответил «не твоё», незачем: список и
    // не должен был открыться, кнопку рисует тот же флаг прав.
    const refused = listBans('srv');
    reply({ ok: false, error: 'forbidden' });
    await expect(refused).resolves.toEqual([]);

    const silent = listBans('srv');
    await vi.advanceTimersByTimeAsync(9000);
    await expect(silent).resolves.toEqual([]);
  });
});

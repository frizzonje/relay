import { afterEach, describe, expect, it, vi } from 'vitest';
import { certificateMessage } from '@relay/shared';
import { DeviceError, admitDevice, askPairing, listDevices, revokeDevice } from './devices';
import type { Signer } from './signer';

/**
 * Клиентская половина устройств. Проверяется не «ходит ли fetch», а два
 * обещания, которые человек иначе не проверит ничем:
 *
 *   - впуская устройство, мы подписываем ИМЕННО тот ключ, который человеку
 *     показали, и именно свою личность — иначе сверка отпечатка глазами теряет
 *     смысл, а подпись годилась бы для чужой связки;
 *   - у каждого отказа своя причина, потому что действия у них разные: подождать
 *     сеть, ввести другой код, взять другое устройство.
 */

const KEY = 'A'.repeat(43);
const SIG = 'B'.repeat(86);

/** Сервер по сценарию: путь → ответ. Возвращает журнал запросов. */
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

/** Подписыватель, который помнит, что его просили подписать. */
function witness() {
  const signed: string[] = [];
  const signer: Signer = {
    publicKey: KEY,
    sign: async (message: string) => {
      signed.push(message);
      return SIG;
    },
  };
  return { signer, signed };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('список и отзыв', () => {
  it('список приходит списком, а не обёрткой', async () => {
    server({ '/api/identity/devices': { body: { devices: [{ id: 'd-1', name: 'Chrome' }] } } });
    expect(await listDevices()).toHaveLength(1);
  });

  it('«это устройство» и «такого нет» — разные беды', async () => {
    // Первую человеку объясняют, вторая означает, что список у него устарел.
    server({ '/api/identity/devices/revoke': { status: 409, body: { error: 'current' } } });
    await expect(revokeDevice('d-1')).rejects.toMatchObject({ reason: 'current' });

    server({ '/api/identity/devices/revoke': { status: 404, body: { error: 'unknown' } } });
    await expect(revokeDevice('d-1')).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('незнакомый отказ не выдаётся за знакомый', async () => {
    // Врать точной причиной, которой мы не знаем, хуже, чем предложить повтор.
    server({ '/api/identity/devices': { status: 500, body: { error: 'boom' } } });
    await expect(listDevices()).rejects.toMatchObject({ reason: 'network' });
  });

  it('оборванная сеть — это сеть, а не отказ сервера', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed to fetch');
      }),
    );
    await expect(listDevices()).rejects.toBeInstanceOf(DeviceError);
    await expect(listDevices()).rejects.toMatchObject({ reason: 'network' });
  });
});

describe('просьба о связке', () => {
  it('срок приходит длительностью — часы у сторон разные', async () => {
    server({ '/api/identity/pair/ask': { body: { code: '428913', expiresIn: 180000 } } });
    expect(await askPairing()).toEqual({ code: '428913', expiresIn: 180000 });
  });

  it('пожившая личность узнаёт об этом сразу, а не после подтверждения', async () => {
    server({ '/api/identity/pair/ask': { status: 400, body: { error: 'has-history' } } });
    await expect(askPairing()).rejects.toMatchObject({ reason: 'has-history' });
  });
});

describe('впуск устройства', () => {
  it('подписывается тот самый ключ и та самая личность', async () => {
    // Между «человек посмотрел на отпечаток» и «устройство вошло» не должно
    // оказаться двух разных ключей.
    const { signer, signed } = witness();
    const { calls } = server({ '/api/identity/pair/confirm': { body: { ok: true } } });

    await admitDevice('428913', 'i-1', KEY, signer);

    expect(signed).toEqual([certificateMessage('i-1', KEY)]);
    expect(calls[0].body).toMatchObject({ code: '428913', signature: SIG });
  });

  it('не подписывает то, что ключом не является', async () => {
    // Сервер такое отвергнет и сам, но подписывать мусор своим ключом незачем.
    const { signer, signed } = witness();
    server({ '/api/identity/pair/confirm': { body: { ok: true } } });

    await expect(admitDevice('428913', 'i-1', 'не-ключ', signer)).rejects.toMatchObject({
      reason: 'bad-signature',
    });
    expect(signed).toEqual([]);
  });

  it('беда с ключом отличима от беды со связкой', async () => {
    // «Подписать не вышло» чинится не другим кодом, а разбирательством с ключом.
    server({ '/api/identity/pair/confirm': { body: { ok: true } } });
    const broken: Signer = {
      publicKey: KEY,
      sign: async () => {
        throw new Error('ключ не ответил');
      },
    };
    await expect(admitDevice('428913', 'i-1', KEY, broken)).rejects.toMatchObject({
      reason: 'signer',
    });
  });

  it('перебор кодов отличим от неверного кода', async () => {
    const { signer } = witness();
    server({ '/api/identity/pair/confirm': { status: 429, body: { error: 'too-many' } } });
    await expect(admitDevice('428913', 'i-1', KEY, signer)).rejects.toMatchObject({
      reason: 'too-many',
    });

    server({ '/api/identity/pair/confirm': { status: 400, body: { error: 'bad-code' } } });
    await expect(admitDevice('428913', 'i-1', KEY, signer)).rejects.toMatchObject({
      reason: 'bad-code',
    });
  });
});

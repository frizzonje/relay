import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMessage } from '@relay/shared';
import {
  LoginError,
  describeDevice,
  proveIdentity,
  renameIdentity,
  whoAmI,
} from './identity-login';
import { SignerError, type Signer } from './signer';

/**
 * Клиентская половина входа. Проверяется не «ходит ли fetch», а то, что этот
 * код различает четыре разных беды, которые для человека означают четыре
 * разных действия: чинить ключ, войти заново паролем, связать устройство
 * заново или просто подождать сеть. Свалить их в одно «не удалось» — значит
 * оставить человека без единственной подсказки, которая у него есть.
 */

const signer: Signer = {
  publicKey: 'A'.repeat(43),
  sign: async (message: string) => `подпись(${message})`,
};

/** Сервер, отвечающий по сценарию. Возвращает и журнал того, что спросили. */
function server(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[path] ?? { status: 404 };
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OK = {
  '/api/identity/challenge': { body: { nonce: 'нонс-1' } },
  '/api/identity/verify': {
    body: {
      id: 'i-1',
      publicKey: signer.publicKey,
      fingerprint: '6668-7aad-f862-bd77',
      nick: 'Аня',
      device: { id: 'd-1', name: 'Chrome · macOS' },
      created: true,
    },
  },
};

describe('вход', () => {
  it('берёт нонс на свой ключ и подписывает именно его', async () => {
    const { calls } = server(OK);
    const identity = await proveIdentity({ nick: 'Аня', signer });

    expect(identity.nick).toBe('Аня');
    expect(calls[0]).toEqual({
      url: '/api/identity/challenge',
      body: { publicKey: signer.publicKey },
    });
    // Подписывается сообщение с назначением, а не голый нонс.
    expect(calls[1].body).toMatchObject({
      publicKey: signer.publicKey,
      nonce: 'нонс-1',
      signature: `подпись(${authMessage('нонс-1')})`,
      nick: 'Аня',
    });
  });

  it('называет устройство, чтобы человек узнал его в списке', async () => {
    const { calls } = server(OK);
    await proveIdentity({ signer });
    expect(calls[1].body).toHaveProperty('deviceName');
  });
});

describe('четыре разные беды', () => {
  it('ключа нет — это про ключ, а не про сеть', async () => {
    // Без своего подписывателя код идёт в штатный getSigner, а в node нет ни
    // window, ни IndexedDB — то же самое, что видит человек в приватном режиме.
    server(OK);
    const err = await proveIdentity().catch((e) => e);

    expect(err).toBeInstanceOf(LoginError);
    expect(err.failure.kind).toBe('signer');
    expect(err.failure.error).toBeInstanceOf(SignerError);
    expect(err.failure.error.reason).toBe('no-storage');
  });

  it('пропуск на инсталляцию протух — это на /login', async () => {
    // Гейт отвечает своим телом, без нашего `error: bad-*`.
    server({ '/api/identity/challenge': { status: 401, body: { error: 'unauthorized' } } });
    const err = await proveIdentity({ signer }).catch((e) => e);
    expect(err.failure).toEqual({ kind: 'gate' });
  });

  it('устройство отозвано — это связка заново, а не пароль', async () => {
    server({
      '/api/identity/challenge': OK['/api/identity/challenge'],
      '/api/identity/verify': { status: 403, body: { error: 'revoked' } },
    });
    const err = await proveIdentity({ signer }).catch((e) => e);
    expect(err.failure).toEqual({ kind: 'revoked' });
  });

  it('подпись не сошлась — это не «войдите заново»', async () => {
    // Иначе человека отправили бы вводить пароль, который тут ни при чём.
    server({
      '/api/identity/challenge': OK['/api/identity/challenge'],
      '/api/identity/verify': { status: 401, body: { error: 'bad-signature' } },
    });
    const err = await proveIdentity({ signer }).catch((e) => e);
    expect(err.failure).toEqual({ kind: 'network', status: 401 });
  });

  it('сервер лёг — это подождать', async () => {
    server({ '/api/identity/challenge': { status: 502 } });
    const err = await proveIdentity({ signer }).catch((e) => e);
    expect(err.failure).toEqual({ kind: 'network', status: 502 });
  });
});

describe('кто я', () => {
  it('нет сессии — это не ошибка, а обычное начало', async () => {
    // Так выглядит и первый заход, и любой заход после рестарта api.
    server({ '/api/identity/me': { status: 401, body: { error: 'no session' } } });
    expect(await whoAmI()).toBeNull();
  });

  it('есть сессия — узнаёт без единой подписи', async () => {
    server({ '/api/identity/me': { body: { nick: 'Аня', fingerprint: '6668' } } });
    expect((await whoAmI())?.nick).toBe('Аня');
  });

  it('отозванное устройство отличимо от отсутствия сессии', async () => {
    server({ '/api/identity/me': { status: 403, body: { error: 'revoked' } } });
    await expect(whoAmI()).rejects.toMatchObject({ failure: { kind: 'revoked' } });
  });
});

describe('смена ника', () => {
  it('возвращает то, что сервер вычистил', async () => {
    // Не то, что ввёл человек: чистит сервер, и показать надо результат.
    server({ '/api/identity/nick': { body: { nick: 'Аня-Б' } } });
    expect(await renameIdentity(' @Аня Б ')).toBe('Аня-Б');
  });

  it('отказ не выдаётся за успех', async () => {
    server({ '/api/identity/nick': { status: 400, body: { error: 'bad nick' } } });
    await expect(renameIdentity('@@@')).rejects.toBeInstanceOf(LoginError);
  });
});

describe('имя устройства', () => {
  it('без navigator не падает', () => {
    expect(describeDevice()).toBe('device');
  });

  it('читается человеком и не переводится', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36',
    });
    expect(describeDevice()).toBe('Chrome · macOS');
  });

  it('незнакомый движок — не пустая строка', () => {
    vi.stubGlobal('navigator', { userAgent: 'нечто/1.0' });
    expect(describeDevice()).toBe('browser');
  });
});

import { Logger } from '@nestjs/common';
import { webcrypto } from 'node:crypto';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { DeviceRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { SIGN_ALGORITHM, authMessage } from './crypto';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IDENTITY_COOKIE } from './session';

/**
 * Здесь проверяется не криптография (она в `crypto.test`) и не правила входа
 * (они в `identity.service.test`), а то, что видит браузер: коды ответов, кука
 * личности и — главное — что она пропадает, когда личности за ней больше нет.
 * Кука, пережившая отзыв устройства, и есть отсутствующий отзыв.
 */

interface FakeRes {
  code: number;
  body: unknown;
  cookies: Record<string, { value: string; opts: Record<string, unknown> }>;
  cleared: string[];
}

function res(): Response & FakeRes {
  const r = {
    code: 200,
    body: undefined as unknown,
    cookies: {} as FakeRes['cookies'],
    cleared: [] as string[],
    status(code: number) {
      r.code = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      r.cookies[name] = { value, opts };
      return r;
    },
    clearCookie(name: string) {
      r.cleared.push(name);
      return r;
    },
  };
  return r as unknown as Response & FakeRes;
}

const req = (cookie?: string, secure = true) =>
  ({ headers: cookie ? { cookie } : {}, secure }) as unknown as Request;

let db: DataSource;
let controller: IdentityController;
let service: IdentityService;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  service = new IdentityService(db);
  controller = new IdentityController(service);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function device() {
  const keys = (await webcrypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', keys.publicKey);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: async (message: string) =>
      Buffer.from(
        await webcrypto.subtle.sign(
          { name: SIGN_ALGORITHM },
          keys.privateKey,
          new TextEncoder().encode(message),
        ),
      ).toString('base64url'),
  };
}

/** Пройти вход целиком и вернуть куку, как её вернул бы браузер. */
async function signIn(d: Awaited<ReturnType<typeof device>>, nick = 'Аня') {
  const challengeRes = res();
  controller.challenge(challengeRes, { publicKey: d.publicKey });
  const { nonce } = challengeRes.body as { nonce: string };

  const verifyRes = res();
  await controller.verify(req(), verifyRes, {
    publicKey: d.publicKey,
    nonce,
    signature: await d.sign(authMessage(nonce)),
    nick,
  });
  return {
    res: verifyRes,
    cookie: `${IDENTITY_COOKIE}=${verifyRes.cookies[IDENTITY_COOKIE]?.value}`,
  };
}

describe('вход', () => {
  it('челлендж → подпись → кука и своя карточка', async () => {
    const d = await device();
    const { res: out } = await signIn(d);

    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ nick: 'Аня', publicKey: d.publicKey, created: true });
    expect(out.body).toHaveProperty('fingerprint');

    const cookie = out.cookies[IDENTITY_COOKIE];
    expect(cookie.value).toBeTruthy();
    // Скриптам она не нужна никогда: её читает только сервер.
    expect(cookie.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('под http кука не помечается secure — иначе браузер её выбросит', async () => {
    // Инсталляция за собственным прокси без TLS — законный случай.
    const d = await device();
    const challengeRes = res();
    controller.challenge(challengeRes, { publicKey: d.publicKey });
    const { nonce } = challengeRes.body as { nonce: string };
    const out = res();
    await controller.verify(req(undefined, false), out, {
      publicKey: d.publicKey,
      nonce,
      signature: await d.sign(authMessage(nonce)),
    });
    expect(out.cookies[IDENTITY_COOKIE].opts.secure).toBe(false);
  });

  it('челлендж на не-ключ — 400, а не нонс в пустоту', () => {
    const out = res();
    controller.challenge(out, { publicKey: 'не-ключ' });
    expect(out.code).toBe(400);
  });

  it('подпись не сошлась — 401 и никакой куки', async () => {
    const d = await device();
    const challengeRes = res();
    controller.challenge(challengeRes, { publicKey: d.publicKey });
    const { nonce } = challengeRes.body as { nonce: string };

    const out = res();
    await controller.verify(req(), out, {
      publicKey: d.publicKey,
      nonce,
      signature: Buffer.alloc(64).toString('base64url'),
    });
    expect(out.code).toBe(401);
    expect(out.cookies[IDENTITY_COOKIE]).toBeUndefined();
  });

  it('отозванному устройству — 403, а не 401', async () => {
    // Разница не косметическая: 401 человек чинит паролем и сетью, 403 —
    // связкой устройства заново. Второе и есть настоящий выход.
    const d = await device();
    await signIn(d);
    await db.getRepository(DeviceRow).update({ publicKey: d.publicKey }, { revokedAt: new Date() });

    const challengeRes = res();
    controller.challenge(challengeRes, { publicKey: d.publicKey });
    const { nonce } = challengeRes.body as { nonce: string };
    const out = res();
    await controller.verify(req(), out, {
      publicKey: d.publicKey,
      nonce,
      signature: await d.sign(authMessage(nonce)),
    });
    expect(out.code).toBe(403);
    expect(out.body).toEqual({ error: 'revoked' });
  });
});

describe('кто я', () => {
  it('по куке — без единой подписи', async () => {
    const { cookie } = await signIn(await device());
    const out = res();
    await controller.me(req(cookie), out);
    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ nick: 'Аня' });
  });

  it('без куки — 401', async () => {
    const out = res();
    await controller.me(req(), out);
    expect(out.code).toBe(401);
  });

  it('кука есть, а личности нет — куку долой', async () => {
    // Иначе клиент будет предъявлять её до самого истечения срока, получая
    // 401 на каждый запрос и не понимая, что чинить.
    const d = await device();
    const { cookie, res: signed } = await signIn(d);
    const { id } = signed.body as { id: string };
    await db.query('DELETE FROM identities WHERE id = $1', [id]);

    const out = res();
    await controller.me(req(cookie), out);
    expect(out.code).toBe(401);
    expect(out.cleared).toContain(IDENTITY_COOKIE);
  });

  it('устройство отозвали посреди сессии — 403 и кука долой', async () => {
    const d = await device();
    const { cookie } = await signIn(d);
    await db.getRepository(DeviceRow).update({ publicKey: d.publicKey }, { revokedAt: new Date() });

    const out = res();
    await controller.me(req(cookie), out);
    expect(out.code).toBe(403);
    expect(out.cleared).toContain(IDENTITY_COOKIE);
  });

  it('подделанная кука — 401', async () => {
    const { cookie } = await signIn(await device());
    const out = res();
    await controller.me(req(cookie.slice(0, -1) + 'x'), out);
    expect(out.code).toBe(401);
  });
});

describe('смена ника', () => {
  it('меняется по куке', async () => {
    const { cookie } = await signIn(await device());
    const out = res();
    await controller.nick(req(cookie), out, { nick: 'Аня Б' });
    expect(out.body).toEqual({ nick: 'Аня-Б' });

    const after = res();
    await controller.me(req(cookie), after);
    expect(after.body).toMatchObject({ nick: 'Аня-Б' });
  });

  it('без куки не меняется: ник — свойство личности, а не запроса', async () => {
    const out = res();
    await controller.nick(req(), out, { nick: 'кто-то' });
    expect(out.code).toBe(401);
  });

  it('пустой ник — 400', async () => {
    const { cookie } = await signIn(await device());
    const out = res();
    await controller.nick(req(cookie), out, { nick: '   ' });
    expect(out.code).toBe(400);
  });
});

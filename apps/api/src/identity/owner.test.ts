import { Logger } from '@nestjs/common';
import { webcrypto } from 'node:crypto';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { OwnerClaimRow, RoleRow } from '../db/entities';
import type { SignalingGateway } from '../gateway/signaling.gateway';
import { resetDatabase, testDatabase } from '../db/testing';
import { SIGN_ALGORITHM, authMessage, hashOwnerToken, isOwnerToken } from './crypto';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { OwnerController } from './owner.controller';
import { CLAIM_TTL_MS, OwnerService } from './owner.service';
import { RolesService } from './roles.service';
import { IDENTITY_COOKIE } from './session';

/**
 * Владелец инсталляции — с настоящей базой.
 *
 * Проверяется то, ради чего вся эта механика существует: власть берётся
 * снаружи приложения, ровно один раз на ссылку, и её всегда можно вернуть с той
 * машины, где стоит relay. Отдельно — что перевыпуск действительно убивает
 * прежнюю ссылку: иначе «перевыпустил, потому что старая могла утечь» было бы
 * самообманом.
 */

interface FakeRes {
  code: number;
  body: unknown;
  cookies: Record<string, { value: string; opts: Record<string, unknown> }>;
}

function res(): Response & FakeRes {
  const r = {
    code: 200,
    body: undefined as unknown,
    cookies: {} as FakeRes['cookies'],
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
    clearCookie() {
      return r;
    },
  };
  return r as unknown as Response & FakeRes;
}

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

let db: DataSource;
let identity: IdentityService;
let owner: OwnerService;
let login: IdentityController;
let controller: OwnerController;
let clock: number;
/**
 * Гейтвей здесь ненастоящий, и это ровно та его часть, которая нужна: после
 * взятия власти права живых сокетов обязаны пересобраться, а не дождаться
 * переподключения. Считаем вызовы — сам пересбор проверяется в тестах гейтвея.
 */
let synced: number;
const gateway = {
  syncOwner: async () => {
    synced += 1;
  },
} as unknown as SignalingGateway;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  clock = Date.parse('2026-08-14T09:00:00Z');
  identity = new IdentityService(db);
  owner = new OwnerService(db, () => clock);
  login = new IdentityController(identity);
  controller = new OwnerController(identity, owner, gateway);
  synced = 0;
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Человек с настоящим ключом и настоящей сессией. */
async function person(nick: string) {
  const keys = (await webcrypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', keys.publicKey);
  const publicKey = Buffer.from(raw).toString('base64url');

  const asked = res();
  login.challenge(asked, { publicKey });
  const { nonce } = asked.body as { nonce: string };
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: SIGN_ALGORITHM },
      keys.privateKey,
      new TextEncoder().encode(authMessage(nonce)),
    ),
  ).toString('base64url');

  const out = res();
  await login.verify(req(), out, { publicKey, nonce, signature, nick });
  const body = out.body as { id: string };
  return {
    nick,
    identityId: body.id,
    cookie: `${IDENTITY_COOKIE}=${out.cookies[IDENTITY_COOKIE]?.value}`,
  };
}

type Person = Awaited<ReturnType<typeof person>>;

/** Открыть ссылку: то же, что делает браузер, поймав `#owner=…`. */
async function open(who: Person, token: string): Promise<Response & FakeRes> {
  const out = res();
  await controller.claim(req(who.cookie), out, { token });
  return out;
}

async function amIOwner(who: Person): Promise<boolean> {
  const out = res();
  await controller.mine(req(who.cookie), out);
  return (out.body as { owner: boolean }).owner;
}

describe('приглашение', () => {
  it('ключ выдаётся в читаемом виде один раз, в базе лежит только его хэш', async () => {
    const { token } = await owner.issue();
    expect(isOwnerToken(token)).toBe(true);

    const rows = await db.getRepository(OwnerClaimRow).find();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashOwnerToken(token));
    // Главное: самого ключа в строке нет ни в каком виде.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('живёт сутки', async () => {
    const { expiresAt } = await owner.issue();
    expect(expiresAt.getTime() - clock).toBe(CLAIM_TTL_MS);
  });

  it('каждый выпуск даёт новый ключ', async () => {
    const first = await owner.issue();
    const second = await owner.issue();
    expect(second.token).not.toBe(first.token);
  });
});

describe('взятие власти', () => {
  it('открывший ссылку становится владельцем', async () => {
    const anya = await person('Аня');
    expect(await amIOwner(anya)).toBe(false);

    const { token } = await owner.issue();
    const out = await open(anya, token);

    expect(out.code).toBe(200);
    expect(await amIOwner(anya)).toBe(true);
  });

  it('роль записана на всю инсталляцию, а не на сервер', async () => {
    const anya = await person('Аня');
    await open(anya, (await owner.issue()).token);

    const roles = await db.getRepository(RoleRow).find();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ identityId: anya.identityId, serverId: null, role: 'owner' });
  });

  it('права живых сокетов пересобираются, и только когда власть сменилась', async () => {
    // Иначе бывший владелец продолжал бы удалять чужое до переподключения, а
    // новый не увидел бы своих прав, пока не перезагрузит страницу.
    const anya = await person('Аня');
    await open(anya, (await owner.issue()).token);
    expect(synced).toBe(1);

    await open(anya, 'x'.repeat(43));
    expect(synced).toBe(1);
  });

  it('ссылка одноразовая: второй открывший получает отказ', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    const { token } = await owner.issue();

    expect((await open(anya, token)).code).toBe(200);

    const second = await open(boris, token);
    expect(second.code).toBe(409);
    expect(second.body).toEqual({ error: 'used' });
    expect(await amIOwner(boris)).toBe(false);
    expect(await amIOwner(anya)).toBe(true);
  });

  it('в приглашении остаётся след: кто и когда взял власть', async () => {
    const anya = await person('Аня');
    await open(anya, (await owner.issue()).token);

    const [row] = await db.getRepository(OwnerClaimRow).find();
    expect(row.usedBy).toBe(anya.identityId);
    expect(row.usedAt?.getTime()).toBe(clock);
  });

  it('через сутки ссылка мертва', async () => {
    const anya = await person('Аня');
    const { token } = await owner.issue();
    clock += CLAIM_TTL_MS + 1;

    const out = await open(anya, token);
    expect(out.code).toBe(410);
    expect(out.body).toEqual({ error: 'expired' });
    expect(await amIOwner(anya)).toBe(false);
  });

  it('перевыпуск убивает прежнюю ссылку', async () => {
    // Иначе «выпустил новую, потому что старая могла утечь» не значило бы
    // ничего: утекшая продолжала бы работать сутки.
    const anya = await person('Аня');
    const old = (await owner.issue()).token;
    const fresh = (await owner.issue()).token;

    const stale = await open(anya, old);
    expect(stale.code).toBe(410);
    expect(await amIOwner(anya)).toBe(false);

    expect((await open(anya, fresh)).code).toBe(200);
    expect(await amIOwner(anya)).toBe(true);
  });

  it('выдуманный ключ не годится', async () => {
    const anya = await person('Аня');
    await owner.issue();

    const out = await open(anya, 'a'.repeat(43));
    expect(out.code).toBe(400);
    expect(out.body).toEqual({ error: 'bad-token' });
    expect(await amIOwner(anya)).toBe(false);
  });

  it('мусор вместо ключа — тот же отказ, без запроса в базу', async () => {
    const anya = await person('Аня');
    const out = res();
    await controller.claim(req(anya.cookie), out, { token: { evil: true } });
    expect(out.code).toBe(400);
    expect(out.body).toEqual({ error: 'bad-token' });
  });

  it('без сессии власть не берут', async () => {
    const { token } = await owner.issue();
    const out = res();
    await controller.claim(req(), out, { token });

    expect(out.code).toBe(401);
    // Ссылка при этом цела: сгореть от чужого захода мимо личности она не может.
    const anya = await person('Аня');
    expect((await open(anya, token)).code).toBe(200);
  });
});

describe('возвращение власти', () => {
  it('забаненный, открывший ссылку, становится владельцем и перестаёт быть забаненным', async () => {
    // Ссылка печатается на машине, и она сильнее любого бана: иначе уходящий
    // владелец забанил бы всех и запер инсталляцию, а отпереть её было бы нечем.
    const anya = await person('Аня');
    const boris = await person('Борис');
    await open(boris, (await owner.issue()).token);
    await new RolesService(db).ban(anya.identityId, null, boris.identityId);

    expect((await open(anya, (await owner.issue()).token)).code).toBe(200);
    expect(await amIOwner(anya)).toBe(true);
    expect(await new RolesService(db).rightsOf(anya.identityId)).toEqual({
      banned: false,
      bannedFrom: new Set(),
    });
  });

  it('новая ссылка отбирает роль у прежнего владельца', async () => {
    // Это единственный путь восстановления: ключ потерян, человек ушёл — власть
    // возвращается с той машины, где стоит relay.
    const anya = await person('Аня');
    const boris = await person('Борис');

    await open(anya, (await owner.issue()).token);
    expect(await amIOwner(anya)).toBe(true);

    await open(boris, (await owner.issue()).token);

    expect(await amIOwner(boris)).toBe(true);
    expect(await amIOwner(anya)).toBe(false);
    // Владелец у инсталляции ровно один — это факт базы, а не соглашение.
    expect(await db.getRepository(RoleRow).countBy({ role: 'owner' })).toBe(1);
  });

  it('прежний владелец остаётся собой: теряется роль, а не личность', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    await open(anya, (await owner.issue()).token);
    await open(boris, (await owner.issue()).token);

    const out = res();
    await login.me(req(anya.cookie), out);
    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ nick: 'Аня' });
  });

  it('тот же человек может взять власть обратно', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    await open(anya, (await owner.issue()).token);
    await open(boris, (await owner.issue()).token);
    await open(anya, (await owner.issue()).token);

    expect(await amIOwner(anya)).toBe(true);
    expect(await db.getRepository(RoleRow).countBy({ role: 'owner' })).toBe(1);
  });
});

describe('о себе', () => {
  it('вопрос «владелец ли я» — только про себя', async () => {
    const anya = await person('Аня');
    const boris = await person('Борис');
    await open(anya, (await owner.issue()).token);

    expect(await amIOwner(anya)).toBe(true);
    expect(await amIOwner(boris)).toBe(false);
  });

  it('без сессии не отвечает вовсе', async () => {
    const out = res();
    await controller.mine(req(), out);
    expect(out.code).toBe(401);
  });

  it('у свежей инсталляции владельца нет', async () => {
    expect(await owner.claimed()).toBe(false);
    await open(await person('Аня'), (await owner.issue()).token);
    expect(await owner.claimed()).toBe(true);
  });
});

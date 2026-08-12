import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { webcrypto } from 'node:crypto';
import { DeviceRow, IdentityRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { SIGN_ALGORITHM, authMessage, fingerprint } from './crypto';
import { IdentityService } from './identity.service';

/**
 * Вход без регистрации проверяется настоящей криптографией и настоящей базой:
 * ключи генерятся, подписи считаются, строки пишутся. Подделывать тут нечего —
 * либо подпись сходится, либо человек не тот, за кого себя выдаёт.
 *
 * Смысл этих проверок не в «работает ли Ed25519», а в обещаниях слоя 2:
 * вернуться собой, не вводя ничего; не суметь притвориться чужим ключом; не
 * войти отозванным устройством; не переиспользовать чужой челлендж.
 */

let db: DataSource;
let identity: IdentityService;
let clock: number;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  clock = Date.parse('2026-08-12T12:00:00Z');
  identity = new IdentityService(db, () => clock);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Устройство: пара ключей и умение подписать — ровно как у настоящего. */
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

/** Полный вход: попросить нонс, подписать, предъявить. */
async function login(d: Awaited<ReturnType<typeof device>>, extra: Record<string, unknown> = {}) {
  const challenge = identity.challenge(d.publicKey);
  if (!challenge) throw new Error('челлендж не выдан');
  return identity.verify({
    publicKey: d.publicKey,
    nonce: challenge.nonce,
    signature: await d.sign(authMessage(challenge.nonce)),
    ...extra,
  });
}

describe('первый вход', () => {
  it('рождает личность и её корневое устройство', async () => {
    const d = await device();
    const result = await login(d, { nick: 'Аня', deviceName: 'Chrome' });

    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) return;
    expect(result.identity.nick).toBe('Аня');
    expect(result.identity.publicKey).toBe(d.publicKey);
    expect(result.identity.fingerprint).toBe(fingerprint(d.publicKey));
    expect(result.device.name).toBe('Chrome');
    // Корень никем не подписан — он и есть начало доверия.
    expect(result.device.certificate).toBeNull();
    expect(result.device.parentDeviceId).toBeNull();

    expect(await db.getRepository(IdentityRow).count()).toBe(1);
    expect(await db.getRepository(DeviceRow).count()).toBe(1);
  });

  it('без ника личность всё равно получается — с отпечатком вместо имени', async () => {
    // Ник спрашивает первый экран, но сервер обязан пережить клиента, который
    // этого не сделал: личность без имени — пустое место в ленте.
    const d = await device();
    const result = await login(d);
    if (!result.ok) throw new Error(result.reason);
    expect(result.identity.nick).toBe(fingerprint(d.publicKey).slice(0, 4));
  });

  it('мусор в нике чистится, а не запрещается', async () => {
    const result = await login(await device(), { nick: '  @ах  ты\nну  ' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.identity.nick).toBe('ах-ты-ну');
  });
});

describe('второй вход', () => {
  it('узнаёт то же устройство и не заводит второй личности', async () => {
    const d = await device();
    const first = await login(d, { nick: 'Аня' });
    const second = await login(d, { nick: 'кто-то другой' });

    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) return;
    expect(second.identity.id).toBe(first.identity.id);
    expect(second.device.id).toBe(first.device.id);
    // Ник при входе не переписывается: имя меняют явно, а не входом.
    expect(second.identity.nick).toBe('Аня');
    expect(await db.getRepository(IdentityRow).count()).toBe(1);
  });

  it('отмечает, что устройство было на связи', async () => {
    const d = await device();
    await login(d);
    const row = await db.getRepository(DeviceRow).findOneByOrFail({ publicKey: d.publicKey });
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it('другое устройство — другая личность', async () => {
    // Пока их не связали по QR (следующая задача), это два разных человека.
    await login(await device());
    await login(await device());
    expect(await db.getRepository(IdentityRow).count()).toBe(2);
  });
});

describe('чужим ключом не войти', () => {
  it('подпись не той парой не проходит', async () => {
    const mine = await device();
    const other = await device();
    const challenge = identity.challenge(mine.publicKey)!;

    const result = await identity.verify({
      publicKey: mine.publicKey,
      nonce: challenge.nonce,
      // Подписал другой ключ — а представляемся первым.
      signature: await other.sign(authMessage(challenge.nonce)),
    });

    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await db.getRepository(IdentityRow).count()).toBe(0);
  });

  it('подпись под другим нонсом не годится', async () => {
    const d = await device();
    const first = identity.challenge(d.publicKey)!;
    const second = identity.challenge(d.publicKey)!;

    const result = await identity.verify({
      publicKey: d.publicKey,
      nonce: second.nonce,
      signature: await d.sign(authMessage(first.nonce)),
    });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('чужой челлендж своим ключом не закрыть', async () => {
    // Нонс привязан к ключу: иначе «докажи владение ключом» превращается в
    // «докажи, что кто-то чем-то владеет».
    const mine = await device();
    const other = await device();
    const theirs = identity.challenge(other.publicKey)!;

    const result = await identity.verify({
      publicKey: mine.publicKey,
      nonce: theirs.nonce,
      signature: await mine.sign(authMessage(theirs.nonce)),
    });
    expect(result).toEqual({ ok: false, reason: 'bad-nonce' });
  });
});

describe('нонс', () => {
  it('одноразовый', async () => {
    const d = await device();
    const challenge = identity.challenge(d.publicKey)!;
    const signature = await d.sign(authMessage(challenge.nonce));

    expect(
      await identity.verify({ publicKey: d.publicKey, nonce: challenge.nonce, signature }),
    ).toMatchObject({ ok: true });
    // Тот же ответ второй раз — уже не ответ, а запись из чужого лога.
    expect(
      await identity.verify({ publicKey: d.publicKey, nonce: challenge.nonce, signature }),
    ).toEqual({ ok: false, reason: 'bad-nonce' });
  });

  it('сгорает и на неудачной попытке', async () => {
    // Иначе подпись можно подбирать сколько угодно на одном и том же нонсе.
    const d = await device();
    const challenge = identity.challenge(d.publicKey)!;
    await identity.verify({
      publicKey: d.publicKey,
      nonce: challenge.nonce,
      signature: 'не-подпись',
    });
    expect(
      await identity.verify({
        publicKey: d.publicKey,
        nonce: challenge.nonce,
        signature: await d.sign(authMessage(challenge.nonce)),
      }),
    ).toEqual({ ok: false, reason: 'bad-nonce' });
  });

  it('протухает', async () => {
    const d = await device();
    const challenge = identity.challenge(d.publicKey)!;
    clock += 3 * 60 * 1000;
    expect(
      await identity.verify({
        publicKey: d.publicKey,
        nonce: challenge.nonce,
        signature: await d.sign(authMessage(challenge.nonce)),
      }),
    ).toEqual({ ok: false, reason: 'bad-nonce' });
  });

  it('не выдаётся на то, что ключом не является', () => {
    expect(identity.challenge('не-ключ')).toBeNull();
    expect(identity.challenge(undefined)).toBeNull();
    expect(identity.challenge(Buffer.alloc(31).toString('base64url'))).toBeNull();
  });
});

describe('отозванное устройство', () => {
  it('не входит и знает почему', async () => {
    const d = await device();
    const first = await login(d);
    if (!first.ok) throw new Error(first.reason);

    await db.getRepository(DeviceRow).update({ id: first.device.id }, { revokedAt: new Date() });

    expect(await login(d)).toEqual({ ok: false, reason: 'revoked' });
    // И новой личности при этом не заводится: ключ известен, он отозван.
    expect(await db.getRepository(IdentityRow).count()).toBe(1);
  });

  it('и не проходит по уже выданной сессии', async () => {
    // Отзыв обязан действовать сразу, иначе он не отзыв, а пожелание.
    const d = await device();
    const first = await login(d);
    if (!first.ok) throw new Error(first.reason);

    expect(await identity.whoIs(first.identity.id, first.device.id)).toMatchObject({ ok: true });
    await db.getRepository(DeviceRow).update({ id: first.device.id }, { revokedAt: new Date() });
    expect(await identity.whoIs(first.identity.id, first.device.id)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });
});

describe('сессия', () => {
  it('узнаёт человека без единой подписи', async () => {
    const d = await device();
    const first = await login(d, { nick: 'Аня' });
    if (!first.ok) throw new Error(first.reason);

    const again = await identity.whoIs(first.identity.id, first.device.id);
    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(again.identity.nick).toBe('Аня');
  });

  it('на удалённую личность отвечает отказом, а не падением', async () => {
    const d = await device();
    const first = await login(d);
    if (!first.ok) throw new Error(first.reason);
    await db.getRepository(IdentityRow).delete({ id: first.identity.id });

    expect(await identity.whoIs(first.identity.id, first.device.id)).toEqual({
      ok: false,
      reason: 'bad-key',
    });
  });

  it('чужой парой id не открывается', async () => {
    const a = await login(await device());
    const b = await login(await device());
    if (!a.ok || !b.ok) throw new Error('вход не прошёл');
    // Устройство b с личностью a — комбинация, которой не было.
    expect(await identity.whoIs(a.identity.id, b.device.id)).toEqual({
      ok: false,
      reason: 'bad-key',
    });
  });
});

describe('смена ника', () => {
  it('меняет и остаётся в базе', async () => {
    const first = await login(await device(), { nick: 'Аня' });
    if (!first.ok) throw new Error(first.reason);

    expect(await identity.rename(first.identity.id, ' @Аня  Б ')).toBe('Аня-Б');
    expect(
      (await db.getRepository(IdentityRow).findOneByOrFail({ id: first.identity.id })).nick,
    ).toBe('Аня-Б');
  });

  it('пустой ник — отказ: безымянных в ленте не бывает', async () => {
    const first = await login(await device(), { nick: 'Аня' });
    if (!first.ok) throw new Error(first.reason);
    expect(await identity.rename(first.identity.id, '   ')).toBeNull();
    expect(await identity.rename(first.identity.id, '@@@')).toBeNull();
  });

  it('несуществующей личности не переименовать', async () => {
    expect(await identity.rename('00000000-0000-0000-0000-000000000000', 'Аня')).toBeNull();
  });
});

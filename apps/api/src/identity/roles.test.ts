import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityRow, RoleRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { fingerprint as fingerprintOf } from './crypto';
import { OwnerService } from './owner.service';
import { RolesService } from './roles.service';

/**
 * Роли — с настоящей базой, потому что вся их суть в том, что запись переживает
 * перезапуск и действует на все устройства человека сразу.
 *
 * Принуждение (кого не пускают на порог, чей сервер пропадает из рейки) живёт в
 * гейтвее и проверяется там же: здесь — только правила, по которым строка
 * появляется и исчезает.
 */

let db: DataSource;
let roles: RolesService;
let owner: OwnerService;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  roles = new RolesService(db);
  owner = new OwnerService(db);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Личность в базе — здесь она нужна целиком: бан ссылается на живую строку. */
async function person(nick: string): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID();
  const key = randomBytes(32).toString('base64url');
  const fingerprint = fingerprintOf(key);
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: key,
    fingerprint,
    nick,
    createdAt: new Date(),
    lastSeenAt: null,
  });
  return { id, fingerprint };
}

describe('бан', () => {
  it('обычный человек живёт без единой строки в таблице ролей', async () => {
    // Роли `member` в relay нет намеренно: право быть в общем канале даёт вход
    // на инсталляцию, а не запись в реестре людей.
    const anya = await person('Аня');
    expect(await roles.rightsOf(anya.id)).toEqual({ banned: false, bannedFrom: new Set() });
    expect(await db.getRepository(RoleRow).count()).toBe(0);
  });

  it('охват записан в строке: сервер или вся инсталляция', async () => {
    const anya = await person('Аня');
    const boss = await person('Хозяин');
    await roles.ban(anya.id, 'srv', boss.id);
    expect(await roles.rightsOf(anya.id)).toEqual({ banned: false, bannedFrom: new Set(['srv']) });

    await roles.ban(anya.id, null, boss.id);
    expect(await roles.rightsOf(anya.id)).toEqual({ banned: true, bannedFrom: new Set(['srv']) });
  });

  it('повторный бан не ошибка и не переписывает след', async () => {
    // Два модератора нажали одновременно — обычная жизнь, а не сбой.
    const anya = await person('Аня');
    const first = await person('Первый');
    const second = await person('Второй');
    expect(await roles.ban(anya.id, 'srv', first.id)).toEqual({ ok: true });
    expect(await roles.ban(anya.id, 'srv', second.id)).toEqual({ ok: true });

    const rows = await db.getRepository(RoleRow).findBy({ identityId: anya.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].grantedBy).toBe(first.id);
  });

  it('себя забанить нельзя, неизвестного — тоже', async () => {
    const anya = await person('Аня');
    expect(await roles.ban(anya.id, null, anya.id)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await roles.ban(randomUUID(), null, anya.id)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('владельца инсталляции не банят ни на сервере, ни на инсталляции', async () => {
    const boss = await person('Хозяин');
    const host = await person('Хозяйка');
    await owner.claim((await owner.issue()).token, boss.id);

    expect(await roles.ban(boss.id, 'srv', host.id)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await roles.ban(boss.id, null, host.id)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('разбан снимает ровно свой охват', async () => {
    const anya = await person('Аня');
    const boss = await person('Хозяин');
    await roles.ban(anya.id, 'srv', boss.id);
    await roles.ban(anya.id, null, boss.id);

    expect(await roles.unban(anya.id, 'srv')).toBe(true);
    expect(await roles.rightsOf(anya.id)).toEqual({ banned: true, bannedFrom: new Set() });
    // Разбан того, кого не банили, — не ошибка, но и не «сделано»: модератор
    // жмёт кнопку по списку, который мог устареть.
    expect(await roles.unban(anya.id, 'srv')).toBe(false);
  });

  it('список показывает лицо, имя и того, кто забанил', async () => {
    const anya = await person('Аня');
    const boss = await person('Хозяин');
    await roles.ban(anya.id, 'srv', boss.id);

    expect(await roles.bans('srv')).toEqual([
      { fingerprint: anya.fingerprint, nick: 'Аня', at: expect.any(String), by: 'Хозяин' },
    ]);
    // Охваты не смешиваются: бан со своего сервера не показывается в списке
    // инсталляции, иначе модератор видел бы чужую работу как свою.
    expect(await roles.bans(null)).toEqual([]);
  });

  it('личность находится по отпечатку — той же ручкой, что в списке', async () => {
    const anya = await person('Аня');
    expect(await roles.byFingerprint(anya.fingerprint)).toBe(anya.id);
    expect(await roles.byFingerprint('a1b2-c3d4-e5f6-7890')).toBeNull();
    expect(await roles.byFingerprint(42)).toBeNull();
  });
});

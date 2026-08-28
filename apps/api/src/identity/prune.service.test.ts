import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceRow, IdentityRow, PrefRow, ReadRow, RoleRow, ServerRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import type { SettingsService } from '../settings/settings.service';
import { freshSettings, tune } from '../settings/settings.testkit';
import { fingerprint as fingerprintOf } from './crypto';
import { BANNED_ROLE } from './roles.service';
import { OWNER_ROLE } from './owner.service';
import { PruneService } from './prune.service';

/**
 * Уборка личностей, о которых давно ничего не слышно.
 *
 * Проверяется ровно то, что делает эту работу опасной: КОГО она не трогает.
 * Удалённая по сроку давности личность возвращается новой и чистой — то есть
 * снятый бан и инсталляция без хозяина. Поэтому здесь на каждую пощажённую
 * причину свой тест, а на само удаление — один.
 */

let db: DataSource;
let settings: SettingsService;
let prune: PruneService;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  settings = await freshSettings(db);
  prune = new PruneService(db, settings);
});

afterEach(() => {
  prune.onModuleDestroy();
  vi.restoreAllMocks();
});

/**
 * Личность в базе. `lastSeen: null` — та, что завелась и ни разу не вернулась:
 * её возраст считается по рождению, и без этого случая такие строки копились
 * бы вечно.
 */
async function person(opts: { lastSeen?: Date | null; born?: Date } = {}): Promise<string> {
  const id = randomUUID();
  const key = randomBytes(32).toString('base64url');
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: key,
    fingerprint: fingerprintOf(key),
    nick: 'кто-то',
    createdAt: opts.born ?? ago(400),
    lastSeenAt: opts.lastSeen === undefined ? ago(400) : opts.lastSeen,
  });
  await db.getRepository(DeviceRow).insert({
    id: randomUUID(),
    identityId: id,
    publicKey: `${key}-dev`,
    name: 'ноутбук',
    certificate: null,
    parentDeviceId: null,
    createdAt: ago(400),
    lastSeenAt: null,
    revokedAt: null,
  });
  return id;
}

const alive = async (id: string) => (await db.getRepository(IdentityRow).countBy({ id })) > 0;

/** Дождаться того, чего ждём: уборка после смены настройки идёт своим ходом. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`не дождались: ${what}`);
}

describe('умолчание', () => {
  it('ноль — не чистим вовсе: сегодня уборки личностей нет', async () => {
    // Единственный честный вариант умолчания: до настройки личности не
    // удалялись ни по какому сроку, и «почти не удалялись» тут не годится.
    expect(prune.days()).toBe(0);
    const ancient = await person();
    expect(await prune.sweep()).toBe(0);
    expect(await alive(ancient)).toBe(true);
  });

  it('старт с умолчанием не заводит уборку', async () => {
    const ancient = await person();
    prune.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await alive(ancient)).toBe(true);
  });
});

describe('уборка по сроку', () => {
  it('сносит бездействующую личность вместе с её устройствами и личным', async () => {
    const gone = await person({ lastSeen: ago(90) });
    await db.getRepository(ReadRow).insert({
      identityId: gone,
      channelId: 'obshchii',
      readAt: ago(90),
    });
    await db.getRepository(PrefRow).insert({
      identityId: gone,
      key: 'channel-mute',
      value: ['obshchii'],
      updatedAt: ago(90),
    });
    const staying = await person({ lastSeen: ago(3) });

    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(1);

    expect(await alive(gone)).toBe(false);
    // Личное чистится явно: у отметок чтения и настроек внешнего ключа нет, и
    // каскад до них не дотянется — остались бы строки, которых никто не
    // прочитает.
    expect(await db.getRepository(ReadRow).countBy({ identityId: gone })).toBe(0);
    expect(await db.getRepository(PrefRow).countBy({ identityId: gone })).toBe(0);
    expect(await db.getRepository(DeviceRow).countBy({ identityId: gone })).toBe(0);

    expect(await alive(staying)).toBe(true);
    expect(await db.getRepository(DeviceRow).countBy({ identityId: staying })).toBe(1);
  });

  it('никогда не входившая личность считается по рождению', async () => {
    // `last_seen_at` там `null`, а `null` в сравнении с интервалом даёт `null`,
    // то есть «не подходит»: без COALESCE такие строки копились бы вечно.
    const old = await person({ lastSeen: null, born: ago(90) });
    const fresh = await person({ lastSeen: null, born: ago(1) });

    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(1);
    expect(await alive(old)).toBe(false);
    expect(await alive(fresh)).toBe(true);
  });

  it('на пустой выборке не открывает транзакцию впустую', async () => {
    await person({ lastSeen: ago(1) });
    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(0);
  });
});

describe('кого уборка не трогает', () => {
  /** Роль на личности — та самая, что делает её неприкасаемой. */
  async function role(identityId: string, name: string, serverId: string | null = null) {
    await db.getRepository(RoleRow).insert({
      id: randomUUID(),
      identityId,
      serverId,
      role: name,
      grantedBy: null,
      createdAt: ago(400),
    });
  }

  it('владельца инсталляции — иначе она осталась бы без хозяина', async () => {
    // Ссылка владельца уже использована и второй раз не сработает.
    const boss = await person();
    await role(boss, OWNER_ROLE);
    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(0);
    expect(await alive(boss)).toBe(true);
  });

  it('забаненного — иначе уборка снимала бы баны по сроку давности', async () => {
    // Ключ у человека остался: войдя заново, он получил бы НОВЫЙ id и оказался
    // бы чистым. Это худший род тишины из возможных.
    const outcast = await person();
    await role(outcast, BANNED_ROLE, 'srv');
    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(0);
    expect(await alive(outcast)).toBe(true);
  });

  it('создателя сервера — сервер переживает его, но не должен менять хозяина', async () => {
    const creator = await person();
    await db.getRepository(ServerRow).insert({
      id: 'srv',
      name: 'мой',
      emoji: null,
      removable: true,
      passwordHash: null,
      creatorId: null,
      creatorIdentityId: creator,
      position: 1,
    });
    await tune(settings, 'people.pruneInactiveDays', 30);
    expect(await prune.sweep()).toBe(0);
    expect(await alive(creator)).toBe(true);
  });
});

describe('расписание', () => {
  it('смена настройки пересобирает его без перезапуска', async () => {
    // Настройка, которая начинает действовать только после обновления образа,
    // — не настройка: включив уборку, человек ждёт её сейчас.
    const ancient = await person();
    prune.onModuleInit();
    expect(await alive(ancient)).toBe(true);

    await tune(settings, 'people.pruneInactiveDays', 30);
    await until(async () => !(await alive(ancient)), 'уборка после включения настройки');
  });

  it('выключение останавливает уборку тем же путём', async () => {
    await tune(settings, 'people.pruneInactiveDays', 30);
    prune.onModuleInit();
    await tune(settings, 'people.pruneInactiveDays', 0);

    const ancient = await person();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await alive(ancient)).toBe(true);
    expect(await prune.sweep()).toBe(0);
  });

  it('отписка при остановке модуля: погашенный сервис больше не будят', async () => {
    prune.onModuleInit();
    prune.onModuleDestroy();
    const ancient = await person();

    await tune(settings, 'people.pruneInactiveDays', 30);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await alive(ancient)).toBe(true);
  });
});

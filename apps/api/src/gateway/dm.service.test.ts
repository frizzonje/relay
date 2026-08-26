import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { IdentityRow, MessageRow, RoleRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { DmService } from './dm.service';

let db: DataSource;
let dm: DmService;

/** Личность в базе: ЛС адресуются отпечатком, поэтому он и возвращается. */
async function person(nick: string): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID();
  const fingerprint = `fp-${id.slice(0, 8)}`;
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: `key-${id}`,
    fingerprint,
    nick,
    createdAt: new Date(),
    lastSeenAt: new Date(),
  });
  return { id, fingerprint };
}

beforeEach(async () => {
  db = await testDatabase();
  await resetDatabase(db);
  dm = new DmService(db);
  await dm.onModuleInit();
});

describe('адрес беседы', () => {
  it('одинаков с обеих сторон', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(DmService.address(a, b)).toBe(DmService.address(b, a));
  });

  it('начинается с dm- и не содержит id личностей', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    const address = DmService.address(a, b);
    expect(address.startsWith('dm-')).toBe(true);
    expect(address).not.toContain('1111');
  });
});

describe('открытие', () => {
  it('заводит канал и беседу, второй раз возвращает ту же', async () => {
    const me = await person('я');
    const you = await person('ты');

    const first = await dm.open(me.id, you.fingerprint);
    expect(first.ok).toBe(true);
    const slug = first.ok ? first.view.slug : '';

    // Открыл он — та же самая переписка, а не вторая.
    const second = await dm.open(you.id, me.fingerprint);
    expect(second.ok && second.view.slug).toBe(slug);
    expect(await db.query('SELECT count(*)::int AS n FROM conversations')).toEqual([{ n: 1 }]);
  });

  it('называет собеседника по его отпечатку и нику', async () => {
    const me = await person('я');
    const you = await person('ты');
    const res = await dm.open(me.id, you.fingerprint);
    expect(res.ok && res.view.peer).toEqual({ fingerprint: you.fingerprint, nick: 'ты' });
  });

  it('отказывает на незнакомом отпечатке', async () => {
    const me = await person('я');
    const res = await dm.open(me.id, 'fp-никого');
    expect(res).toEqual({ ok: false, reason: 'unknown' });
  });

  it('не даёт открыть переписку с самим собой', async () => {
    const me = await person('я');
    const res = await dm.open(me.id, me.fingerprint);
    expect(res).toEqual({ ok: false, reason: 'self' });
  });
});

describe('членство', () => {
  it('знает своих и не пускает чужого', async () => {
    const me = await person('я');
    const you = await person('ты');
    const third = await person('третий');
    const res = await dm.open(me.id, you.fingerprint);
    const slug = res.ok ? res.view.slug : '';

    expect(dm.isDm(slug)).toBe(true);
    expect(dm.isDm('lounge')).toBe(false);
    expect(dm.isMember(slug, me.id)).toBe(true);
    expect(dm.isMember(slug, you.id)).toBe(true);
    expect(dm.isMember(slug, third.id)).toBe(false);
    expect(dm.membersOf(slug)).toEqual([me.id, you.id].sort());
    expect(dm.channelIdOf(slug)).toBe(slug);
    expect(dm.channelIdOf('lounge')).toBeUndefined();
  });

  it('помнит беседы, заведённые до перезапуска', async () => {
    const me = await person('я');
    const you = await person('ты');
    const res = await dm.open(me.id, you.fingerprint);
    const slug = res.ok ? res.view.slug : '';

    const fresh = new DmService(db);
    await fresh.onModuleInit();
    expect(fresh.isMember(slug, me.id)).toBe(true);
  });
});

describe('список', () => {
  it('пуст, пока никого не открывали', async () => {
    const me = await person('я');
    expect(await dm.list(me.id)).toEqual([]);
  });

  it('показывает открытую переписку без единой реплики', async () => {
    const me = await person('я');
    const you = await person('ты');
    await dm.open(me.id, you.fingerprint);
    const list = await dm.list(me.id);
    expect(list).toHaveLength(1);
    expect(list[0].peer.nick).toBe('ты');
    expect(list[0].lastTs).toBe(0);
    expect(list[0].preview).toBe('');
  });

  it('показывает превью последней реплики и чья она', async () => {
    const me = await person('я');
    const you = await person('ты');
    const opened = await dm.open(me.id, you.fingerprint);
    const slug = opened.ok ? opened.view.slug : '';
    await db.getRepository(MessageRow).insert({
      id: randomUUID(),
      channelId: slug,
      authorName: 'ты',
      authorIdentityId: you.id,
      text: 'привет!',
      system: false,
      spoiler: false,
      reactions: {},
      mentions: [],
      createdAt: new Date(),
    });

    const list = await dm.list(me.id);
    expect(list[0].preview).toBe('привет!');
    expect(list[0].previewMine).toBe(false);
    expect(list[0].lastTs).toBeGreaterThan(0);

    // Та же реплика с точки зрения отправителя — «моя».
    const fromYou = await dm.list(you.id);
    expect(fromYou[0].previewMine).toBe(true);

    // open() второй раз тоже обязан вернуть свежее превью, а не пустое.
    const reopened = await dm.open(me.id, you.fingerprint);
    expect(reopened.ok && reopened.view.preview).toBe('привет!');
  });
});

describe('люди', () => {
  it('не показывает меня самого и забаненного', async () => {
    const me = await person('я');
    const you = await person('ты');
    const bad = await person('изгнанный');
    await db.getRepository(RoleRow).insert({
      id: randomUUID(),
      identityId: bad.id,
      serverId: null,
      role: 'banned',
      grantedBy: me.id,
      createdAt: new Date(),
    });

    const people = await dm.people(me.id, '', 20);
    expect(people.map((p) => p.nick)).toEqual(['ты']);
    expect(people[0].fingerprint).toBe(you.fingerprint);
  });

  it('ищет по нику и по отпечатку', async () => {
    const me = await person('я');
    const you = await person('Нина');
    expect((await dm.people(me.id, 'нин', 20)).map((p) => p.nick)).toEqual(['Нина']);
    expect(await dm.people(me.id, you.fingerprint.slice(0, 6), 20)).toHaveLength(1);
    expect(await dm.people(me.id, 'никого', 20)).toEqual([]);
  });
});

describe('память сервиса', () => {
  it('перечисляет мои беседы по памяти', async () => {
    const me = await person('я');
    const you = await person('ты');
    const res = await dm.open(me.id, you.fingerprint);
    expect(dm.slugsOf(me.id)).toEqual([res.ok ? res.view.slug : '']);
    expect(dm.slugsOf('11111111-1111-1111-1111-111111111111')).toEqual([]);
  });

  it('после открытия знает подпись обеих сторон, не только собеседника', async () => {
    // Обе личности заведены ПОСЛЕ onModuleInit — единственный источник записи
    // про инициатора беседы это open(), а не стартовый SELECT.
    const me = await person('я');
    const you = await person('ты');
    await dm.open(me.id, you.fingerprint);
    expect(dm.peerView(me.id)?.nick).toBe('я');
    expect(dm.peerView(you.id)?.nick).toBe('ты');
  });

  it('помнит ник для подписи и обновляет его при переименовании', async () => {
    const me = await person('я');
    const you = await person('ты');
    // peerView отвечает про собеседника: открыл переписку — он попал в кэш.
    await dm.open(me.id, you.fingerprint);
    expect(dm.peerView(you.id)?.nick).toBe('ты');
    dm.rememberNick(you.id, 'ты, но иначе');
    expect(dm.peerView(you.id)?.nick).toBe('ты, но иначе');
  });
});

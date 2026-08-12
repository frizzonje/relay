import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRow, MessageRow, PinRow, ServerRow } from './entities';
import { RetentionService, retentionDays } from './retention.service';
import { resetDatabase, testDatabase } from './testing';

/**
 * Ретенция — обещание, а не уборка: «переписка живёт четырнадцать дней». Всё,
 * что здесь проверяется, человек однажды заметит на своей инсталляции — либо
 * потому что старое исчезло вовремя, либо потому что исчезло лишнее.
 */

let db: DataSource;

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
  await db.getRepository(ServerRow).insert({
    id: 'srv',
    name: 'сервер',
    emoji: null,
    removable: true,
    passwordHash: null,
    creatorId: null,
    position: 0,
  });
  await db.getRepository(ChannelRow).insert({
    id: 'ch',
    serverId: 'srv',
    type: 'text',
    name: 'чат',
    slug: 'chat',
    removable: true,
    mode: null,
    creatorId: null,
    position: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Реплика возрастом в `days` дней. */
async function say(text: string, days: number): Promise<string> {
  const id = randomUUID();
  await db.getRepository(MessageRow).insert({
    id,
    channelId: 'ch',
    authorName: 'А',
    text,
    system: false,
    spoiler: false,
    attachmentId: null,
    replyTo: null,
    reactions: {},
    editedAt: null,
    authorIdentityId: null,
  });
  await db.query("UPDATE messages SET created_at = now() - ($1 || ' days')::interval WHERE id = $2", [
    days,
    id,
  ]);
  return id;
}

async function texts(): Promise<string[]> {
  const rows = await db.getRepository(MessageRow).find({ order: { text: 'ASC' } });
  return rows.map((r) => r.text);
}

describe('срок из окружения', () => {
  it('не задан — четырнадцать дней', () => {
    expect(retentionDays(undefined)).toBe(14);
    expect(retentionDays('  ')).toBe(14);
  });

  it('мусор — NaN, чтобы об этом можно было сказать вслух, а не молча подставить дефолт', () => {
    expect(retentionDays('навсегда')).toBeNaN();
  });

  it('число берётся как есть, включая ноль', () => {
    expect(retentionDays('30')).toBe(30);
    expect(retentionDays('0')).toBe(0);
  });
});

describe('проход ретенции', () => {
  it('удаляет старое, свежее не трогает', async () => {
    vi.stubEnv('RETENTION_DAYS', '14');
    await say('позавчерашнее', 2);
    await say('древнее', 20);

    expect(await new RetentionService(db).sweep()).toBe(1);
    expect(await texts()).toEqual(['позавчерашнее']);
  });

  it('закреплённое переживает срок — единственное исключение', async () => {
    vi.stubEnv('RETENTION_DAYS', '14');
    const pinned = await say('важное', 100);
    await say('обычное', 100);
    await db.getRepository(PinRow).insert({
      messageId: pinned,
      channelId: 'ch',
      pinnedBy: null,
    });

    expect(await new RetentionService(db).sweep()).toBe(1);
    expect(await texts()).toEqual(['важное']);
  });

  it('ноль — не хранить: чистится всё, включая сегодняшнее', async () => {
    vi.stubEnv('RETENTION_DAYS', '0');
    await say('только что', 0);
    await new RetentionService(db).sweep();
    expect(await texts()).toEqual([]);
  });

  it('мусор в переменной не отменяет ретенцию, а откатывает её к дефолту', async () => {
    vi.stubEnv('RETENTION_DAYS', 'навсегда');
    await say('древнее', 20);
    await say('вчерашнее', 1);
    const service = new RetentionService(db);
    expect(service.effectiveDays()).toBe(14);
    await service.sweep();
    expect(await texts()).toEqual(['вчерашнее']);
  });

  it('отрицательное — не удалять никогда: у инсталляции есть право так решить', async () => {
    vi.stubEnv('RETENTION_DAYS', '-1');
    await say('древнее', 1000);
    expect(await new RetentionService(db).sweep()).toBe(0);
    expect(await texts()).toEqual(['древнее']);
  });
});

describe('расписание', () => {
  it('первый проход — сразу на старте, а не через час', async () => {
    vi.stubEnv('RETENTION_DAYS', '14');
    await say('древнее', 20);
    const service = new RetentionService(db);
    const sweep = vi.spyOn(service, 'sweep');
    service.onModuleInit();
    expect(sweep).toHaveBeenCalledTimes(1);
    await sweep.mock.results[0].value;
    expect(await texts()).toEqual([]);
  });

  it('ноль означает «не хранить», поэтому ходим чаще часа', () => {
    vi.stubEnv('RETENTION_DAYS', '0');
    vi.useFakeTimers();
    const service = new RetentionService(db);
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();
    sweep.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('при «никогда» таймер не заводится вовсе и об этом сказано вслух', () => {
    vi.stubEnv('RETENTION_DAYS', '-1');
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const service = new RetentionService(db);
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(sweep).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRow, MessageRow, PinRow, ServerRow } from './entities';
import { RetentionService, parseRetention, retention } from './retention.service';
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
  // Время реплики хранится с точностью до миллисекунды и всегда обрезанным, а
  // не округлённым (см. миграцию MessageTimeMillis) — иначе «только что»
  // ложится на полмиллисекунды в будущее и переживает ретенцию нулевого срока.
  await db.query(
    "UPDATE messages SET created_at = date_trunc('milliseconds', now() - ($1 || ' days')::interval) WHERE id = $2",
    [days, id],
  );
  return id;
}

async function texts(): Promise<string[]> {
  const rows = await db.getRepository(MessageRow).find({ order: { text: 'ASC' } });
  return rows.map((r) => r.text);
}

describe('срок из окружения', () => {
  it('не задан — четырнадцать дней', () => {
    expect(parseRetention(undefined)).toEqual({ mode: 'days', days: 14 });
    expect(parseRetention('  ')).toEqual({ mode: 'days', days: 14 });
  });

  it('мусор — null, чтобы об этом можно было сказать вслух, а не молча подставить дефолт', () => {
    expect(parseRetention('когда-нибудь')).toBeNull();
    expect(retention('когда-нибудь')).toEqual({ mode: 'days', days: 14 });
  });

  it('положительное число — столько дней и есть', () => {
    expect(parseRetention('30')).toEqual({ mode: 'days', days: 30 });
    expect(parseRetention(' 7 ')).toEqual({ mode: 'days', days: 7 });
  });

  /**
   * Главная ловушка этой настройки. Ноль дней буквально означал бы «не хранить
   * ни дня», но человек, который набирает `0` на своём сервере, почти всегда
   * имеет в виду «без ограничения» — и цена ошибки несимметрична: лишнее
   * сохранённое удаляется командой, удалённое не возвращается ничем.
   */
  it('ноль — хранить всегда, а не «не хранить»', () => {
    expect(parseRetention('0')).toEqual({ mode: 'forever' });
  });

  it('отрицательное — тоже всегда: так уже настроены живые инсталляции', () => {
    expect(parseRetention('-1')).toEqual({ mode: 'forever' });
  });

  it('«не хранить» получает собственное слово, которое случайно не наберёшь', () => {
    expect(parseRetention('ephemeral')).toEqual({ mode: 'ephemeral' });
    expect(parseRetention('none')).toEqual({ mode: 'ephemeral' });
    expect(parseRetention('EPHEMERAL')).toEqual({ mode: 'ephemeral' });
  });

  it('«всегда» тоже называется словами, а не только нулём', () => {
    for (const word of ['forever', 'never', 'unlimited', 'off', 'Forever']) {
      expect(parseRetention(word)).toEqual({ mode: 'forever' });
    }
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

  it('«ephemeral» — не хранить: чистится всё, включая сегодняшнее', async () => {
    vi.stubEnv('RETENTION_DAYS', 'ephemeral');
    await say('только что', 0);
    await new RetentionService(db).sweep();
    expect(await texts()).toEqual([]);
  });

  it('ноль не удаляет ничего — иначе он бы значил ровно обратное задуманному', async () => {
    vi.stubEnv('RETENTION_DAYS', '0');
    await say('древнее', 1000);
    expect(await new RetentionService(db).sweep()).toBe(0);
    expect(await texts()).toEqual(['древнее']);
  });

  it('мусор в переменной не отменяет ретенцию, а откатывает её к дефолту', async () => {
    vi.stubEnv('RETENTION_DAYS', 'когда-нибудь');
    await say('древнее', 20);
    await say('вчерашнее', 1);
    const service = new RetentionService(db);
    expect(service.effective()).toEqual({ mode: 'days', days: 14 });
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

  it('«не хранить» означает, что ходим чаще часа: час был бы часом хранения', () => {
    vi.stubEnv('RETENTION_DAYS', 'ephemeral');
    vi.useFakeTimers();
    const service = new RetentionService(db);
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();
    sweep.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('при «всегда» таймер не заводится вовсе', () => {
    vi.stubEnv('RETENTION_DAYS', 'forever');
    vi.useFakeTimers();
    const service = new RetentionService(db);
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(sweep).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  /**
   * Хранение — обещание людям на этом сервере, и оно обязано быть в логе при
   * каждом старте, а не только когда значение необычное: хозяин, который его
   * не выбирал, узнаёт о нём отсюда и больше ниоткуда.
   */
  it('политика проговаривается в лог на каждом старте, какой бы она ни была', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    for (const [value, said] of [
      ['forever', 'без срока'],
      ['ephemeral', 'не хранится вовсе'],
      ['30', '30 дн.'],
    ] as const) {
      log.mockClear();
      vi.stubEnv('RETENTION_DAYS', value);
      const service = new RetentionService(db);
      vi.spyOn(service, 'sweep').mockResolvedValue(0);
      service.onModuleInit();
      expect(log.mock.calls.flat().join(' ')).toContain(said);
    }
    vi.useRealTimers();
  });

  it('мусор говорится отдельно: «14» и «непонятно что, поэтому 14» — разное', () => {
    vi.stubEnv('RETENTION_DAYS', 'когда-нибудь');
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const service = new RetentionService(db);
    vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();
    expect(warn.mock.calls.flat().join(' ')).toContain('когда-нибудь');
    vi.useRealTimers();
  });
});

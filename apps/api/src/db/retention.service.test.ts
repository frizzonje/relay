import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { ChannelRow, MessageRow, PinRow, ServerRow } from './entities';
import { parseRetention } from './retention.policy';
import { RetentionService } from './retention.service';
import { resetDatabase, testDatabase } from './testing';

/**
 * Ретенция — обещание, а не уборка: «переписка живёт четырнадцать дней». Всё,
 * что здесь проверяется, человек однажды заметит на своей инсталляции — либо
 * потому что старое исчезло вовремя, либо потому что исчезло лишнее.
 */

let db: DataSource;
const owner = randomUUID();

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

/**
 * Настройки такой инсталляции — как их видит живой процесс: посев из окружения
 * уже прошёл. `RETENTION_DAYS` доезжает до ретенции только этой дорогой:
 * своего разбора переменной у сервиса больше нет, и второй источник срока
 * разошёлся бы с тем, что показывает панель.
 */
async function settingsWith(env?: string): Promise<SettingsService> {
  if (env !== undefined) vi.stubEnv('RETENTION_DAYS', env);
  const settings = new SettingsService(db);
  await settings.onModuleInit();
  return settings;
}

async function retentionFor(env?: string): Promise<RetentionService> {
  return new RetentionService(db, await settingsWith(env));
}

describe('срок из окружения', () => {
  it('не задан — четырнадцать дней', () => {
    expect(parseRetention(undefined)).toEqual({ mode: 'days', days: 14 });
    expect(parseRetention('  ')).toEqual({ mode: 'days', days: 14 });
  });

  it('мусор — null, чтобы об этом можно было сказать вслух, а не молча подставить дефолт', () => {
    expect(parseRetention('когда-нибудь')).toBeNull();
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
    const service = await retentionFor('14');
    await say('позавчерашнее', 2);
    await say('древнее', 20);

    expect(await service.sweep()).toBe(1);
    expect(await texts()).toEqual(['позавчерашнее']);
  });

  it('закреплённое переживает срок — единственное исключение', async () => {
    const service = await retentionFor('14');
    const pinned = await say('важное', 100);
    await say('обычное', 100);
    await db.getRepository(PinRow).insert({
      messageId: pinned,
      channelId: 'ch',
      pinnedBy: null,
    });

    expect(await service.sweep()).toBe(1);
    expect(await texts()).toEqual(['важное']);
  });

  it('«ephemeral» — не хранить: чистится всё, включая сегодняшнее', async () => {
    const service = await retentionFor('ephemeral');
    await say('только что', 0);
    await service.sweep();
    expect(await texts()).toEqual([]);
  });

  it('ноль не удаляет ничего — иначе он бы значил ровно обратное задуманному', async () => {
    const service = await retentionFor('0');
    await say('древнее', 1000);
    expect(await service.sweep()).toBe(0);
    expect(await texts()).toEqual(['древнее']);
  });

  it('мусор в переменной не отменяет ретенцию, а откатывает её к дефолту', async () => {
    const service = await retentionFor('когда-нибудь');
    await say('древнее', 20);
    await say('вчерашнее', 1);
    expect(service.effective()).toEqual({ mode: 'days', days: 14 });
    await service.sweep();
    expect(await texts()).toEqual(['вчерашнее']);
  });

  it('отрицательное — не удалять никогда: у инсталляции есть право так решить', async () => {
    const service = await retentionFor('-1');
    await say('древнее', 1000);
    expect(await service.sweep()).toBe(0);
    expect(await texts()).toEqual(['древнее']);
  });
});

describe('расписание', () => {
  it('первый проход — сразу на старте, а не через час', async () => {
    const service = await retentionFor('14');
    await say('древнее', 20);
    const sweep = vi.spyOn(service, 'sweep');
    service.onModuleInit();
    expect(sweep).toHaveBeenCalledTimes(1);
    await sweep.mock.results[0].value;
    expect(await texts()).toEqual([]);
  });

  it('«не хранить» означает, что ходим чаще часа: час был бы часом хранения', async () => {
    // Сервис собирается до подмены таймеров: настройки идут в базу, а запрос
    // под фейковыми таймерами повис бы вместе со всем прогоном.
    const service = await retentionFor('ephemeral');
    vi.useFakeTimers();
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();
    sweep.mockClear();

    vi.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('при «всегда» таймер не заводится вовсе', async () => {
    const service = await retentionFor('forever');
    vi.useFakeTimers();
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
  it('политика проговаривается в лог на каждом старте, какой бы она ни была', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    for (const [value, said] of [
      ['forever', 'без срока'],
      ['ephemeral', 'не хранится вовсе'],
      ['30', '30 дн.'],
    ] as const) {
      // Каждый заход — своя инсталляция: посев из окружения опаздывает к
      // переопределению, оставшемуся в таблице от предыдущего значения.
      await db.query('TRUNCATE settings');
      const service = await retentionFor(value);
      log.mockClear();
      vi.useFakeTimers();
      vi.spyOn(service, 'sweep').mockResolvedValue(0);
      service.onModuleInit();
      expect(log.mock.calls.flat().join(' ')).toContain(said);
      vi.useRealTimers();
    }
  });
});

/**
 * Настройка, действующая только после перезапуска, — не настройка. Хозяин,
 * поставивший в панели два дня, ждёт, что недельное уйдёт сегодня.
 */
describe('срок из настроек, а не из перезапуска', () => {
  it('смена срока меняет то, что уносит ближайший же проход', async () => {
    const settings = await settingsWith();
    const service = new RetentionService(db, settings);
    await say('вчерашнее', 1);
    await say('трёхдневное', 3);

    // Умолчание каталога — сегодняшние четырнадцать дней: не уходит ничего.
    expect(await service.sweep()).toBe(0);

    expect(await settings.set('messages.retentionDays', 2, owner)).toMatchObject({ ok: true });
    expect(await service.sweep()).toBe(1);
    expect(await texts()).toEqual(['вчерашнее']);
  });

  it('смена режима будит проход сразу, а не с ближайшим таймером', async () => {
    const settings = await settingsWith('forever');
    const service = new RetentionService(db, settings);
    service.onModuleInit();
    await say('только что', 0);
    // «Хранить всегда» — таймера нет вовсе, и без подписки смена режима
    // осталась бы обещанием до перезапуска.
    expect(await texts()).toEqual(['только что']);

    const sweep = vi.spyOn(service, 'sweep');
    await settings.set('messages.retentionMode', 'ephemeral', owner);
    expect(sweep).toHaveBeenCalledTimes(1);
    await sweep.mock.results[0].value;

    expect(await texts()).toEqual([]);
    service.onModuleDestroy();
  });

  it('остановленный сервис на чужие правки больше не просыпается', async () => {
    const settings = await settingsWith();
    const service = new RetentionService(db, settings);
    const sweep = vi.spyOn(service, 'sweep').mockResolvedValue(0);
    service.onModuleInit();
    service.onModuleDestroy();

    sweep.mockClear();
    await settings.set('messages.retentionDays', 3, owner);
    expect(sweep).not.toHaveBeenCalled();
  });
});

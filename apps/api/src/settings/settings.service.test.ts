import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { SettingRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { SETTINGS, type SettingValue } from './catalog';
import { SEEDED_FROM_ENV, SettingsService } from './settings.service';

/**
 * Настройки — это обещание «инсталляция ведёт себя так, как её настроили», и
 * ровно одно из проверяемого здесь важнее прочего: инсталляция, которую НЕ
 * настраивали, обязана вести себя как вчера. Всё остальное — про то, чтобы
 * значение не потерялось, не соврало наружу и не досталось не тому.
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Свежий сервис — как после перезапуска: кэш пуст, всё читается заново. */
async function started(): Promise<SettingsService> {
  const service = new SettingsService(db);
  await service.onModuleInit();
  return service;
}

const rows = () => db.getRepository(SettingRow).count();
const row = (key: string) => db.getRepository(SettingRow).findOneBy({ key });

describe('умолчания', () => {
  it('на пустой таблице каждый параметр каталога отдаёт своё умолчание', async () => {
    const settings = await started();
    // Не выборочно, а все до одного: это и есть «инсталляция, где панель не
    // открывали, работает как прежде», проверенное в лоб.
    expect(SETTINGS.length).toBe(97);
    for (const spec of SETTINGS) {
      expect([spec.key, settings.get<SettingValue>(spec.key)]).toEqual([spec.key, spec.fallback]);
    }
  });

  it('чтение ничего не пишет — таблица остаётся пустой', async () => {
    const settings = await started();
    for (const spec of SETTINGS) settings.get<SettingValue>(spec.key);
    expect(await rows()).toBe(0);
  });

  it('неизвестный ключ — ошибка, а не пустота', async () => {
    const settings = await started();
    expect(() => settings.get('messages.нетТакого')).toThrow(/неизвестный ключ/);
  });

  it('строка мимо каталога не ломает старт и не остаётся молчаливой', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [
      'messages.retentionDays',
      JSON.stringify('тридцать'),
    ]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const settings = await started();
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
    expect(warn.mock.calls.flat().join(' ')).toContain('messages.retentionDays');
  });
});

describe('окружение', () => {
  it('засевает то, чем инсталляция уже отличается от умолчания', async () => {
    vi.stubEnv('RETENTION_DAYS', '30');
    const settings = await started();
    expect(settings.get<number>('messages.retentionDays')).toBe(30);
    expect((await row('messages.retentionDays'))?.value).toBe(30);
    // Автора у засева нет: это не правка человека, а перенос того, что было.
    expect((await row('messages.retentionDays'))?.updatedBy).toBeNull();
  });

  it('не трогает то, что и так равно умолчанию каталога', async () => {
    vi.stubEnv('RETENTION_DAYS', '14');
    await started();
    // Иначе первый же старт вморозил бы сегодняшние умолчания навсегда, и
    // правка каталога в следующей версии не доехала бы до этой инсталляции.
    expect(await row('messages.retentionDays')).toBeNull();
    expect(await rows()).toBe(0);
  });

  it('одна переменная задаёт и режим хранения, и срок', async () => {
    vi.stubEnv('RETENTION_DAYS', 'forever');
    const settings = await started();
    expect(settings.get<string>('messages.retentionMode')).toBe('forever');
    // Числа дней у «хранить всегда» нет — и выдумывать его нечем.
    expect(await row('messages.retentionDays')).toBeNull();
  });

  it('мусор в переменной не засевается вовсе', async () => {
    vi.stubEnv('RETENTION_DAYS', 'когда-нибудь');
    const settings = await started();
    expect(await rows()).toBe(0);
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
  });

  /**
   * «Четырнадцать» и «непонятно что, поэтому четырнадцать» выглядят в логе
   * одинаково, а означают разное. Сказать об этом можно только здесь: дальше
   * `RETENTION_DAYS` не читает никто, ретенция берёт срок уже у настроек.
   */
  it('мусор в переменной не остаётся молчаливым', async () => {
    vi.stubEnv('RETENTION_DAYS', 'когда-нибудь');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await started();
    expect(warn.mock.calls.flat().join(' ')).toContain('когда-нибудь');
  });

  it('нецелый срок не проходит проверку каталога и остаётся в логе', async () => {
    vi.stubEnv('RETENTION_DAYS', '1.5');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const settings = await started();
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
    expect(warn.mock.calls.flat().join(' ')).toContain('messages.retentionDays');
  });

  it('после первой записи окружение больше не решает', async () => {
    const settings = await started();
    await settings.set('messages.retentionDays', 7, owner);

    vi.stubEnv('RETENTION_DAYS', '30');
    expect((await started()).get<number>('messages.retentionDays')).toBe(7);
  });

  it('секреты и инфраструктура в таблицу не засеваются', async () => {
    vi.stubEnv('SITE_PASSWORD', 'тайна');
    vi.stubEnv('TURN_URLS', 'turn:turn.example:3478');
    const settings = await started();

    // Пароль открытым текстом в базе — это резервная копия с паролем внутри;
    // в таблице ему место только тогда, когда его задаст владелец из панели.
    expect(await rows()).toBe(0);
    // Но наружу инсталляция при этом честно говорит «задано» и «вот адрес».
    expect(settings.public()['access.sitePasswordSet']).toBe(true);
    expect(settings.public()['voice.turnUrls']).toBe('turn:turn.example:3478');
  });

  it('каталог не может завести засеваемый ключ мимо сервиса', () => {
    // Конвенция без падающего теста — не конвенция: параметр с `env`, о котором
    // посев не знает, молча остался бы с умолчанием на живой инсталляции.
    const seedable = SETTINGS.filter((spec) => spec.env && !spec.secret && !spec.readOnly).map(
      (spec) => spec.key,
    );
    expect(seedable).toEqual([...SEEDED_FROM_ENV]);
  });
});

describe('запись', () => {
  it('переживает перезапуск', async () => {
    const first = await started();
    await first.set('messages.maxLength', 900, owner);
    expect((await started()).get<number>('messages.maxLength')).toBe(900);
  });

  it('запоминает, кто менял', async () => {
    const settings = await started();
    await settings.set('messages.maxLength', 900, owner);
    expect((await row('messages.maxLength'))?.updatedBy).toBe(owner);
  });

  it('отказывает по каталогу и ничего не пишет', async () => {
    const settings = await started();
    expect(await settings.set('messages.retentionDays', 0, owner)).toEqual({
      ok: false,
      error: 'out-of-range',
    });
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
    expect(await rows()).toBe(0);
  });

  it('называет причину отказа, а не просто «нет»', async () => {
    const settings = await started();
    expect(await settings.set('нет.такого', 1, owner)).toEqual({
      ok: false,
      error: 'unknown-key',
    });
    expect(await settings.set('messages.maxLength', '900', owner)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
    expect(await settings.set('messages.retentionMode', 'иногда', owner)).toEqual({
      ok: false,
      error: 'not-an-option',
    });
    expect(await settings.set('maintenance.message', 'я'.repeat(2001), owner)).toEqual({
      ok: false,
      error: 'too-long',
    });
    expect(await settings.set('moderation.bannedWords', ['я'.repeat(101)], owner)).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('не принимает того, что живёт в окружении, — и не заводит строку', async () => {
    const settings = await started();
    expect(await settings.set('voice.sfuUrl', 'https://sfu.example', owner)).toEqual({
      ok: false,
      error: 'read-only',
    });
    expect(await rows()).toBe(0);
  });

  it('секрет общей дорогой не пишется вовсе', async () => {
    // Здесь пароль лёг бы в jsonb как есть — то есть в каждую резервную копию.
    // Своя дорога (scrypt и отзыв выданных пропусков) появится в задаче 8, а
    // общий обработчик панели обязан получить отказ, а не «сохранено».
    const settings = await started();
    const res = await settings.set('access.sitePasswordSet', 'тайна', owner);
    expect(res).toEqual({ ok: false, error: 'secret-path' });
    expect(await rows()).toBe(0);
  });

  it('отказ по секрету не зависит от того, какой ключ секретный', async () => {
    // Правило держится за пометку каталога, а не за имя `access.sitePasswordSet`:
    // заведут второй секрет — он закроется тем же отказом, без правки кода.
    const settings = await started();
    for (const spec of SETTINGS.filter((item) => item.secret)) {
      expect(await settings.set(spec.key, 'x', owner)).toMatchObject({ ok: false });
    }
    expect(await rows()).toBe(0);
  });

  it('повторная запись того же значения — не изменение', async () => {
    const settings = await started();
    await settings.set('direct.enabled', false, owner);
    expect(await settings.set('direct.enabled', false, owner)).toEqual({
      ok: true,
      changed: false,
      before: false,
    });
  });

  it('второй правке того же ключа время ставится заново', async () => {
    const settings = await started();
    await settings.set('messages.maxLength', 900, owner);
    const first = (await row('messages.maxLength'))!.updatedAt;

    await settings.set('messages.maxLength', 800, owner);
    const second = (await row('messages.maxLength'))!.updatedAt;

    // Дефолт колонки срабатывает только на вставке: не выставь ветка обновления
    // время выражением базы, оно замерло бы на моменте первой записи, и «когда
    // это поменяли» врало бы тем убедительнее, чем дольше живёт инсталляция.
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it('список сохраняется составом и не правится из-под кэша', async () => {
    const settings = await started();
    await settings.set('moderation.bannedWords', ['первое', 'второе'], owner);
    expect((await started()).get<string[]>('moderation.bannedWords')).toEqual(['первое', 'второе']);

    const live = settings.get<string[]>('moderation.bannedWords');
    expect(() => live.push('третье')).toThrow();
  });
});

describe('наружу', () => {
  it('секрет уходит признаком, а не значением', async () => {
    vi.stubEnv('SITE_PASSWORD', 'тайна');
    const settings = await started();
    expect(settings.public()['access.sitePasswordSet']).toBe(true);
    expect(JSON.stringify(settings.public())).not.toContain('тайна');
  });

  it('секрет инфраструктуры — тоже признак, и он из окружения', async () => {
    const settings = await started();
    expect(settings.public()['voice.turnSecretSet']).toBe(false);
    vi.stubEnv('TURN_SECRET', 'общий');
    expect(settings.public()['voice.turnSecretSet']).toBe(true);
    expect(JSON.stringify(settings.public())).not.toContain('общий');
  });

  it('инфраструктурное читается в момент вызова, а не при старте', async () => {
    const settings = await started();
    expect(settings.public()['voice.sfuUrl']).toBe('');
    // Перезапуска нет намеренно: значение снято при старте разошлось бы с тем,
    // что реально слушает порт, ровно тогда, когда пришли разбираться.
    vi.stubEnv('SFU_URL', '/sfu');
    expect(settings.public()['voice.sfuUrl']).toBe('/sfu');
  });

  it('показывает весь каталог и отдаёт списки копией', async () => {
    const settings = await started();
    const shown = settings.public();
    expect(Object.keys(shown).sort()).toEqual(SETTINGS.map((spec) => spec.key).sort());

    (shown['files.allowedKinds'] as string[]).push('видео');
    expect(settings.get<string[]>('files.allowedKinds')).toEqual(['image', 'audio', 'file']);
  });
});

describe('подписка', () => {
  it('будит подписчиков ровно на изменениях', async () => {
    const settings = await started();
    const seen: string[] = [];
    settings.onChange((key) => seen.push(key));

    await settings.set('direct.enabled', false, owner);
    await settings.set('direct.enabled', false, owner);
    await settings.set('direct.enabled', 'нет', owner);
    expect(seen).toEqual(['direct.enabled']);
  });

  it('несёт новое значение и отписывается', async () => {
    const settings = await started();
    const seen: Array<[string, SettingValue]> = [];
    const off = settings.onChange((key, value) => seen.push([key, value]));

    await settings.set('messages.pageSize', 100, owner);
    off();
    await settings.set('messages.pageSize', 60, owner);
    expect(seen).toEqual([['messages.pageSize', 100]]);
  });

  /**
   * Подписчик — чужой код, и он умеет падать. Значение к моменту рассылки уже
   * в базе и в кэше: откатывать нечего, а исключение наружу означало бы
   * «не сохранено» на сохранённом — панель показала бы ошибку там, где
   * настройка сменилась.
   */
  it('бросивший подписчик не срывает запись и не глушит соседей', async () => {
    const settings = await started();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    settings.onChange(() => {
      throw new Error('подписчик сломался');
    });
    settings.onChange((key) => seen.push(key));

    expect(await settings.set('messages.pageSize', 100, owner)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(seen).toEqual(['messages.pageSize']);
    expect((await row('messages.pageSize'))?.value).toBe(100);
    // Потребитель, тихо не узнавший о правке, — это «настройка есть, но не
    // действует»; найти такое потом можно только по этой строке.
    expect(error.mock.calls.flat().join(' ')).toContain('messages.pageSize');
  });

  it('сброс группы будит теми же ключами', async () => {
    const settings = await started();
    await settings.set('files.maxUploadBytes', 1024, owner);

    const seen: Array<[string, SettingValue]> = [];
    settings.onChange((key, value) => seen.push([key, value]));
    await settings.resetGroup('files', owner);
    expect(seen).toEqual([['files.maxUploadBytes', 25 * 1024 * 1024]]);
  });
});

describe('сброс группы', () => {
  it('возвращает только то, что менялось', async () => {
    const settings = await started();
    await settings.set('files.maxUploadBytes', 1024, owner);

    expect(await settings.resetGroup('files', owner)).toEqual(['files.maxUploadBytes']);
    expect(settings.get<number>('files.maxUploadBytes')).toBe(25 * 1024 * 1024);
    expect(await settings.resetGroup('files', owner)).toEqual([]);
  });

  it('уносит переопределения группы и не трогает соседние', async () => {
    const settings = await started();
    await settings.set('files.maxUploadBytes', 1024, owner);
    await settings.set('files.imagePreviews', false, owner);
    await settings.set('direct.enabled', false, owner);

    expect((await settings.resetGroup('files', owner)).sort()).toEqual([
      'files.imagePreviews',
      'files.maxUploadBytes',
    ]);
    expect(await rows()).toBe(1);
    expect(settings.get<boolean>('direct.enabled')).toBe(false);
  });

  it('уносит и строку, совпавшую с умолчанием, но изменением её не считает', async () => {
    // Строка, равная умолчанию, могла приехать засевом или правкой «туда и
    // обратно». Оставь её — и следующая правка каталога обойдёт инсталляцию.
    await db.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [
      'files.imagePreviews',
      JSON.stringify(true),
    ]);
    const restarted = await started();

    expect(await restarted.resetGroup('files', owner)).toEqual([]);
    expect(await rows()).toBe(0);
  });

  it('не снимает пароль вместе с видом страницы входа', async () => {
    // Сброс группы `access` вернул бы секрету умолчание — пустую строку, то
    // есть открытую дверь на всю инсталляцию. Человек, сбрасывавший соседние
    // поля, узнал бы об этом последним.
    // Строку кладём мимо сервиса — своей дорогой её положит задача 8.
    await db
      .getRepository(SettingRow)
      .save({ key: 'access.sitePasswordSet', value: 'хэш', updatedBy: owner });
    const settings = await started();

    await settings.set('access.maxDevicesPerIdentity', 3, owner);
    expect(await settings.resetGroup('access', owner)).toEqual(['access.maxDevicesPerIdentity']);
    expect(await row('access.sitePasswordSet')).not.toBeNull();
    expect(settings.public()['access.sitePasswordSet']).toBe(true);
  });

  it('нетронутая группа не ходит в базу впустую', async () => {
    const settings = await started();
    expect(await settings.resetGroup('appearance', owner)).toEqual([]);
  });
});

import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { AttachmentRow, ChannelRow, MessageRow, ServerRow } from './db/entities';
import { resetDatabase, testDatabase } from './db/testing';
import { SettingsService } from './settings/settings.service';
import { tune } from './settings/settings.testkit';
import { UploadByteBudget, UploadsEnabledGuard } from './upload.guard';
import { UploadsService, parseBytes } from './uploads';

/**
 * Загрузки — единственный путь, которым посторонний пишет на диск сервера.
 * Проверяем две вещи, которых раньше не было вовсе: потолок на каталог (и то,
 * что вытеснение забирает старое, а не свежее) и бюджет байтов на адрес.
 */

let dir: string;
let warned: ReturnType<typeof vi.spyOn>;
let db: DataSource;
let settings: SettingsService;
const owner = randomUUID();

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  // Настройки настоящие и пустые: это «инсталляция, где панель не открывали»,
  // и файловая политика в ней обязана совпадать с той, что была до панели.
  settings = new SettingsService(db);
  await settings.onModuleInit();
  dir = mkdtempSync(join(tmpdir(), 'relay-uploads-'));
  warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// Каталог — параметр экземпляра: перезагружать ради него модуль нельзя, иначе
// сущности станут другими классами, чем те, что знает открытое соединение с
// базой. А потолок каталога с этапа C — настройка, и ставится он ею же: тот же
// путь, которым его двигает панель на живом сервисе.
async function makeService(quota: string) {
  await tune(settings, 'files.installQuotaBytes', Number(quota));
  return new UploadsService(db, settings, dir);
}

/** Сервис инсталляции, где панель не открывали ни разу. */
function untouched() {
  return new UploadsService(db, settings, dir);
}

/** Канал, которому можно приписать сообщение с вложением. */
async function makeChannel(): Promise<string> {
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
  return 'ch';
}

/** Сообщение с этим вложением — то, что превращает загрузку в чью-то реплику. */
async function attachTo(channelId: string, attachmentId: string): Promise<void> {
  await db.getRepository(MessageRow).insert({
    id: randomUUID(),
    channelId,
    authorName: 'А',
    text: 'вот файл',
    system: false,
    spoiler: false,
    attachmentId,
    replyTo: null,
    reactions: {},
    editedAt: null,
    authorIdentityId: null,
  });
}

/** Состарить строку вложения: подметание смотрит на время загрузки. */
async function ageUpload(id: string, hours: number): Promise<void> {
  await db.query(
    "UPDATE attachments SET uploaded_at = now() - ($1 || ' hours')::interval WHERE id = $2",
    [hours, id],
  );
}

// Кладём файл на диск и отдаём его так, как отдал бы multer. `ageSec` разводит
// файлы по времени: вытеснение идёт по mtime.
function put(name: string, size: number, ageSec: number, mimetype = 'application/octet-stream') {
  const full = join(dir, name);
  writeFileSync(full, Buffer.alloc(size));
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(full, when, when);
  return { filename: name, originalname: name, size, mimetype };
}

/** Код отказа, с которым `register` не принял загрузку. */
async function refusalOf(run: Promise<unknown>): Promise<number> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  return (err as HttpException).getStatus();
}

describe('parseBytes', () => {
  it('берёт голые байты', () => {
    expect(parseBytes('1048576', 1)).toBe(1048576);
  });

  it('понимает приставки, которые человек и напишет в .env', () => {
    expect(parseBytes('2G', 1)).toBe(2 * 1024 ** 3);
    expect(parseBytes('512M', 1)).toBe(512 * 1024 ** 2);
    expect(parseBytes('1.5Gi', 1)).toBe(1.5 * 1024 ** 3);
    expect(parseBytes('100 MiB', 1)).toBe(100 * 1024 ** 2);
  });

  it('пусто или не задано — дефолт', () => {
    expect(parseBytes(undefined, 7)).toBe(7);
    expect(parseBytes('   ', 7)).toBe(7);
  });

  it('мусор — NaN, а не молчаливый дефолт: об этом надо сказать вслух', () => {
    expect(parseBytes('много', 7)).toBeNaN();
    expect(parseBytes('-5', 7)).toBeNaN();
    expect(parseBytes('0', 7)).toBeNaN();
  });
});

describe('квота каталога', () => {
  it('под потолком ничего не трогает', async () => {
    const svc = await makeService('1000');
    await svc.register(put('a.bin', 300, 60));
    await svc.register(put('b.bin', 300, 30));
    expect(existsSync(join(dir, 'a.bin'))).toBe(true);
    expect(existsSync(join(dir, 'b.bin'))).toBe(true);
    expect(warned).not.toHaveBeenCalled();
  });

  it('за потолком вытесняет самое старое и говорит об этом', async () => {
    const svc = await makeService('1000');
    await svc.register(put('old.bin', 400, 300));
    await svc.register(put('mid.bin', 400, 200));
    await svc.register(put('new.bin', 400, 10)); // 1200 > 1000

    expect(existsSync(join(dir, 'old.bin'))).toBe(false);
    expect(existsSync(join(dir, 'mid.bin'))).toBe(true);
    expect(existsSync(join(dir, 'new.bin'))).toBe(true);
    // Пропавшие вложения без строчки в логе выглядели бы как поломка.
    expect(warned).toHaveBeenCalled();
  });

  it('свежую загрузку не вытесняет, даже если она одна и не влезает', async () => {
    const svc = await makeService('100');
    await svc.register(put('big.bin', 500, 0));
    // Отдать ссылку и тут же удалить файл — худшее из поведений.
    expect(existsSync(join(dir, 'big.bin'))).toBe(true);
  });

  it('метаданные вытесненного забываются вместе с файлом', async () => {
    const svc = await makeService('1000');
    await svc.register(put('old.bin', 900, 300));
    await svc.register(put('new.bin', 900, 10));
    expect(await svc.exists('old.bin')).toBe(false);
    expect(await svc.exists('new.bin')).toBe(true);
  });

  it('файлы прошлого процесса считаются: рестарт не обнуляет квоту', async () => {
    const svc = await makeService('1000');
    // Счётчик размера рестарта не переживает, а файлы остаются. Не заметить
    // их значит начинать отсчёт заново после каждого рестарта — то есть не
    // иметь потолка вообще.
    put('orphan-1.bin', 600, 300);
    put('orphan-2.bin', 600, 200);

    await svc.sweep(); // старт api: подметание считает каталог с диска
    expect(existsSync(join(dir, 'orphan-1.bin'))).toBe(false); // 1200 > 1000
    expect(existsSync(join(dir, 'orphan-2.bin'))).toBe(true);

    await svc.register(put('new.bin', 500, 0)); // 600 + 500 — снова за потолком
    expect(existsSync(join(dir, 'orphan-2.bin'))).toBe(false);
    expect(existsSync(join(dir, 'new.bin'))).toBe(true);
  });

  it('не заглядывает в подкаталоги: рядом лежит реестр', async () => {
    const svc = await makeService('100');
    mkdirSync(join(dir, 'state'));
    const registry = join(dir, 'state', 'registry.json');
    writeFileSync(registry, '{"servers":[]}');
    const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    utimesSync(registry, old, old);
    utimesSync(join(dir, 'state'), old, old);

    await svc.sweep(); // подметание по TTL + квота
    expect(existsSync(registry)).toBe(true);
  });
});

describe('жизнь файла = жизнь его сообщения', () => {
  it('отправленное в чат не подметают, сколько бы ему ни было лет', async () => {
    const svc = await makeService('100000');
    const channel = await makeChannel();
    await svc.register(put('sent.bin', 10, 0));
    await attachTo(channel, 'sent.bin');
    await ageUpload('sent.bin', 24 * 365);

    await svc.sweep();
    expect(existsSync(join(dir, 'sent.bin'))).toBe(true);
  });

  it('загруженное и не отправленное живёт сутки, потом уходит вместе со строкой', async () => {
    const svc = await makeService('100000');
    await svc.register(put('forgotten.bin', 10, 0));
    await ageUpload('forgotten.bin', 25);

    await svc.sweep();
    expect(existsSync(join(dir, 'forgotten.bin'))).toBe(false);
    expect(await svc.exists('forgotten.bin')).toBe(false);
  });

  it('свежая загрузка переживает подметание — человек ещё пишет сообщение', async () => {
    const svc = await makeService('100000');
    await svc.register(put('typing.bin', 10, 0));

    await svc.sweep();
    expect(existsSync(join(dir, 'typing.bin'))).toBe(true);
  });

  it('удалили сообщение — файл уходит следом', async () => {
    const svc = await makeService('100000');
    const channel = await makeChannel();
    await svc.register(put('bye.bin', 10, 0));
    await attachTo(channel, 'bye.bin');
    await ageUpload('bye.bin', 25);

    // Ровно то, что делает ретенция: сообщения не стало.
    await db.query('DELETE FROM messages');
    await svc.sweep();
    expect(existsSync(join(dir, 'bye.bin'))).toBe(false);
  });

  it('файл унесли руками — строка не остаётся висеть', async () => {
    const svc = await makeService('100000');
    await svc.register(put('ghost.bin', 10, 0));
    await ageUpload('ghost.bin', 25);
    rmSync(join(dir, 'ghost.bin'));

    await svc.sweep();
    expect(await svc.exists('ghost.bin')).toBe(false);
  });
});

describe('бюджет байтов на адрес', () => {
  it('пускает, пока бюджет не потрачен', () => {
    const b = new UploadByteBudget(1000, 0);
    expect(b.allow('ip', 0)).toBe(true);
    b.charge('ip', 999, 0);
    expect(b.allow('ip', 0)).toBe(true);
    b.charge('ip', 1, 0);
    expect(b.allow('ip', 0)).toBe(false);
  });

  it('восстанавливается со временем', () => {
    const b = new UploadByteBudget(1000, 100); // 100 Б/с
    b.charge('ip', 1000, 0);
    expect(b.allow('ip', 0)).toBe(false);
    expect(b.allow('ip', 1_000)).toBe(true); // секунда спустя
  });

  it('долг не бездонный: один огромный файл не запирает адрес навсегда', () => {
    const b = new UploadByteBudget(1000, 100);
    b.charge('ip', 10 ** 9, 0);
    expect(b.allow('ip', 20_000)).toBe(true); // 20 с × 100 Б/с добирают -1000 до 1000
  });

  it('адреса считаются порознь', () => {
    const b = new UploadByteBudget(1000, 0);
    b.charge('ip-1', 1000, 0);
    expect(b.allow('ip-1', 0)).toBe(false);
    expect(b.allow('ip-2', 0)).toBe(true);
  });
});

/**
 * Файловая политика — то, чем владелец закрывает загрузки, режет размер или
 * запрещает вид. Проверяется главным образом одно: правка в панели действует
 * на живом сервисе, а не после перезапуска.
 */
describe('файловая политика', () => {
  it('ненастроенная инсталляция принимает ровно то же, что и до панели', async () => {
    const svc = await makeService('1000000');
    const out = await svc.register(put('кот.png', 1000, 0, 'image/png'));
    expect(out.kind).toBe('image');
    // 25 МиБ — сегодняшний потолок на файл; ровно он и остаётся умолчанием.
    expect(await svc.exists('кот.png')).toBe(true);
  });

  it('выключенные загрузки отвергают файл и не оставляют его на диске', async () => {
    const svc = await makeService('1000000');
    await settings.set('files.uploadsEnabled', false, owner);

    expect(await refusalOf(svc.register(put('x.bin', 10, 0)))).toBe(HttpStatus.FORBIDDEN);
    // Ни тела, ни строки: отказ, копящий мусор, — это не отказ.
    expect(existsSync(join(dir, 'x.bin'))).toBe(false);
    expect(await db.getRepository(AttachmentRow).count()).toBe(0);
  });

  it('размер ограничен настройкой, а не только потолком процесса', async () => {
    const svc = await makeService('1000000');
    await settings.set('files.maxUploadBytes', 1024, owner);

    await svc.register(put('ровно.bin', 1024, 0));
    expect(await refusalOf(svc.register(put('лишку.bin', 2048, 0)))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
    expect(existsSync(join(dir, 'лишку.bin'))).toBe(false);
  });

  it('смена размера действует на том же сервисе, без перезапуска', async () => {
    const svc = await makeService('1000000');
    expect((await svc.register(put('первый.bin', 2048, 0))).size).toBe(2048);

    await settings.set('files.maxUploadBytes', 1024, owner);
    expect(await refusalOf(svc.register(put('второй.bin', 2048, 0)))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  });

  it('запрещённый вид не проходит, и вид считает тот же detectKind', async () => {
    const svc = await makeService('1000000');
    await settings.set('files.allowedKinds', ['image'], owner);

    await svc.register(put('кот.png', 10, 0, 'image/png'));
    expect(await refusalOf(svc.register(put('трек.mp3', 10, 0, 'audio/mpeg')))).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  });

  /**
   * Видов ровно три, и «video» среди них нет: ролик приезжает как `file`.
   * Значит запретить видео этой настройкой нельзя, а снявший «файл» унесёт
   * вместе с роликами и pdf — пусть это скажет тест, а не комментарий.
   */
  it('ролик считается файлом, а не отдельным видом', async () => {
    const svc = await makeService('1000000');
    expect((await svc.register(put('ролик.mp4', 10, 0, 'video/mp4'))).kind).toBe('file');

    await settings.set('files.allowedKinds', ['image', 'audio'], owner);
    expect(await refusalOf(svc.register(put('другой.mp4', 10, 0, 'video/mp4')))).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  });

  it('отказ не спотыкается о тело, которого на диске уже нет', async () => {
    const svc = await makeService('1000000');
    await settings.set('files.uploadsEnabled', false, owner);
    // Файл унесло подметание, пока запрос шёл: отказ от этого не меняется.
    expect(
      await refusalOf(
        svc.register({
          filename: 'призрак.bin',
          originalname: 'призрак.bin',
          size: 10,
          mimetype: 'application/octet-stream',
        }),
      ),
    ).toBe(HttpStatus.FORBIDDEN);
  });
});

describe('гард выключенных загрузок', () => {
  it('пускает, пока загрузки включены', () => {
    expect(new UploadsEnabledGuard(settings).canActivate()).toBe(true);
  });

  it('выключенные — отказ ещё до того, как multer начнёт писать тело', async () => {
    await settings.set('files.uploadsEnabled', false, owner);
    const guard = new UploadsEnabledGuard(settings);
    expect(() => guard.canActivate()).toThrow(HttpException);
    try {
      guard.canActivate();
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });
});

/**
 * Квота каталога переехала из константы в настройку. Проверяем главное: пока
 * панель не открывали, потолок ровно тот же, что был константой, — и что ноль
 * в нём значит «без квоты», а не «ничего не храним».
 */
describe('квота инсталляции — как было', () => {
  it('панель не открывали: потолок — те же 2 ГиБ, что были константой', () => {
    expect(settings.get<number>('files.installQuotaBytes')).toBe(2 * 1024 ** 3);
  });

  it('под ним ничего не вытесняется, сколько бы файлов ни принесли', async () => {
    const svc = untouched();
    await svc.register(put('a.bin', 1000, 300));
    await svc.register(put('b.bin', 1000, 200));
    await svc.sweep();
    expect(existsSync(join(dir, 'a.bin'))).toBe(true);
    expect(existsSync(join(dir, 'b.bin'))).toBe(true);
    expect(warned).not.toHaveBeenCalled();
  });

  it('ноль — без квоты: не вытесняется ничего и никогда', async () => {
    const svc = await makeService('0');
    await svc.register(put('старое.bin', 900, 300));
    await svc.register(put('новое.bin', 900, 10));
    // При потолке в 1000 старое ушло бы (см. соседний describe) — здесь нет.
    await svc.sweep();
    expect(existsSync(join(dir, 'старое.bin'))).toBe(true);
    expect(existsSync(join(dir, 'новое.bin'))).toBe(true);
  });

  it('новый потолок действует на том же сервисе, без перезапуска', async () => {
    const svc = await makeService('0');
    await svc.register(put('старое.bin', 900, 300));
    await svc.register(put('новое.bin', 900, 10));

    await tune(settings, 'files.installQuotaBytes', 1000);
    await svc.sweep();
    expect(existsSync(join(dir, 'старое.bin'))).toBe(false);
    expect(existsSync(join(dir, 'новое.bin'))).toBe(true);
  });
});

/**
 * Суточная квота личности. Её сегодня нет вовсе, поэтому первый вопрос — что
 * ненастроенная инсталляция по-прежнему не считает никого; второй — что
 * настроенная ОТКАЗЫВАЕТ (а не вытесняет чужое) и что отказ остаётся отказом
 * одной загрузки: ни чат, ни уже принятые файлы он не трогает.
 */
describe('квота личности на сутки', () => {
  const кто = { identityId: 'ид-1' };

  it('панель не открывали: столько файлов, сколько принесли', async () => {
    const svc = untouched();
    for (const name of ['1.bin', '2.bin', '3.bin']) {
      await svc.register(put(name, 10 * 1024 ** 2, 0), кто);
    }
    expect(await db.getRepository(AttachmentRow).count()).toBe(3);
  });

  it('за квотой следующий файл отвергается, а принятое остаётся на месте', async () => {
    const svc = untouched();
    await tune(settings, 'files.perIdentityDailyBytes', 1000);
    const channel = await makeChannel();

    const first = await svc.register(put('первый.bin', 600, 0), кто);
    await attachTo(channel, first.id);

    expect(await refusalOf(svc.register(put('второй.bin', 600, 0), кто))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
    // Тела отвергнутого на диске не остаётся, а отправленное в чат живо: отказ
    // одной загрузке не должен уносить с собой чужие вложения и разговор.
    expect(existsSync(join(dir, 'второй.bin'))).toBe(false);
    expect(await svc.exists('первый.bin')).toBe(true);
    expect(await db.getRepository(MessageRow).count()).toBe(1);
  });

  it('ровно по квоте проходит, а следующий байт — уже нет', async () => {
    const svc = untouched();
    await tune(settings, 'files.perIdentityDailyBytes', 1000);
    await svc.register(put('ровно.bin', 1000, 0), кто);
    expect(await refusalOf(svc.register(put('лишку.bin', 1, 0), кто))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  });

  it('квота у каждого своя: сосед не расплачивается за чужие файлы', async () => {
    const svc = untouched();
    await tune(settings, 'files.perIdentityDailyBytes', 1000);
    await svc.register(put('мой.bin', 900, 0), кто);
    await svc.register(put('чужой.bin', 900, 0), { identityId: 'ид-2' });
    expect(await db.getRepository(AttachmentRow).count()).toBe(2);
  });

  it('без личности считает по адресу — иначе квота снимается удалением куки', async () => {
    const svc = untouched();
    await tune(settings, 'files.perIdentityDailyBytes', 1000);
    await svc.register(put('первый.bin', 900, 0), { ip: '10.0.0.1' });
    expect(await refusalOf(svc.register(put('второй.bin', 900, 0), { ip: '10.0.0.1' }))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
    await svc.register(put('соседний.bin', 900, 0), { ip: '10.0.0.2' });
    expect(await svc.exists('соседний.bin')).toBe(true);
  });

  it('сутки скользящие: вчерашнее не занимает сегодняшнюю квоту', async () => {
    // Подменяем ТОЛЬКО часы: настоящие таймеры оставляем, иначе запрос в базу
    // повис бы вместе со всем прогоном.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const svc = untouched();
      await tune(settings, 'files.perIdentityDailyBytes', 1000);
      await svc.register(put('вчерашний.bin', 900, 0), кто);
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      await svc.register(put('сегодняшний.bin', 900, 0), кто);
      expect(await svc.exists('сегодняшний.bin')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Исполняемые файлы. Сегодня `.exe` проходит наравне с pdf — вид у него `file`,
 * и другой проверки на пути нет; настройка её заводит, но не по умолчанию.
 */
describe('исполняемые файлы', () => {
  it('панель не открывали: .exe принимается, как и вчера', async () => {
    const svc = untouched();
    const out = await svc.register(put('утилита.exe', 10, 0, 'application/x-msdownload'));
    expect(out.kind).toBe('file');
    expect(await svc.exists('утилита.exe')).toBe(true);
  });

  it('включённая проверка отвергает по расширению и не оставляет тела', async () => {
    const svc = untouched();
    await tune(settings, 'files.blockExecutables', true);
    expect(await refusalOf(svc.register(put('вирус.exe', 10, 0)))).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
    expect(existsSync(join(dir, 'вирус.exe'))).toBe(false);
  });

  it('смотрит и на тип: имя пишет клиент', async () => {
    const svc = untouched();
    await tune(settings, 'files.blockExecutables', true);
    expect(await refusalOf(svc.register(put('фото.dat', 10, 0, 'application/x-msdownload')))).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  });

  it('решает последнее расширение — так же, как система, которая это запустит', async () => {
    const svc = untouched();
    await tune(settings, 'files.blockExecutables', true);
    // Открывается блокнотом — это текст.
    await svc.register(put('отчёт.exe.txt', 10, 0, 'text/plain'));
    expect(await refusalOf(svc.register(put('скрин.png.exe', 10, 0)))).toBe(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  });

  it('обычное не задевает: pdf и картинка проходят при включённой проверке', async () => {
    const svc = untouched();
    await tune(settings, 'files.blockExecutables', true);
    await svc.register(put('договор.pdf', 10, 0, 'application/pdf'));
    await svc.register(put('кот.png', 10, 0, 'image/png'));
    expect(await db.getRepository(AttachmentRow).count()).toBe(2);
  });
});

describe('срок жизни сироты — настройкой, а не константой', () => {
  it('панель не открывали: сутки, как и было', async () => {
    expect(settings.get<number>('files.orphanSweepHours')).toBe(24);
    const svc = untouched();
    await svc.register(put('вчерашний.bin', 10, 0));
    await ageUpload('вчерашний.bin', 23);
    await svc.sweep();
    expect(existsSync(join(dir, 'вчерашний.bin'))).toBe(true);
  });

  it('короткий срок уносит то, что при суточном ещё жило бы', async () => {
    const svc = untouched();
    await tune(settings, 'files.orphanSweepHours', 1);
    await svc.register(put('двухчасовой.bin', 10, 0));
    await ageUpload('двухчасовой.bin', 2);
    await svc.register(put('свежий.bin', 10, 0));

    await svc.sweep();
    expect(existsSync(join(dir, 'двухчасовой.bin'))).toBe(false);
    expect(existsSync(join(dir, 'свежий.bin'))).toBe(true);
  });
});

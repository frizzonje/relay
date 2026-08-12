import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRow, MessageRow, ServerRow } from './db/entities';
import { resetDatabase, testDatabase } from './db/testing';
import { UploadByteBudget } from './upload.guard';
import { UploadsService, parseBytes } from './uploads';

/**
 * Загрузки — единственный путь, которым посторонний пишет на диск сервера.
 * Проверяем две вещи, которых раньше не было вовсе: потолок на каталог (и то,
 * что вытеснение забирает старое, а не свежее) и бюджет байтов на адрес.
 */

let dir: string;
let warned: ReturnType<typeof vi.spyOn>;
let db: DataSource;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  dir = mkdtempSync(join(tmpdir(), 'relay-uploads-'));
  warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// Каталог и потолок — параметры экземпляра: перезагружать ради них модуль
// нельзя, иначе сущности станут другими классами, чем те, что знает открытое
// соединение с базой.
async function makeService(quota: string) {
  return new UploadsService(db, dir, Number(quota));
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
function put(name: string, size: number, ageSec: number) {
  const full = join(dir, name);
  writeFileSync(full, Buffer.alloc(size));
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(full, when, when);
  return { filename: name, originalname: name, size, mimetype: 'application/octet-stream' };
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

import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadByteBudget } from './upload.guard';
import { parseBytes } from './uploads';

/**
 * Загрузки — единственный путь, которым посторонний пишет на диск сервера.
 * Проверяем две вещи, которых раньше не было вовсе: потолок на каталог (и то,
 * что вытеснение забирает старое, а не свежее) и бюджет байтов на адрес.
 */

let dir: string;
let warned: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-uploads-'));
  warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// UPLOAD_DIR и потолок читаются на импорте модуля — значит и модуль каждому
// тесту нужен свой.
async function makeService(quota: string) {
  vi.resetModules();
  vi.stubEnv('UPLOAD_DIR', dir);
  vi.stubEnv('UPLOAD_MAX_TOTAL_BYTES', quota);
  const mod = await import('./uploads');
  return new mod.UploadsService();
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
    svc.register(put('a.bin', 300, 60));
    svc.register(put('b.bin', 300, 30));
    expect(existsSync(join(dir, 'a.bin'))).toBe(true);
    expect(existsSync(join(dir, 'b.bin'))).toBe(true);
    expect(warned).not.toHaveBeenCalled();
  });

  it('за потолком вытесняет самое старое и говорит об этом', async () => {
    const svc = await makeService('1000');
    svc.register(put('old.bin', 400, 300));
    svc.register(put('mid.bin', 400, 200));
    svc.register(put('new.bin', 400, 10)); // 1200 > 1000

    expect(existsSync(join(dir, 'old.bin'))).toBe(false);
    expect(existsSync(join(dir, 'mid.bin'))).toBe(true);
    expect(existsSync(join(dir, 'new.bin'))).toBe(true);
    // Пропавшие вложения без строчки в логе выглядели бы как поломка.
    expect(warned).toHaveBeenCalled();
  });

  it('свежую загрузку не вытесняет, даже если она одна и не влезает', async () => {
    const svc = await makeService('100');
    svc.register(put('big.bin', 500, 0));
    // Отдать ссылку и тут же удалить файл — худшее из поведений.
    expect(existsSync(join(dir, 'big.bin'))).toBe(true);
  });

  it('метаданные вытесненного забываются вместе с файлом', async () => {
    const svc = await makeService('1000');
    svc.register(put('old.bin', 900, 300));
    svc.register(put('new.bin', 900, 10));
    expect(svc.get('old.bin')).toBeUndefined();
    expect(svc.get('new.bin')).toBeDefined();
  });

  it('файлы прошлого процесса считаются: рестарт не обнуляет квоту', async () => {
    const svc = await makeService('1000');
    // Метаданные живут в памяти и рестарта не переживают, а файлы остаются.
    // Не заметить их значит начинать отсчёт заново после каждого рестарта —
    // то есть не иметь потолка вообще.
    put('orphan-1.bin', 600, 300);
    put('orphan-2.bin', 600, 200);

    svc.onModuleInit(); // старт api: подметание считает каталог с диска
    expect(existsSync(join(dir, 'orphan-1.bin'))).toBe(false); // 1200 > 1000
    expect(existsSync(join(dir, 'orphan-2.bin'))).toBe(true);

    svc.register(put('new.bin', 500, 0)); // 600 + 500 — снова за потолком
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

    svc.onModuleInit(); // подметание по TTL + квота
    expect(existsSync(registry)).toBe(true);
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

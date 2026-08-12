import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRegistry, saveRegistry } from './registry';

/**
 * Реестр — единственное хранилище api до 1.0, поэтому проверяем не «читается ли
 * файл», а то, чем кончаются плохие дни: битый файл, обрезанный до нуля файл,
 * отсутствующая копия. Ни один из них не должен заканчиваться тихой потерей.
 */

let dir: string;
let file: string;
// Крик в лог — часть требования, а не побочный эффект: ровно его отсутствие и
// делало потерю реестра тихой. Поэтому не просто глушим, а считаем.
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-registry-'));
  file = join(dir, 'registry.json');
  logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = {
  servers: [{ id: 'srv-1', name: 'своё', removable: true, passwordHash: 'a:b' }],
  channels: [
    {
      id: 'ch-1',
      serverId: 'srv-1',
      type: 'text' as const,
      name: 'общий',
      slug: 'obshchii',
      removable: true,
    },
  ],
};

describe('loadRegistry', () => {
  it('файла нет (первая установка) — пустой реестр без следов ЧП', () => {
    const out = loadRegistry(file);
    expect(out.data).toEqual({});
    expect(out.corruptCopy).toBeUndefined();
    expect(out.fromBackup).toBeUndefined();
    // Первая установка — не повод пугать администратора.
    expect(logged).not.toHaveBeenCalled();
  });

  it('целый файл читается как есть', () => {
    writeFileSync(file, JSON.stringify(SAMPLE));
    expect(loadRegistry(file).data).toEqual(SAMPLE);
    expect(logged).not.toHaveBeenCalled();
  });

  it('битый файл откладывается в сторону, а не переживается молча', () => {
    writeFileSync(file, '{"servers": [{"id":');
    const out = loadRegistry(file);
    expect(out.data).toEqual({});
    expect(out.corruptCopy).toBeDefined();
    expect(logged).toHaveBeenCalled();
    // Исходные байты целы — по ним и восстанавливают руками.
    expect(readFileSync(out.corruptCopy!, 'utf8')).toBe('{"servers": [{"id":');
    // И основного файла больше нет: перезаписывать теперь нечего.
    expect(readdirSync(dir).includes('registry.json')).toBe(false);
  });

  it('файл нулевой длины (пропадание питания) — тот же путь, не «пустой реестр»', () => {
    writeFileSync(file, '');
    const out = loadRegistry(file);
    expect(out.corruptCopy).toBeDefined();
  });

  it('правильный JSON, но не наш (servers не массив) — тоже битый', () => {
    writeFileSync(file, JSON.stringify({ servers: 42 }));
    expect(loadRegistry(file).corruptCopy).toBeDefined();
  });

  it('пустой объект — законный реестр, не порча', () => {
    writeFileSync(file, '{}');
    const out = loadRegistry(file);
    expect(out.data).toEqual({});
    expect(out.corruptCopy).toBeUndefined();
  });

  it('битый файл + годная прошлая копия — поднимаемся из копии', () => {
    writeFileSync(file + '.bak', JSON.stringify(SAMPLE));
    writeFileSync(file, 'мусор');
    const out = loadRegistry(file);
    expect(out.data).toEqual(SAMPLE);
    expect(out.fromBackup).toBe(true);
    expect(out.corruptCopy).toBeDefined();
  });

  it('битые и файл, и копия — пустой реестр, но оба остаются на диске', () => {
    writeFileSync(file + '.bak', 'тоже мусор');
    writeFileSync(file, 'мусор');
    const out = loadRegistry(file);
    expect(out.data).toEqual({});
    expect(out.fromBackup).toBeUndefined();
    expect(readFileSync(out.corruptCopy!, 'utf8')).toBe('мусор');
    expect(readFileSync(file + '.bak', 'utf8')).toBe('тоже мусор');
  });
});

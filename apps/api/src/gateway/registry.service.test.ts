import { Logger } from '@nestjs/common';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ChannelRow, ServerRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { RegistryService } from './registry.service';

/**
 * Переезд реестра с 0.x — единственная в 1.0 операция, которая делается один
 * раз и на живой инсталляции. Ошибиться в ней означает либо потерять чужие
 * серверы, либо воскресить удалённые, либо упереться в уникальный индекс на
 * старте и не подняться вовсе.
 *
 * Проверяем именно это, а не «читается ли файл» (для файла есть registry.test).
 */

let dir: string;
let db: DataSource;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  dir = mkdtempSync(join(tmpdir(), 'relay-registry-svc-'));
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const FILE = () => join(dir, 'registry.json');
const MARKER = () => FILE() + '.migrated';

/** Сервис поверх своего каталога: пути старого реестра он принимает сам. */
async function makeRegistry() {
  const registry = new RegistryService(db, FILE(), MARKER());
  await registry.onModuleInit();
  return registry;
}

function writeLegacy(data: unknown) {
  writeFileSync(FILE(), JSON.stringify(data));
}

const SAVED = {
  servers: [{ id: 'srv', name: 'своё', removable: true, creatorId: 'dev-1' }],
  channels: [
    {
      id: 'ch-1',
      serverId: 'srv',
      type: 'text',
      name: 'болталка',
      slug: 'boltalka',
      removable: true,
    },
  ],
};

describe('переезд registry.json в базу', () => {
  it('переносит серверы и каналы и оставляет исходный файл нетронутым', async () => {
    writeLegacy(SAVED);
    const before = readFileSync(FILE(), 'utf8');
    const registry = await makeRegistry();

    expect(registry.servers.map((s) => s.id)).toEqual(['relay-main', 'srv']);
    expect(registry.channels.find((c) => c.id === 'ch-1')?.slug).toBe('boltalka');
    expect(await db.getRepository(ServerRow).findOneBy({ id: 'srv' })).toMatchObject({
      name: 'своё',
      creatorId: 'dev-1',
    });

    // Цена отката: файл — единственное, из чего 0.x поднимется обратно.
    expect(readFileSync(FILE(), 'utf8')).toBe(before);
    expect(existsSync(MARKER())).toBe(true);
  });

  it('второй старт ничего не воскрешает — маркер сильнее файла', async () => {
    writeLegacy(SAVED);
    const first = await makeRegistry();
    await first.flush();

    // Человек удалил сервер уже в 1.0.
    first.servers.splice(
      first.servers.findIndex((s) => s.id === 'srv'),
      1,
    );
    first.channels.length = 0;
    await first.persist();

    const second = await makeRegistry();
    expect(second.servers.map((s) => s.id)).toEqual(['relay-main']);
    expect(second.channels.some((c) => c.id === 'ch-1')).toBe(false);
  });

  it('разводит одинаковые слаги: до 1.0 они делили комнату и ленту', async () => {
    writeLegacy({
      servers: [
        { id: 'a', name: 'первый', removable: true },
        { id: 'b', name: 'второй', removable: true },
      ],
      channels: [
        { id: 'c1', serverId: 'a', type: 'text', name: 'чат', slug: 'chat', removable: true },
        { id: 'c2', serverId: 'b', type: 'text', name: 'чат', slug: 'chat', removable: true },
      ],
    });
    const registry = await makeRegistry();
    const slugs = registry.channels.filter((c) => c.id.startsWith('c')).map((c) => c.slug);
    expect(slugs).toEqual(['chat', 'chat-2']);
  });

  it('канал без своего сервера не переезжает — ему негде висеть', async () => {
    writeLegacy({
      servers: [],
      channels: [
        { id: 'orphan', serverId: 'нет', type: 'text', name: 'висяк', slug: 'v', removable: true },
      ],
    });
    const registry = await makeRegistry();
    expect(registry.channels.some((c) => c.id === 'orphan')).toBe(false);
    expect(await db.getRepository(ChannelRow).countBy({ id: 'orphan' })).toBe(0);
  });

  it('файла нет — обычная первая установка, маркер не выдумываем', async () => {
    const registry = await makeRegistry();
    expect(registry.servers.map((s) => s.id)).toEqual(['relay-main']);
    expect(existsSync(MARKER())).toBe(false);
  });

  it('битый файл не роняет старт: реестр поднимается с дефолтами', async () => {
    writeFileSync(FILE(), '{"servers": [{');
    const registry = await makeRegistry();
    expect(registry.servers.map((s) => s.id)).toEqual(['relay-main']);
  });
});

describe('запись реестра', () => {
  it('дефолты доезжают до базы сами, без единой правки от человека', async () => {
    const registry = await makeRegistry();
    await registry.flush();
    expect(await db.getRepository(ServerRow).countBy({ id: 'relay-main' })).toBe(1);
    expect(await db.getRepository(ChannelRow).count()).toBe(registry.channels.length);
  });

  it('исчезнувшее из памяти исчезает и из базы', async () => {
    const registry = await makeRegistry();
    registry.servers.push({ id: 'tmp', name: 'на минуту', removable: true });
    await registry.persist();
    expect(await db.getRepository(ServerRow).countBy({ id: 'tmp' })).toBe(1);

    registry.servers.pop();
    await registry.persist();
    expect(await db.getRepository(ServerRow).countBy({ id: 'tmp' })).toBe(0);
  });

  it('порядок рейки переживает рестарт', async () => {
    const registry = await makeRegistry();
    registry.servers.push({ id: 'first', name: 'первый', removable: true });
    registry.servers.push({ id: 'second', name: 'второй', removable: true });
    await registry.persist();

    const again = await makeRegistry();
    expect(again.servers.map((s) => s.id)).toEqual(['relay-main', 'first', 'second']);
  });

  it('две записи подряд не гоняются наперегонки', async () => {
    const registry = await makeRegistry();
    registry.servers.push({ id: 'one', name: '1', removable: true });
    const a = registry.persist();
    registry.servers.push({ id: 'two', name: '2', removable: true });
    const b = registry.persist();
    await Promise.all([a, b]);

    // Обе записи — полные снимки; выстроенные в очередь, они дают последний.
    expect((await db.getRepository(ServerRow).find()).map((s) => s.id).sort()).toEqual([
      'one',
      'relay-main',
      'two',
    ]);
  });
});

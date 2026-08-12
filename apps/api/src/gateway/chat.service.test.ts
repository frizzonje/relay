import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AttachmentRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { ChatService, PAGE_SIZE, isUuid } from './chat.service';
import { RegistryService } from './registry.service';

/**
 * История чата — то, ради чего в 1.0 вообще появилась база. Проверяем не «есть
 * ли строки в таблице», а обещания, которые видит человек: переписка переживает
 * рестарт, лента листается вверх без потерь и повторов, цитата не меняется
 * задним числом, а мусор в поле id не роняет сервер.
 */

const NOWHERE = '/nonexistent/relay/registry.json';

let db: DataSource;
let registry: RegistryService;
let chat: ChatService;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
  registry = new RegistryService(db, NOWHERE, NOWHERE + '.migrated');
  await registry.onModuleInit();
  chat = new ChatService(db, registry);
  await chat.onModuleInit();
});

/** Свежий сервис поверх той же базы — то же самое, что рестарт процесса. */
async function restart(): Promise<ChatService> {
  const again = new RegistryService(db, NOWHERE, NOWHERE + '.migrated');
  await again.onModuleInit();
  const service = new ChatService(db, again);
  await service.onModuleInit();
  return service;
}

async function say(text: string, name = 'А') {
  const msg = await chat.add('obshchii', { name, text });
  if (!msg) throw new Error('канал obshchii не найден');
  return msg;
}

describe('переписка переживает рестарт', () => {
  it('сообщение читается новым процессом', async () => {
    await say('привет');
    const after = await restart();
    expect((await after.history('obshchii')).messages.map((m) => m.text)).toEqual(['привет']);
  });

  it('и реакции вместе с ним', async () => {
    const msg = await say('привет');
    await chat.saveReactions(msg.id!, { '👍': ['Б'] });

    const after = await restart();
    const [restored] = (await after.history('obshchii')).messages;
    expect(restored.reactions).toEqual({ '👍': ['Б'] });
  });

  it('время последней реплики известно сразу, без первой новой', async () => {
    const msg = await say('привет');
    const after = await restart();
    // По этому времени сайдбар зажигает «непрочитано» — если кэш не прогреть,
    // все каналы после рестарта выглядят так, будто в них никогда не писали.
    expect(after.lastTs('obshchii')).toBe(msg.ts);
  });
});

describe('страницы ленты', () => {
  beforeEach(async () => {
    for (let i = 0; i < PAGE_SIZE + 10; i += 1) await say(`${i}`);
  });

  it('вход в канал отдаёт последнюю страницу и честное «выше есть ещё»', async () => {
    const page = await chat.history('obshchii');
    expect(page.messages).toHaveLength(PAGE_SIZE);
    expect(page.messages[0].text).toBe('10');
    expect(page.messages[PAGE_SIZE - 1].text).toBe(`${PAGE_SIZE + 9}`);
    expect(page.more).toBe(true);
  });

  it('подгрузка вверх не теряет и не повторяет', async () => {
    const page = await chat.history('obshchii');
    const top = page.messages[0];
    const older = await chat.older('obshchii', top.ts, top.id!);

    expect(older.messages.map((m) => m.text)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(older.more).toBe(false);
    // Ни одного повтора между страницами: курсор берёт строго то, что выше.
    const ids = new Set([...page.messages, ...older.messages].map((m) => m.id));
    expect(ids.size).toBe(PAGE_SIZE + 10);
  });

  it('реплики одной миллисекунды не теряются на границе страницы', async () => {
    // Курсор из одного времени схлопнул бы их: в базе они неразличимы по ts.
    await db.query("UPDATE messages SET created_at = '2020-01-01T00:00:00Z'");
    const fresh = await restart();
    const page = await fresh.history('obshchii');
    const older = await fresh.older('obshchii', page.messages[0].ts, page.messages[0].id!);
    const ids = new Set([...page.messages, ...older.messages].map((m) => m.id));
    expect(ids.size).toBe(PAGE_SIZE + 10);
  });
});

describe('цитата', () => {
  it('снимок не меняется, когда правят оригинал', async () => {
    const src = await say('исходное');
    const reply = await chat.add('obshchii', { name: 'Б', text: 'ответ', replyToId: src.id });
    expect(reply?.replyTo).toEqual({ id: src.id, name: 'А', text: 'исходное' });

    await chat.edit(src.id!, 'переписал');
    const fresh = await restart();
    const [, restored] = (await fresh.history('obshchii')).messages;
    expect(restored.replyTo?.text).toBe('исходное');
  });

  it('цитата переживает удаление оригинала', async () => {
    const src = await say('исходное');
    const reply = await chat.add('obshchii', { name: 'Б', text: 'ответ', replyToId: src.id });
    await chat.remove(src.id!);

    const fresh = await restart();
    const [restored] = (await fresh.history('obshchii')).messages;
    expect(restored.id).toBe(reply!.id);
    expect(restored.replyTo?.text).toBe('исходное');
  });

  it('ответ на чужой канал цитаты не даёт', async () => {
    const src = await say('исходное');
    registry.channels.push({
      id: 'other',
      serverId: 'relay-main',
      type: 'text',
      name: 'другой',
      slug: 'drugoi',
      removable: true,
    });
    await registry.persist();

    const reply = await chat.add('drugoi', { name: 'Б', text: 'ответ', replyToId: src.id });
    expect(reply?.replyTo).toBeUndefined();
  });
});

describe('вложение', () => {
  it('прицепляется по id загрузки, а не по тому, что прислал клиент', async () => {
    await db.getRepository(AttachmentRow).insert({
      id: 'up-1',
      name: 'кот.png',
      size: 10,
      mime: 'image/png',
      kind: 'image',
    });
    const msg = await chat.add('obshchii', { name: 'А', text: '', uploadId: 'up-1' });
    expect(msg?.attachment).toMatchObject({ url: '/uploads/up-1', mime: 'image/png' });

    const nothing = await chat.add('obshchii', { name: 'А', text: 'без файла', uploadId: 'нет' });
    expect(nothing?.attachment).toBeUndefined();
  });

  it('спойлер — метка сообщения: тот же файл можно послать и так, и так', async () => {
    await db.getRepository(AttachmentRow).insert({
      id: 'up-1',
      name: 'кот.png',
      size: 10,
      mime: 'image/png',
      kind: 'image',
    });
    const hidden = await chat.add('obshchii', { name: 'А', text: '', uploadId: 'up-1', spoiler: true });
    const open = await chat.add('obshchii', { name: 'А', text: '', uploadId: 'up-1' });
    expect(hidden?.attachment?.spoiler).toBe(true);
    expect(open?.attachment?.spoiler).toBeUndefined();
  });
});

describe('мусор от клиента', () => {
  it('id не той формы — пустой ответ, а не ошибка базы', async () => {
    // uuid-колонка отвечает на «не-uuid» не пустотой, а 22P02: без проверки
    // одна строка в теле сообщения роняла бы обработчик.
    expect(isUuid('нет-такого')).toBe(false);
    await expect(chat.find('obshchii', 'нет-такого')).resolves.toBeUndefined();
    await expect(chat.findAny('obshchii', '../../etc')).resolves.toBeUndefined();
    await expect(chat.remove('нет-такого')).resolves.toBe(false);
    await expect(chat.older('obshchii', Date.now(), 'мусор')).resolves.toEqual({
      messages: [],
      more: false,
    });
  });

  it('несуществующий канал — не место для реплики', async () => {
    await expect(chat.add('нет-такого', { name: 'А', text: 'ау' })).resolves.toBeUndefined();
    await expect(chat.history('нет-такого')).resolves.toEqual({ messages: [], more: false });
    await expect(chat.count('нет-такого')).resolves.toBe(0);
  });
});

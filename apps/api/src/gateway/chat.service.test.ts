import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AttachmentRow, IdentityRow, MessageRow, ReadRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import {
  AROUND_HALF,
  ChatService,
  PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  isUuid,
  mentionedIn,
  searchTerms,
} from './chat.service';
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

    expect(older.messages.map((m) => m.text)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
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

describe('поиск по истории', () => {
  /** Второй текстовый канал того же сервера — поиск бывает шире одного канала. */
  async function secondChannel(): Promise<string> {
    registry.channels.push({
      id: 'text-kuhnya',
      serverId: 'relay-main',
      type: 'text',
      name: 'кухня',
      slug: 'kuhnya',
      removable: true,
    });
    await registry.persist();
    return 'text-kuhnya';
  }

  it('находит сказанное по слову', async () => {
    await say('поедем на дачу в субботу');
    await say('а я останусь дома');

    const { hits } = await chat.search(['text-obshchii'], 'дачу');
    expect(hits.map((h) => h.message.text)).toEqual(['поедем на дачу в субботу']);
    expect(hits[0].slug).toBe('obshchii');
  });

  it('слово ищется как начало — окончание набирать не надо', async () => {
    await say('поедем на дачу');
    // Без стемминга «дач» не нашло бы ничего, и человек, набравший половину
    // слова, решил бы, что разговора не было.
    const { hits } = await chat.search(['text-obshchii'], 'дач');
    expect(hits).toHaveLength(1);
  });

  it('несколько слов — все обязательны, и порядок им не важен', async () => {
    await say('поедем на дачу в субботу');
    await say('дачу продали');

    expect((await chat.search(['text-obshchii'], 'суббота дача')).hits).toHaveLength(0);
    expect((await chat.search(['text-obshchii'], 'субботу дачу')).hits).toHaveLength(1);
  });

  it('регистр не важен', async () => {
    await say('Поедем на Дачу');
    expect((await chat.search(['text-obshchii'], 'ДАЧУ')).hits).toHaveLength(1);
  });

  it('ищет по нескольким каналам и говорит, в каком нашлось', async () => {
    const kuhnya = await secondChannel();
    await say('дачу видно отсюда');
    await chat.add('kuhnya', { name: 'Б', text: 'а с дачи не видно' });

    const { hits } = await chat.search(['text-obshchii', kuhnya], 'дач');
    expect(hits.map((h) => h.slug).sort()).toEqual(['kuhnya', 'obshchii']);
  });

  it('канал, которого нет в списке, молчит', async () => {
    const kuhnya = await secondChannel();
    await chat.add('kuhnya', { name: 'Б', text: 'секрет кухни' });
    // Права считает гейтвей и передаёт готовым списком: канал не в списке —
    // его реплики не существуют, а не «существуют, но не показываются».
    expect((await chat.search(['text-obshchii'], 'секрет')).hits).toHaveLength(0);
    expect((await chat.search([kuhnya], 'секрет')).hits).toHaveLength(1);
  });

  it('свежее первым, и страница листается курсором', async () => {
    for (let i = 0; i < SEARCH_PAGE_SIZE + 3; i += 1) await say(`дача номер ${i}`);

    const first = await chat.search(['text-obshchii'], 'дача');
    expect(first.hits).toHaveLength(SEARCH_PAGE_SIZE);
    expect(first.hits[0].message.text).toBe(`дача номер ${SEARCH_PAGE_SIZE + 2}`);
    expect(first.more).toBe(true);

    const last = first.hits[first.hits.length - 1].message;
    const second = await chat.search(['text-obshchii'], 'дача', { ts: last.ts, id: last.id! });
    expect(second.hits.map((h) => h.message.text)).toEqual([
      'дача номер 2',
      'дача номер 1',
      'дача номер 0',
    ]);
    expect(second.more).toBe(false);
  });

  it('системные строки не находятся — человек ищет сказанное людьми', async () => {
    await db.getRepository(MessageRow).insert({
      id: randomUUID(),
      channelId: 'text-obshchii',
      authorName: 'relay',
      text: 'история дачи истекла',
      system: true,
      spoiler: false,
      reactions: {},
    });
    expect((await chat.search(['text-obshchii'], 'дачи')).hits).toHaveLength(0);
  });

  it('синтаксис tsquery в запросе — это просто текст', async () => {
    await say('дача & огород');
    // Без разбора запрос вроде «& |» уехал бы в to_tsquery как выражение, и
    // человек получил бы не пустой результат, а ошибку базы.
    await expect(chat.search(['text-obshchii'], '& | ! ( )')).resolves.toEqual({
      hits: [],
      more: false,
    });
    expect((await chat.search(['text-obshchii'], 'дача & огород')).hits).toHaveLength(1);
  });

  it('пустой запрос и пустой список каналов ничего не ищут', async () => {
    await say('дача');
    await expect(chat.search(['text-obshchii'], '   ')).resolves.toEqual({
      hits: [],
      more: false,
    });
    await expect(chat.search([], 'дача')).resolves.toEqual({ hits: [], more: false });
  });

  it('слова запроса — то, чем потом подсвечивают', () => {
    expect(searchTerms('  Дачу,  в СУББОТУ!  ')).toEqual(['дачу', 'в', 'субботу']);
    expect(searchTerms('***')).toEqual([]);
  });
});

describe('переход к найденному', () => {
  beforeEach(async () => {
    for (let i = 0; i < AROUND_HALF * 3; i += 1) await say(`${i}`);
  });

  it('окно показывает соседей сверху и снизу', async () => {
    const { messages } = await chat.history('obshchii');
    const target = messages[messages.length - 1];
    // Целимся в середину истории — как из результата поиска по старому.
    const middle = (await chat.older('obshchii', target.ts, target.id!)).messages[10];

    const window = await chat.around('obshchii', middle.id!);
    const texts = window.messages.map((m) => m.text);
    expect(texts).toContain(middle.text);
    expect(texts).toHaveLength(AROUND_HALF * 2 + 1);
    expect(window.more).toBe(true);
    expect(window.moreAfter).toBe(true);
  });

  it('у конца канала низа нет', async () => {
    const { messages } = await chat.history('obshchii');
    const last = messages[messages.length - 1];

    const window = await chat.around('obshchii', last.id!);
    expect(window.moreAfter).toBe(false);
    expect(window.messages[window.messages.length - 1].id).toBe(last.id);
  });

  it('реплику удалили, пока читали результаты — окно пустое, а не чужое', async () => {
    const { messages } = await chat.history('obshchii');
    const doomed = messages[messages.length - 1];
    await chat.remove(doomed.id!);

    await expect(chat.around('obshchii', doomed.id!)).resolves.toEqual({
      messages: [],
      more: false,
      moreAfter: false,
    });
    await expect(chat.around('obshchii', 'мусор')).resolves.toEqual({
      messages: [],
      more: false,
      moreAfter: false,
    });
  });

  it('подгрузка вниз не теряет и не повторяет', async () => {
    const { messages } = await chat.history('obshchii');
    const oldest = (await chat.older('obshchii', messages[0].ts, messages[0].id!)).messages[0];

    const down = await chat.newer('obshchii', oldest.ts, oldest.id!);
    expect(down.messages).toHaveLength(PAGE_SIZE);
    expect(down.messages[0].text).toBe('1');
    expect(down.moreAfter).toBe(true);
    expect(down.messages.some((m) => m.id === oldest.id)).toBe(false);
  });

  it('дно ленты — честное «дальше ничего»', async () => {
    const { messages } = await chat.history('obshchii');
    const last = messages[messages.length - 1];
    await expect(chat.newer('obshchii', last.ts, last.id!)).resolves.toEqual({
      messages: [],
      more: false,
      moreAfter: false,
    });
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
    const hidden = await chat.add('obshchii', {
      name: 'А',
      text: '',
      uploadId: 'up-1',
      spoiler: true,
    });
    const open = await chat.add('obshchii', { name: 'А', text: '', uploadId: 'up-1' });
    expect(hidden?.attachment?.spoiler).toBe(true);
    expect(open?.attachment?.spoiler).toBeUndefined();
  });
});

describe('упоминания', () => {
  /** Личность в базе — упоминание адресует её, а не написанное имя. */
  async function person(nick: string): Promise<{ id: string; fingerprint: string; nick: string }> {
    const id = randomUUID();
    const key = randomUUID().replace(/-/g, '');
    const fingerprint = key.slice(0, 16);
    await db.getRepository(IdentityRow).insert({
      id,
      publicKey: key,
      fingerprint,
      nick,
      createdAt: new Date(),
      lastSeenAt: null,
    });
    return { id, fingerprint, nick };
  }

  /** Второй текстовый канал: счётчик считает по каналам, а не общей кучей. */
  async function secondChannel(): Promise<void> {
    registry.channels.push({
      id: 'text-kuhnya',
      serverId: 'relay-main',
      type: 'text',
      name: 'кухня',
      slug: 'kuhnya',
      removable: true,
    });
    await registry.persist();
  }

  describe('названным считается только написанный', () => {
    it('имя в тексте — упоминание; имени нет — нет и упоминания', () => {
      const anya = { fingerprint: 'f-anya', nick: 'Аня' };
      const boris = { fingerprint: 'f-boris', nick: 'Борис' };
      // Клиент назвал обоих, а написал одного: беззвучный вызов — не вызов.
      expect(mentionedIn('@Аня, ты идёшь?', [anya, boris])).toEqual([anya]);
    });

    it('регистр не важен — написавший «@аня» позвал Аню и знает это', () => {
      const anya = { fingerprint: 'f-anya', nick: 'Аня' };
      expect(mentionedIn('привет, @аня', [anya])).toEqual([anya]);
    });

    it('ник с пробелом ищется целиком, а не по первому слову', () => {
      const anya = { fingerprint: 'f-anya', nick: 'Аня К' };
      expect(mentionedIn('@Аня К, привет', [anya])).toEqual([anya]);
      expect(mentionedIn('@Аня, привет', [anya])).toEqual([]);
    });

    it('один и тот же человек, названный дважды, — одно упоминание', () => {
      const anya = { fingerprint: 'f-anya', nick: 'Аня' };
      expect(mentionedIn('@Аня @Аня', [anya, anya])).toHaveLength(1);
    });

    it('больше восьми имён в одной реплике не носим', () => {
      const many = Array.from({ length: 20 }, (_, i) => ({
        fingerprint: `f-${i}`,
        nick: `имя${i}`,
      }));
      expect(mentionedIn(many.map((p) => '@' + p.nick).join(' '), many)).toHaveLength(8);
    });
  });

  it('упоминание уезжает с репликой и переживает рестарт', async () => {
    const anya = await person('Аня');
    const msg = await chat.add('obshchii', {
      name: 'Борис',
      text: '@Аня, ты идёшь?',
      mentions: [{ fingerprint: anya.fingerprint, nick: anya.nick }],
    });
    expect(msg?.mentions).toEqual([{ fingerprint: anya.fingerprint, nick: anya.nick }]);

    const after = await restart();
    const [restored] = (await after.history('obshchii')).messages;
    expect(restored.mentions).toEqual([{ fingerprint: anya.fingerprint, nick: anya.nick }]);
  });

  it('реплика без упоминаний ключа не носит вовсе', async () => {
    const msg = await say('просто текст');
    expect(msg.mentions).toBeUndefined();
  });

  it('правка переписывает упоминания вместе с текстом', async () => {
    const anya = await person('Аня');
    const msg = await chat.add('obshchii', {
      name: 'Борис',
      text: '@Аня, ты идёшь?',
      mentions: [{ fingerprint: anya.fingerprint, nick: anya.nick }],
    });
    // Имя убрали — упоминание обязано уйти с ним: иначе счётчик у Ани горел бы
    // из-за реплики, в которой её больше нет.
    await chat.edit(msg!.id!, 'а вообще неважно', []);
    const [edited] = (await chat.history('obshchii')).messages;
    expect(edited.mentions).toBeUndefined();
  });

  it('ник в снимке берётся из базы, а не из тела сообщения', async () => {
    const anya = await person('Аня');
    const found = await chat.peopleByFingerprint([anya.fingerprint]);
    expect(found).toEqual([{ fingerprint: anya.fingerprint, nick: 'Аня' }]);
  });

  describe('счётчик непрочитанных упоминаний', () => {
    it('считает названное после отметки чтения и по каналам врозь', async () => {
      const anya = await person('Аня');
      const boris = await person('Борис');
      await secondChannel();
      const mention = [{ fingerprint: anya.fingerprint, nick: anya.nick }];

      await chat.add('obshchii', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня раз',
        mentions: mention,
      });
      await chat.add('obshchii', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня два',
        mentions: mention,
      });
      await chat.add('kuhnya', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня три',
        mentions: mention,
      });

      const counts = await chat.mentionCounts(anya.id, anya.fingerprint);
      expect(counts.get('text-obshchii')).toBe(2);
      expect(counts.get('text-kuhnya')).toBe(1);
    });

    it('дочитанный канал гасит свой счётчик', async () => {
      const anya = await person('Аня');
      const boris = await person('Борис');
      const mention = [{ fingerprint: anya.fingerprint, nick: anya.nick }];
      const first = await chat.add('obshchii', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня раз',
        mentions: mention,
      });
      await db
        .getRepository(ReadRow)
        .insert({ identityId: anya.id, channelId: 'text-obshchii', readAt: new Date(first!.ts) });

      expect((await chat.mentionCounts(anya.id, anya.fingerprint)).get('text-obshchii')).toBe(
        undefined,
      );

      await chat.add('obshchii', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня два',
        mentions: mention,
      });
      expect((await chat.mentionCounts(anya.id, anya.fingerprint)).get('text-obshchii')).toBe(1);
    });

    it('своё имя в своей реплике себя не зовёт', async () => {
      const anya = await person('Аня');
      await chat.add('obshchii', {
        name: 'Аня',
        identityId: anya.id,
        text: 'меня зовут @Аня',
        mentions: [{ fingerprint: anya.fingerprint, nick: anya.nick }],
      });
      expect((await chat.mentionCounts(anya.id, anya.fingerprint)).size).toBe(0);
    });

    it('удалённая реплика уносит упоминание с собой', async () => {
      const anya = await person('Аня');
      const boris = await person('Борис');
      const msg = await chat.add('obshchii', {
        name: 'Борис',
        identityId: boris.id,
        text: '@Аня',
        mentions: [{ fingerprint: anya.fingerprint, nick: anya.nick }],
      });
      await chat.remove(msg!.id!);
      expect((await chat.mentionCounts(anya.id, anya.fingerprint)).size).toBe(0);
    });
  });

  describe('кого предлагать после «@»', () => {
    it('говоривших в этих каналах, от недавних к давним', async () => {
      const anya = await person('Аня');
      const boris = await person('Борис');
      await chat.add('obshchii', { name: 'Аня', identityId: anya.id, text: 'раз' });
      await chat.add('obshchii', { name: 'Борис', identityId: boris.id, text: 'два' });

      const people = await chat.mentionCandidates(['text-obshchii'], '');
      expect(people.map((p) => p.nick)).toEqual(['Борис', 'Аня']);
    });

    it('по началу имени и не различая регистр', async () => {
      const anya = await person('Аня');
      await person('Борис');
      await chat.add('obshchii', { name: 'Аня', identityId: anya.id, text: 'раз' });

      expect((await chat.mentionCandidates(['text-obshchii'], 'ан')).map((p) => p.nick)).toEqual([
        'Аня',
      ]);
      // Борис в канале не говорил — предлагать его тут не из чего.
      expect(await chat.mentionCandidates(['text-obshchii'], 'бор')).toEqual([]);
    });

    it('один человек — одна строка, сколько бы он ни говорил', async () => {
      const anya = await person('Аня');
      for (let i = 0; i < 5; i += 1) {
        await chat.add('obshchii', { name: 'Аня', identityId: anya.id, text: `${i}` });
      }
      expect(await chat.mentionCandidates(['text-obshchii'], '')).toHaveLength(1);
    });

    it('«%» в набранном — это символ, а не «покажи всех»', async () => {
      const anya = await person('Аня');
      await chat.add('obshchii', { name: 'Аня', identityId: anya.id, text: 'раз' });
      expect(await chat.mentionCandidates(['text-obshchii'], '%')).toEqual([]);
    });

    it('без каналов спрашивать некого', async () => {
      expect(await chat.mentionCandidates([], 'ан')).toEqual([]);
    });
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

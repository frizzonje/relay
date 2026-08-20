import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { issueGuestToken } from '../auth/auth';
import { FakeServer, asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  makeOwner,
  ownServer,
  personCookie,
  say,
  settle,
  slugOf,
  until,
  useGatewayStand,
  type AnyGw,
} from './gateway.testkit';

/**
 * Остаток гейтвея — то, что не принадлежит ни одному владельцу состояния:
 * маршрутизация ответов и личность говорящего.
 *
 * Гейтвей узнаёт человека по куке сессии, а не по тому, как он представился.
 * Разница ровно одна и вся суть в ней: пока имя приходит из тела сообщения,
 * лицо рядом с ним — украшение, потому что назваться чужим можно одним `join`.
 *
 * Владельцы состояния проверяются рядом с собой: `perimeter.test.ts`,
 * `voice-sessions.test.ts`, `chat-sessions.test.ts`, `directory.*.test.ts`,
 * `moderation.test.ts`, `mentions.test.ts`.
 */

useGatewayStand();

describe('voice-diag', () => {
  it('веха клиента уходит в лог одной строкой', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleVoiceDiag(asSocket(a), { event: 'sfu-fallback\nподмена', detail: 'таймаут  ice' });
    const line = log.mock.calls.map((c) => String(c[0])).find((s) => s.includes('diag'));
    expect(line).toBeDefined();
    expect(line).not.toContain('\n');
    expect(line).toContain('таймаут ice');
  });

  it('пустая веха в лог не идёт', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    log.mockClear();
    gw.handleVoiceDiag(asSocket(a), { event: '   ' });
    gw.handleVoiceDiag(asSocket(a), {});
    expect(log.mock.calls.some((c) => String(c[0]).includes('diag'))).toBe(false);
  });
});

// ── Личность ──────────────────────────────────────────────────────────────

/**
 * Гейтвей узнаёт говорящего по куке сессии, а не по тому, как он представился.
 * Разница здесь ровно одна и вся суть в ней: пока имя приходит из тела
 * сообщения, лицо рядом с ним — украшение, потому что назваться чужим именем
 * можно одним `join`.
 */
describe('личность в эфире и в ленте', () => {
  it('имя в голосовом берётся у сервера, а не из тела', async () => {
    const { gw, server } = await makeGateway();
    const { cookie, fingerprint } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();

    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'Самозванец' });

    expect(b.last('peer-joined')).toMatchObject({ name: 'Аня', fingerprint });
    settle();
    const presence = b.last('voice-presence') as Record<
      string,
      { name: string; fingerprint?: string }[]
    >;
    expect(presence['voice-obshchii']).toContainEqual(
      expect.objectContaining({ name: 'Аня', fingerprint }),
    );
  });

  it('реплика уносит с собой отпечаток автора', async () => {
    // Из него рисуется лицо в ленте — и оно должно приезжать с сообщением, а
    // не подбираться клиентом по имени: имена не уникальны.
    const { gw, server } = await makeGateway();
    const { cookie, fingerprint } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Самозванец' });
    a.clear();

    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    expect(a.last('chat')).toMatchObject({ name: 'Аня', fingerprint, text: 'привет' });

    // И в истории тоже: лента открывается ею, а не только живыми событиями.
    const c = await connectAs(gw, server, cookie, { id: 'c' });
    await gw.handleChatJoin(asSocket(c), { room: 'obshchii' });
    const history = c.last('chat-history') as { messages: { fingerprint?: string }[] };
    expect(history.messages.at(-1)?.fingerprint).toBe(fingerprint);
  });

  it('тёзка не правит и не удаляет чужое', async () => {
    // Ровно тот случай, ради которого всё и затевалось: ники не уникальны, и
    // раньше «тот же тег» означало «тот же человек».
    const { gw, server } = await makeGateway();
    const mine = await personCookie('Аня');
    const other = await personCookie('Аня');
    const a = await connectAs(gw, server, mine.cookie, { id: 'a' });
    const b = await connectAs(gw, server, other.cookie, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    await gw.handleChatMessage(asSocket(a), { text: 'моё' });
    const id = (a.last('chat') as { id: string }).id;
    server.clearAll();

    await gw.handleChatEdit(asSocket(b), { id, text: 'подменённое' });
    await gw.handleChatDelete(asSocket(b), { id });
    expect(a.got('chat-edited')).toBe(false);
    expect(a.got('chat-deleted')).toBe(false);

    // А своё — правится: проверка отличает чужое от любого.
    await gw.handleChatEdit(asSocket(a), { id, text: 'поправленное' });
    expect(a.last('chat-edited')).toMatchObject({ id, text: 'поправленное' });
  });

  it('гость по инвайту остаётся при своём имени и без лица', async () => {
    // Ему личность взять неоткуда: ворота инсталляции он не проходил, за него
    // ручается токен приглашения — и подписывать челлендж ему нечем.
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Гость' });
    a.clear();

    await gw.handleChatMessage(asSocket(a), { text: 'здравствуйте' });
    const msg = a.last('chat') as { name: string; fingerprint?: string };
    expect(msg.name).toBe('Гость');
    expect(msg.fingerprint).toBeUndefined();
  });

  it('переименование перечитывает имя из базы, а не верит телу', async () => {
    // `rename` для личности — это «сходите перечитайте», а не «зовите меня
    // так»: имя меняется отдельным запросом, и сокет узнаёт о смене последним.
    const { gw, server, identities } = await makeGateway();
    const { cookie } = await personCookie('Аня');
    const a = await connectAs(gw, server, cookie, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii' });
    b.clear();

    const speaker = a.data.identity as { id: string };
    await identities.rename(speaker.id, 'Аня-Б');
    await gw.handleRename(asSocket(a), { name: 'Королева' });

    expect(b.last('peer-renamed')).toEqual({ id: 'a', name: 'Аня-Б' });
  });
});

describe('личное: непрочитанное и настройки', () => {
  /**
   * Дождаться того, что гейтвей делает после подключения асинхронно (за личным
   * состоянием он ходит в базу). Время здесь поддельное, поэтому крутим его
   * асинхронно: только так настоящий запрос в Postgres успевает вернуться.
   */

  /** Дать случиться всему, что собиралось, — когда ждать нечего по существу. */
  async function quiet(): Promise<void> {
    for (let i = 0; i < 400; i += 1) await vi.advanceTimersByTimeAsync(5);
  }

  /** Подключиться и дождаться, пока приедет снимок личного. */
  async function personal(gw: SignalingGateway, server: FakeServer, cookie: string, id: string) {
    const sock = await connectAs(gw, server, cookie, { id, keep: true });
    await until(() => sock.got('prefs'), `снимок личного для ${id}`);
    sock.clear();
    return sock;
  }

  it('на входе человек получает свои отметки и настройки, а безымянный — ничего', async () => {
    const { gw, server, prefs, reads } = await makeGateway();
    const anya = await personCookie('Аня');
    const channel = (gw as AnyGw).registry.channels.find((c) => c.type === 'text')!;
    await reads.mark(anya.identityId, channel.id, 5_000);
    await prefs.set(anya.identityId, 'sound', [channel.slug]);

    const a = await connectAs(gw, server, anya.cookie, { id: 'a', keep: true });
    await until(() => a.got('prefs'), 'снимок личного');
    // В протоколе канал зовётся слагом, в базе отметка живёт по id: иначе
    // переименование канала объявляло бы его непрочитанным у всех разом.
    expect(a.last('reads')).toEqual({ marks: { [channel.slug]: 5_000 }, full: true });
    expect(a.last('prefs')).toEqual({ values: { sound: [channel.slug] }, full: true });

    // Без личности общего между устройствами нет — и слать нечего.
    const stranger = connect(gw, server, { id: 's' });
    await quiet();
    expect(stranger.got('reads')).toBe(false);
    expect(stranger.got('prefs')).toBe(false);
  });

  it('прочитано на десктопе — прочитано и в браузере, не дожидаясь перезахода', async () => {
    const { gw, server, reads } = await makeGateway();
    const anya = await personCookie('Аня');
    const desktop = await personal(gw, server, anya.cookie, 'desktop');
    const browser = await personal(gw, server, anya.cookie, 'browser');
    const boris = await personal(gw, server, (await personCookie('Борис')).cookie, 'b');

    await gw.handleReadMark(asSocket(desktop), { slug: 'obshchii', ts: 7_000 });

    expect(browser.last('reads')).toEqual({ marks: { obshchii: 7_000 } });
    // Тому, кто это и сделал, эхо ни к чему: у него точка уже погасла.
    expect(desktop.got('reads')).toBe(false);
    // И уж точно не чужому человеку: непрочитанное — личное дело.
    expect(boris.got('reads')).toBe(false);
    const channel = (gw as AnyGw).registry.channels.find((c) => c.slug === 'obshchii')!;
    expect(await reads.marks(anya.identityId)).toEqual(new Map([[channel.id, 7_000]]));
  });

  it('отметка не ходит назад: опоздавшее устройство ничего не зажигает', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await personal(gw, server, anya.cookie, 'a');
    const b = await personal(gw, server, anya.cookie, 'b');

    await gw.handleReadMark(asSocket(a), { slug: 'obshchii', ts: 7_000 });
    b.clear();
    await gw.handleReadMark(asSocket(a), { slug: 'obshchii', ts: 3_000 });
    expect(b.got('reads')).toBe(false);
  });

  it('канал, которого не видно, не дочитать', async () => {
    // Иначе отметки становятся способом перебирать слаги закрытых серверов.
    const { gw, server, reads } = await makeGateway({
      servers: [{ id: 'tайный', name: 'тайный', removable: true, passwordHash: 'x:y' }],
      channels: [
        {
          id: 'c1',
          serverId: 'tайный',
          type: 'text',
          name: 'секрет',
          slug: 'секрет',
          removable: true,
        },
      ],
    });
    const anya = await personCookie('Аня');
    const a = await personal(gw, server, anya.cookie, 'a');

    await gw.handleReadMark(asSocket(a), { slug: 'секрет', ts: 7_000 });
    expect(await reads.marks(anya.identityId)).toEqual(new Map());
  });

  it('настройка с одного устройства доезжает на другое', async () => {
    const { gw, server, prefs } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await personal(gw, server, anya.cookie, 'a');
    const b = await personal(gw, server, anya.cookie, 'b');

    await gw.handlePrefsSet(asSocket(a), { key: 'volume', value: { Борис: { voice: 2 } } });

    expect(b.last('prefs')).toEqual({ values: { volume: { Борис: { voice: 2 } } } });
    expect(await prefs.values(anya.identityId)).toEqual({ volume: { Борис: { voice: 2 } } });
  });

  it('чужой ключ настройки — молчание, а не хранилище', async () => {
    const { gw, server, prefs } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await personal(gw, server, anya.cookie, 'a');
    const b = await personal(gw, server, anya.cookie, 'b');

    await gw.handlePrefsSet(asSocket(a), { key: 'архив', value: 'что угодно' });

    expect(b.got('prefs')).toBe(false);
    expect(await prefs.values(anya.identityId)).toEqual({});
  });

  it('удалённый канал уносит отметки с собой', async () => {
    const { gw, server, reads } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(a), { serverId: 'srv', type: 'text', name: 'болталка' });
    settle();
    await gw.handleReadMark(asSocket(a), { slug: slugOf('болталка'), ts: 7_000 });
    const channel = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('болталка'))!;

    expect(await gw.handleChannelDelete(asSocket(a), { id: channel.id })).toEqual({ ok: true });
    // Каскада у отметок нет намеренно (они не должны запирать удаление канала),
    // значит убрать за собой некому, кроме обработчика удаления.
    expect(await reads.marks(anya.identityId)).toEqual(new Map());
  });
});

describe('поиск по истории', () => {
  /**
   * Сервер с двумя текстовыми каналами и сказанным в обоих — минимум, на
   * котором видно разницу между «искать здесь» и «искать по серверу».
   */
  async function withTalk() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(a), { serverId: 'srv', type: 'text', name: 'болталка' });
    await gw.handleChannelCreate(asSocket(a), { serverId: 'srv', type: 'text', name: 'кухня' });
    settle();

    await gw.handleChatJoin(asSocket(a), { room: slugOf('кухня'), name: 'A' });
    await gw.handleChatMessage(asSocket(a), { text: 'чайник на кухне' });
    await gw.handleChatJoin(asSocket(a), { room: slugOf('болталка'), name: 'A' });
    await gw.handleChatMessage(asSocket(a), { text: 'чайник закипел' });
    return { gw, server, a };
  }

  it('ищет в открытом канале и возвращает слова, которыми подсвечивать', async () => {
    const { gw, a } = await withTalk();
    const res = await gw.handleChatSearch(asSocket(a), { query: 'Чайник', scope: 'channel' });
    expect(res.hits.map((h) => h.message.text)).toEqual(['чайник закипел']);
    expect(res.terms).toEqual(['чайник']);
    expect(res.more).toBe(false);
  });

  it('по серверу — по всем его каналам, а не только по открытому', async () => {
    const { gw, a } = await withTalk();
    const res = await gw.handleChatSearch(asSocket(a), { query: 'чайник', scope: 'server' });
    expect(res.hits.map((h) => h.slug).sort()).toEqual(
      [slugOf('болталка'), slugOf('кухня')].sort(),
    );
  });

  it('чужой сервер в область не попадает', async () => {
    const { gw, server, a } = await withTalk();
    // Главный сервер — соседний: его канал виден всем, но искать по нему,
    // сидя в чужом, никто не просил.
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    await gw.handleChatMessage(asSocket(b), { text: 'чайник общий' });

    const res = await gw.handleChatSearch(asSocket(a), { query: 'чайник', scope: 'server' });
    expect(res.hits.map((h) => h.slug)).not.toContain('obshchii');
  });

  it('канал закрытого сервера не ищется, пока пароль не введён', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'тайны' });
    settle();
    await gw.handleChatJoin(asSocket(owner), { room: slugOf('тайны'), name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'пароль от сейфа' });

    // Чужой сокет сидит в своём канале — область «сервер» считается от него, и
    // чужой закрытый в неё не входит ни при каком запросе.
    const stranger = connect(gw, server, { id: 'stranger' });
    await gw.handleChatJoin(asSocket(stranger), { room: 'obshchii', name: 'Ч' });
    const res = await gw.handleChatSearch(asSocket(stranger), { query: 'сейфа', scope: 'server' });
    expect(res.hits).toEqual([]);
  });

  it('не сидя в канале, искать негде', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    expect(
      await gw.handleChatSearch(asSocket(a), { query: 'что-нибудь', scope: 'server' }),
    ).toEqual({ ok: true, hits: [], more: false, terms: [] });
  });

  it('гость не ищет — он и читать не умеет', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleChatSearch(asSocket(guest), { query: 'всё', scope: 'channel' })).toEqual({
      ok: true,
      hits: [],
      more: false,
      terms: [],
    });
  });

  it('мусор вместо запроса — пустой ответ, а не отказ', async () => {
    const { gw, a } = await withTalk();
    for (const query of ['   ', '***', 42 as unknown as string, undefined]) {
      expect(await gw.handleChatSearch(asSocket(a), { query, scope: 'channel' })).toMatchObject({
        hits: [],
        terms: [],
      });
    }
  });
});

describe('переход к найденному', () => {
  async function withHistory() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    for (let i = 0; i < 5; i += 1) await gw.handleChatMessage(asSocket(a), { text: `${i}` });
    // Историю отдают на входе в канал, и на тот момент её ещё не было —
    // спрашиваем заново, уже со сказанным.
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    const history = a.last('chat-history') as { messages: { id: string; ts: number }[] };
    return { gw, server, a, messages: history.messages };
  }

  it('окно вокруг реплики приходит вместе с ответом на «есть ли ещё снизу»', async () => {
    const { gw, a, messages } = await withHistory();
    const res = await gw.handleChatAround(asSocket(a), { id: messages[0].id });
    expect(res.messages).toHaveLength(5);
    expect(res.more).toBe(false);
    expect(res.moreAfter).toBe(false);
  });

  it('страница вниз идёт от курсора и не повторяет его', async () => {
    const { gw, a, messages } = await withHistory();
    const from = messages[1];
    const res = await gw.handleChatHistoryAfter(asSocket(a), {
      afterTs: from.ts,
      afterId: from.id,
    });
    expect(res.messages.map((m) => m.text)).toEqual(['2', '3', '4']);
  });

  it('вне канала оба запроса пусты, а не ошибочны', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const empty = { ok: true, messages: [], more: false, moreAfter: false };
    expect(await gw.handleChatAround(asSocket(a), { id: randomUUID() })).toEqual(empty);
    expect(
      await gw.handleChatHistoryAfter(asSocket(a), { afterTs: Date.now(), afterId: randomUUID() }),
    ).toEqual(empty);
  });

  it('гостю окно не показывают', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleChatAround(asSocket(guest), { id: randomUUID() })).toEqual({
      ok: true,
      messages: [],
      more: false,
      moreAfter: false,
    });
  });
});

describe('закреплённые', () => {
  /** Свой сервер, канал в нём и чужая реплика — то, что закрепляет хозяйка. */
  async function ownChannel() {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'важное слово');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });
    server.clearAll();
    return { gw, server, h, g, id };
  }

  it('модератор закрепляет, и это видят все в канале', async () => {
    const { gw, h, g, id } = await ownChannel();

    expect(await gw.handleChatPin(asSocket(h), { id, on: true })).toEqual({
      ok: true,
      pinned: true,
      count: 1,
    });
    // Число уезжает готовым: складывать его самому пришлось бы и тому, кто
    // ленту не открывал, — и оно бы разъехалось.
    expect(g.last('chat-pinned')).toEqual({ id, pinned: true, count: 1 });
  });

  it('вошедший видит пометку в ленте и число в шапке', async () => {
    const { gw, server, h, id } = await ownChannel();
    await gw.handleChatPin(asSocket(h), { id, on: true });

    const fresh = connect(gw, server, { id: 'fresh' });
    await gw.handleChatJoin(asSocket(fresh), { room: slugOf('болталка') });
    const page = fresh.last('chat-history') as {
      pins: number;
      messages: { text: string; pinned?: true }[];
    };
    expect(page.pins).toBe(1);
    expect(page.messages[0]).toMatchObject({ text: 'важное слово', pinned: true });
  });

  it('список закреплённого отдаётся по запросу', async () => {
    const { gw, h, g, id } = await ownChannel();
    await gw.handleChatPin(asSocket(h), { id, on: true });

    // Спрашивать может любой, кто в канале: закрепление — то, что канал
    // показывает всем, и прятать его от читателей значило бы прятать шапку.
    const res = (await gw.handleChatPins(asSocket(g), { slug: slugOf('болталка') })) as {
      ok: true;
      pins: { id: string; text: string }[];
    };
    expect(res.ok).toBe(true);
    expect(res.pins.map((m) => m.text)).toEqual(['важное слово']);
  });

  it('спросили про другой канал — отказ, а не чужой список', async () => {
    // Ответ бывает медленнее человека: список канала, из которого он уже ушёл,
    // на экране открытого читался бы как его собственный.
    const { gw, h, id } = await ownChannel();
    await gw.handleChatPin(asSocket(h), { id, on: true });
    expect(await gw.handleChatPins(asSocket(h), { slug: 'obshchii' })).toEqual({ ok: false });
  });

  it('открепление возвращает канал в прежний вид', async () => {
    const { gw, h, g, id } = await ownChannel();
    await gw.handleChatPin(asSocket(h), { id, on: true });

    expect(await gw.handleChatPin(asSocket(h), { id, on: false })).toEqual({
      ok: true,
      pinned: false,
      count: 0,
    });
    expect(g.last('chat-pinned')).toEqual({ id, pinned: false, count: 0 });
    expect(await gw.handleChatPins(asSocket(h), { slug: slugOf('болталка') })).toEqual({
      ok: true,
      slug: slugOf('болталка'),
      pins: [],
    });
  });

  it('не модератору закрепление недоступно — даже своё', async () => {
    const { gw, h, g, id } = await ownChannel();

    // Закрепление меняет канал для всех и вынимает реплику из-под ретенции:
    // это распоряжение чужой историей, а не пометка для себя.
    expect(await gw.handleChatPin(asSocket(g), { id, on: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(h.got('chat-pinned')).toBe(false);
  });

  it('на главном сервере закрепляет только владелец инсталляции', async () => {
    // Создателя у главного сервера нет и быть не может: без владельца там не
    // закрепляет никто, иначе шапка общего канала досталась бы первому вошедшему.
    const { gw, server, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boss = await personCookie('Хозяин');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const id = await say(gw, a, 'obshchii', 'моё слово');

    expect(await gw.handleChatPin(asSocket(a), { id, on: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });

    await makeOwner(owner, boss.identityId);
    const b = await connectAs(gw, server, boss.cookie, { id: 'b' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    expect(await gw.handleChatPin(asSocket(b), { id, on: true })).toMatchObject({ ok: true });
  });

  it('удаление закреплённого само снимает закрепление', async () => {
    const { gw, h, g, id } = await ownChannel();
    await gw.handleChatPin(asSocket(h), { id, on: true });
    g.clear();

    await gw.handleChatDelete(asSocket(h), { id });
    expect(g.last('chat-deleted')).toEqual({ id });
    // Число в шапке про каскад в базе само не узнает.
    expect(g.last('chat-pinned')).toEqual({ id, pinned: false, count: 0 });
  });

  it('удаление незакреплённого лишнего не рассылает', async () => {
    const { gw, h, g, id } = await ownChannel();
    g.clear();
    await gw.handleChatDelete(asSocket(h), { id });
    expect(g.got('chat-pinned')).toBe(false);
  });

  it('несуществующая реплика — «нет такой», а не молчание', async () => {
    const { gw, h } = await ownChannel();
    expect(await gw.handleChatPin(asSocket(h), { id: 'нет-такого', on: true })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await gw.handleChatPin(asSocket(h), { id: 'нет-такого', on: false })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await gw.handleChatPin(asSocket(h), { on: true })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('вне канала и гостю по инвайту закреплять нечего', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    expect(await gw.handleChatPin(asSocket(loner), { id: 'x', on: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleChatPins(asSocket(loner), { slug: 'болталка' })).toEqual({ ok: false });

    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleChatPin(asSocket(guest), { id: 'x', on: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleChatPins(asSocket(guest), { slug: 'болталка' })).toEqual({ ok: false });
  });
});

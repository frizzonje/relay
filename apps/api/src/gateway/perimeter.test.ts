import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGuestToken, issueToken } from '../auth/auth';
import { asSocket } from './testkit';
import { MAIN, connect, makeGateway, settle, useGatewayStand } from './gateway.testkit';

/**
 * Контур доступа: кто это, что ему здесь можно и куда его не пускают.
 *
 * Пароль закрытого сервера запирает не кнопку, а четыре разные двери — реестр
 * каналов, presence, вход в эфир и пропуск в медиасервер, — и любая
 * незапертая обесценивает остальные три. Поэтому все четыре проверяются здесь,
 * рядом, а не там, где стоит соответствующий обработчик.
 */

// Живость медиасервера — сетевой пинг с кэшем на уровне модуля. Кэш пережил бы
// границу теста, поэтому подменяем целиком.
const sfuHealthy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../sfu/sfu-health', () => ({ sfuHealthy }));

useGatewayStand();

beforeEach(() => {
  sfuHealthy.mockResolvedValue(true);
});

// ── Подключение ───────────────────────────────────────────────────────────

describe('подключение', () => {
  it('без пропуска сокет отключают, а не пускают наблюдать', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(true);
    expect(sock.emitted).toHaveLength(0);
  });

  it('с верным пропуском в куке пускают', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    sock.handshake.headers.cookie = `relay_pass=${issueToken().value}`;
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(false);
    expect(sock.got('servers')).toBe(true);
  });

  it('новичок сразу получает реестры и состав эфиров', async () => {
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    expect(sock.emitted.map((e) => e.event)).toEqual(['servers', 'channels', 'voice-presence']);
    expect((sock.last('servers') as { id: string }[]).map((s) => s.id)).toEqual([MAIN]);
    expect((sock.last('channels') as { slug: string }[]).map((c) => c.slug).sort()).toEqual(
      ['obshchii', 'voice-obshchii', 'voice-obshchii-sfu'].sort(),
    );
  });

  it('дефолтный SFU-канал приходит помеченным — иначе клиент не поймёт транспорт', async () => {
    const { gw, server } = await makeGateway();
    const sock = server.connect();
    gw.handleConnection(asSocket(sock));
    const channels = sock.last('channels') as { slug: string; mode?: string }[];
    expect(channels.find((c) => c.slug === 'voice-obshchii-sfu')?.mode).toBe('sfu');
    expect(channels.find((c) => c.slug === 'voice-obshchii')?.mode).toBeUndefined();
  });

  it('гость по инвайту получает только свой эфир — реестров ему не показывают', async () => {
    const { gw, server } = await makeGateway();
    const host = connect(gw, server, { id: 'host' });
    gw.handleJoin(asSocket(host), { room: 'voice-obshchii', name: 'хозяин' });
    settle();

    const { token } = issueGuestToken('voice-obshchii');
    const guest = server.connect({ id: 'guest', auth: { guest: token } });
    gw.handleConnection(asSocket(guest));

    expect(guest.emitted.map((e) => e.event)).toEqual(['voice-presence']);
    expect(Object.keys(guest.last('voice-presence') as object)).toEqual(['voice-obshchii']);
    expect(guest.data.guest).toBe(true);
  });

  it('гость на пустой канал получает пустой срез, а не чужие комнаты', async () => {
    const { gw, server } = await makeGateway();
    const other = connect(gw, server, { id: 'other' });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii', name: 'кто-то' });
    settle();

    const { token } = issueGuestToken('voice-obshchii-sfu');
    const guest = server.connect({ auth: { guest: token } });
    gw.handleConnection(asSocket(guest));
    expect(guest.last('voice-presence')).toEqual({});
  });

  it('протухший гостевой токен — не пропуск: при заданном пароле сайта отключают', async () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii', { ttlMs: -1000 });
    const sock = server.connect({ auth: { guest: token } });
    gw.handleConnection(asSocket(sock));
    expect(sock.disconnected).toBe(true);
  });

  it('восстановление сессии отменяет отложенный выход — моргание сети не рвёт звонок', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();

    gw.handleDisconnect(asSocket(a));
    vi.advanceTimersByTime(1000);
    gw.handleConnection(asSocket(a));
    vi.advanceTimersByTime(60_000);

    expect(b.all('peer-left')).toHaveLength(0);
  });

  it('не вернулся за грейс — остальным сообщают об уходе', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();

    gw.handleDisconnect(asSocket(a));
    vi.advanceTimersByTime(60_000);
    expect(b.last('peer-left')).toEqual({ id: 'a' });
  });

  it('clientId из handshake обрезается по длине, а пустой владельцем не делает', async () => {
    const { gw, server } = await makeGateway();
    const long = connect(gw, server, { clientId: 'x'.repeat(200) });
    expect((long.data.clientId as string).length).toBe(64);
    const blank = connect(gw, server, { clientId: '   ' });
    expect(blank.data.clientId).toBeUndefined();
  });
});

describe('server-unlock', () => {
  async function withLocked() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'пароль' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('верный пароль открывает каналы и состав их эфиров', async () => {
    const { gw, server } = await withLocked();
    const guest = connect(gw, server, { id: 'guest' });
    gw.handleConnection(asSocket(guest));
    expect((guest.last('channels') as { slug: string }[]).map((c) => c.slug)).not.toContain(
      'тайный-чат',
    );
    guest.clear();

    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'пароль' });
    expect(guest.last('server-unlock-result')).toMatchObject({ id: 'srv', ok: true });
    expect((guest.last('channels') as { slug: string }[]).map((c) => c.slug)).toContain(
      'тайный-чат',
    );
    expect(guest.got('voice-presence')).toBe(true);
  });

  it('неверный пароль ничего не открывает', async () => {
    const { gw, server } = await withLocked();
    const guest = connect(gw, server, { id: 'guest' });
    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'не тот' });
    expect(guest.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });
    expect(guest.got('channels')).toBe(false);
  });

  it('несуществующий сервер — отказ, а не молчание', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server);
    await gw.handleServerUnlock(asSocket(a), { id: 'нет', password: 'x' });
    expect(a.last('server-unlock-result')).toEqual({ id: 'нет', ok: false });
  });

  it('открытый сервер разблокируется без пароля', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server);
    await gw.handleServerUnlock(asSocket(a), { id: MAIN, password: '' });
    expect(a.last('server-unlock-result')).toEqual({ id: MAIN, ok: true });
  });

  it('повторная разблокировка тем же паролем идёт из кэша и всё равно открывает', async () => {
    const { gw, server } = await withLocked();
    const first = connect(gw, server, { id: 'first' });
    await gw.handleServerUnlock(asSocket(first), { id: 'srv', password: 'пароль' });
    const second = connect(gw, server, { id: 'second' });
    await gw.handleServerUnlock(asSocket(second), { id: 'srv', password: 'пароль' });
    expect(second.last('server-unlock-result')).toMatchObject({ id: 'srv', ok: true });
  });

  it('после порога неудач адрес уходит в простой — хэш больше не считается', async () => {
    const { gw, server } = await withLocked();
    const a = connect(gw, server, { id: 'attacker', ip: '9.9.9.9' });
    for (let i = 0; i < 9; i++) {
      await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: `мимо-${i}` });
      vi.advanceTimersByTime(1000);
    }
    a.clear();
    await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: 'пароль' });
    expect(a.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });
  });

  it('простой вяжется к адресу, а не к сокету: реконнект его не сбрасывает', async () => {
    const { gw, server } = await withLocked();
    for (let i = 0; i < 9; i++) {
      const tmp = connect(gw, server, { id: `att-${i}`, ip: '9.9.9.9' });
      await gw.handleServerUnlock(asSocket(tmp), { id: 'srv', password: 'мимо' });
      vi.advanceTimersByTime(1000);
    }
    const fresh = connect(gw, server, { id: 'fresh', ip: '9.9.9.9' });
    await gw.handleServerUnlock(asSocket(fresh), { id: 'srv', password: 'пароль' });
    expect(fresh.last('server-unlock-result')).toEqual({ id: 'srv', ok: false });

    // А сосед по другому адресу не пострадал.
    const neighbour = connect(gw, server, { id: 'neighbour', ip: '8.8.8.8' });
    await gw.handleServerUnlock(asSocket(neighbour), { id: 'srv', password: 'пароль' });
    expect(neighbour.last('server-unlock-result')).toMatchObject({ id: 'srv', ok: true });
  });

  // Регрессия. Разблокировка жила только на сокете, а сокет рвётся сам по себе.
  // После реконнекта реестр приезжал без каналов закрытого сервера (сайдбар
  // показывал их «сиротами» на главном), а `join` в них молча отбивался: клиент
  // считал себя в канале, второй участник оставался в SFU, комната
  // расщеплялась по транспортам — и обе стороны молчали.
  //
  // Переигрывать пароль на connect клиент умел и раньше, но не успевал: ответ
  // ждёт scrypt, а `join` уходит сразу. Поэтому пропуск и предъявляется в
  // handshake — до первой рассылки реестра.
  it('пропуск в handshake переживает реконнект: каналы видны сразу, без ввода пароля', async () => {
    const { gw, server } = await withLocked();
    const first = connect(gw, server, { id: 'first' });
    await gw.handleServerUnlock(asSocket(first), { id: 'srv', password: 'пароль' });
    const { token } = first.last('server-unlock-result') as { token: string };
    expect(token).toBeTruthy();

    // Тот же человек после обрыва: новый сокет, пароля никто не вводил.
    const again = server.connect({ id: 'again', auth: { unlock: [token] } });
    gw.handleConnection(asSocket(again));
    expect((again.last('channels') as { slug: string }[]).map((c) => c.slug)).toContain(
      'тайный-чат',
    );
  });

  it('без пропуска после реконнекта каналов закрытого сервера не видно', async () => {
    const { gw, server } = await withLocked();
    const bare = server.connect({ id: 'bare', auth: {} });
    gw.handleConnection(asSocket(bare));
    expect((bare.last('channels') as { slug: string }[]).map((c) => c.slug)).not.toContain(
      'тайный-чат',
    );
  });

  it('чужой и битый пропуск не открывают ничего', async () => {
    const { gw, server } = await withLocked();
    const sock = server.connect({
      id: 'liar',
      auth: { unlock: ['u1.c3J2.99999999999999.подделка', 'мусор', ''] },
    });
    gw.handleConnection(asSocket(sock));
    expect((sock.last('channels') as { slug: string }[]).map((c) => c.slug)).not.toContain(
      'тайный-чат',
    );
  });

  it('пропуск удалённого сервера не открывает пересозданный с тем же id', async () => {
    const { gw, server, owner } = await withLocked();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: 'пароль' });
    const { token } = a.last('server-unlock-result') as { token: string };

    // Сервер снесли и завели заново под тем же id и другим паролем: соль у
    // нового хэша своя, а с ней и ключ подписи — прежний пропуск ничей.
    await gw.handleServerDelete(asSocket(owner), { id: 'srv' });
    await gw.handleServerCreate(asSocket(owner), {
      id: 'srv',
      name: 'тайный',
      password: 'другой',
    });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });
    settle();

    const stale = server.connect({ id: 'stale', auth: { unlock: [token] } });
    gw.handleConnection(asSocket(stale));
    expect((stale.last('channels') as { slug: string }[]).map((c) => c.slug)).not.toContain(
      'тайный-чат',
    );
  });

  it('отказ на входе в закрытый канал слышен, а не нем', async () => {
    const { gw, server, owner } = await withLocked();
    // Ждём именно запись, а не таймеры: `settle` крутит фейковые часы и о
    // незавершённой записи в базу ничего не знает. Без `await` канала в реестре
    // может ещё не быть — а незнакомую комнату запирать не за что, и тест
    // проваливался бы ровно на загруженной машине, где запись отстаёт.
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный зов',
    });
    settle();
    const outsider = connect(gw, server, { id: 'outsider' });
    gw.handleJoin(asSocket(outsider), { room: 'тайный-зов', name: 'чужак' });
    expect(outsider.last('voice-locked')).toEqual({ room: 'тайный-зов' });
  });

  it('гость пароли не подбирает', async () => {
    const { gw, server } = await withLocked();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleServerUnlock(asSocket(guest), { id: 'srv', password: 'пароль' });
    expect(guest.got('server-unlock-result')).toBe(false);
  });
});

// ── Слушатель и «выгнать гостя» ───────────────────────────────────────────

describe('гость-слушатель', () => {
  it('в presence он помечен слушателем, а микрофон у него выключен', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const { token } = issueGuestToken('voice-obshchii', { listen: true });
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    settle();

    expect(a.last('voice-presence')).toMatchObject({
      'voice-obshchii': [
        { id: 'a', micOn: true },
        { id: 'guest', guest: true, listen: true, micOn: false },
      ],
    });
    // Даже если клиент шлёт «микрофон включён»: включать ему нечего, и врать
    // об этом остальным — худшее, что тут можно сделать.
    gw.handleMediaUpdate(asSocket(guest), { micOn: true, camOn: false, screenOn: false });
    settle();
    expect(
      (a.last('voice-presence') as Record<string, { micOn: boolean }[]>)['voice-obshchii'][1],
    ).toMatchObject({ micOn: false });
  });

  it('остальные узнают о его правах вместе с ним самим', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    const { token } = issueGuestToken('voice-obshchii', { listen: true });
    const guest = connect(gw, server, { id: 'guest', guest: token });
    a.clear();
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    expect(a.last('peer-joined')).toEqual({
      id: 'guest',
      name: 'Гость',
      guest: true,
      listen: true,
    });
  });

  it('пропуск в медиасервер уходит с клеймом: отдавать дорожки ему там не дадут', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет-медиасервера';
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii-sfu', { listen: true });
    const guest = connect(gw, server, { guest: token });
    const res = await gw.handleSfuToken(asSocket(guest), { room: 'voice-obshchii-sfu' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const claims = JSON.parse(
      Buffer.from(res.token.split('.')[1], 'base64url').toString('utf8'),
    ) as { listen?: boolean };
    expect(claims.listen).toBe(true);
  });
});

describe('guest-kick', () => {
  /** Гость в эфире общего канала + обычный участник рядом. */
  async function withGuest(opts: { listen?: boolean } = {}) {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a', clientId: 'dev-a' });
    const { token } = issueGuestToken('voice-obshchii', opts);
    const guest = connect(gw, server, { id: 'guest', clientId: 'dev-guest', guest: token });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Гость' });
    settle();
    server.clearAll();
    return { gw, server, a, guest, token };
  }

  it('любой не-гость выгоняет гостя: тому говорят прямо, остальным — как об уходе', async () => {
    const { gw, a, guest } = await withGuest();
    expect(gw.handleGuestKick(asSocket(a), { id: 'guest' })).toEqual({ ok: true });
    expect(guest.last('kicked')).toEqual({ room: 'voice-obshchii' });
    expect(a.last('peer-left')).toEqual({ id: 'guest' });
    expect(guest.rooms.has('voice-obshchii')).toBe(false);
  });

  it('по той же ссылке он не возвращается, пока не выйдет пауза', async () => {
    const { gw, server, a } = await withGuest();
    gw.handleGuestKick(asSocket(a), { id: 'guest' });
    const { token } = issueGuestToken('voice-obshchii');

    // Новая вкладка, новый сокет — но то же устройство.
    const again = server.connect({
      id: 'guest-2',
      auth: { clientId: 'dev-guest', guest: token },
    });
    gw.handleConnection(asSocket(again));
    expect(again.last('kicked')).toEqual({ room: 'voice-obshchii' });
    expect(again.got('voice-presence')).toBe(false);
    // И дверь с другой стороны: `join` сокетом, открытым до исключения.
    gw.handleJoin(asSocket(again), { room: 'voice-obshchii', name: 'Гость' });
    expect(again.rooms.has('voice-obshchii')).toBe(false);
  });

  it('час прошёл — пускают снова', async () => {
    const { gw, server, a } = await withGuest();
    gw.handleGuestKick(asSocket(a), { id: 'guest' });
    vi.advanceTimersByTime(60 * 60 * 1000 + 1000);
    const { token } = issueGuestToken('voice-obshchii');
    const again = server.connect({ id: 'guest-3', auth: { clientId: 'dev-guest', guest: token } });
    gw.handleConnection(asSocket(again));
    expect(again.got('kicked')).toBe(false);
    expect(again.got('voice-presence')).toBe(true);
  });

  it('гость гостя не выгоняет', async () => {
    const { gw, server, guest } = await withGuest();
    const { token } = issueGuestToken('voice-obshchii');
    const other = connect(gw, server, { id: 'guest-b', clientId: 'dev-b', guest: token });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii', name: 'Второй' });
    expect(gw.handleGuestKick(asSocket(other), { id: 'guest' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(guest.got('kicked')).toBe(false);
  });

  it('не-гостя не выгнать вовсе, а вышедшего — уже не за что', async () => {
    const { gw, a, guest } = await withGuest();
    expect(gw.handleGuestKick(asSocket(a), { id: 'a' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    gw.handleLeave(asSocket(guest));
    expect(gw.handleGuestKick(asSocket(a), { id: 'guest' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('из закрытого канала выгоняет только тот, кто ввёл пароль', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });
    const { token } = issueGuestToken('тайный-эфир', { listen: true });
    const guest = connect(gw, server, { id: 'guest', clientId: 'dev-guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'тайный-эфир', name: 'Гость' });
    settle();

    // Канала он не видит — значит и того, кто в нём сидит, для него нет.
    const stranger = connect(gw, server, { id: 'stranger', clientId: 'dev-x' });
    expect(gw.handleGuestKick(asSocket(stranger), { id: 'guest' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(gw.handleGuestKick(asSocket(owner), { id: 'guest' })).toEqual({ ok: true });
  });
});

describe('sfu-token', () => {
  async function withSfuChannel() {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет-медиасервера';
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'эфир',
      mode: 'sfu',
    });
    settle();
    return { gw, server, owner };
  }

  it('выдаёт пропуск с адресом медиасервера и запоминает выдачу', async () => {
    const { gw, owner } = await withSfuChannel();
    const res = await gw.handleSfuToken(asSocket(owner), { room: 'эфир', name: 'Хозяин' });
    expect(res).toMatchObject({ ok: true, url: 'https://relay.example/sfu' });
    expect(owner.data.sfuPassRoom).toBe('эфир');
  });

  it('без настроенного медиасервера — unavailable', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(await gw.handleSfuToken(asSocket(a), { room: 'voice-obshchii-sfu' })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('настроен, но лежит — тоже unavailable: пропуск в мёртвый сервер хуже отказа', async () => {
    const { gw, owner } = await withSfuChannel();
    sfuHealthy.mockResolvedValue(false);
    expect(await gw.handleSfuToken(asSocket(owner), { room: 'эфир' })).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('p2p-каналу пропуск не положен', async () => {
    const { gw, owner } = await withSfuChannel();
    expect(await gw.handleSfuToken(asSocket(owner), { room: 'voice-obshchii' })).toEqual({
      ok: false,
      error: 'not-sfu',
    });
  });

  it('вне комнаты и без указания комнаты — not-in-room', async () => {
    const { gw, owner } = await withSfuChannel();
    expect(await gw.handleSfuToken(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-in-room',
    });
  });

  it('комнату берут из сокета, если её не назвали', async () => {
    const { gw, owner } = await withSfuChannel();
    gw.handleJoin(asSocket(owner), { room: 'эфир', name: 'Хозяин' });
    expect(await gw.handleSfuToken(asSocket(owner), {})).toMatchObject({ ok: true });
  });

  it('гость проходит в свою комнату и только в неё', async () => {
    const { gw, server } = await withSfuChannel();
    const { token } = issueGuestToken('эфир');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleSfuToken(asSocket(guest), { room: 'эфир' })).toMatchObject({ ok: true });
    expect(await gw.handleSfuToken(asSocket(guest), { room: 'voice-obshchii-sfu' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('канал закрытого сервера запирает и медиасервер', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
      mode: 'sfu',
    });
    const stranger = connect(gw, server);
    expect(await gw.handleSfuToken(asSocket(stranger), { room: 'тайный-эфир' })).toEqual({
      ok: false,
      error: 'not-sfu',
    });
  });
});

// ── Общие заслоны ─────────────────────────────────────────────────────────

describe('ограничение частоты', () => {
  it('бакет пустеет и гасит флуд, а через секунду наполняется снова', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    server.clearAll();

    for (let i = 0; i < 60; i++) await gw.handleChatMessage(asSocket(a), { text: `${i}` });
    const sent = a.all('chat').length;
    expect(sent).toBeLessThan(60);
    expect(sent).toBeGreaterThan(0);

    vi.advanceTimersByTime(1000);
    a.clear();
    await gw.handleChatMessage(asSocket(a), { text: 'после паузы' });
    expect(a.got('chat')).toBe(true);
  });

  it('негоциацию бакет не трогает: она бывает бурстовой законно', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    for (let i = 0; i < 200; i++) {
      gw.handleIceCandidate(asSocket(a), { to: 'b', candidate: i });
    }
    expect(b.all('ice-candidate')).toHaveLength(200);
  });
});

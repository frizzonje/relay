import { describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { ChannelRow, MessageRow, ServerRow } from '../db/entities';
import { asSocket } from './testkit';
import {
  MAIN,
  connect,
  connectAs,
  database,
  makeGateway,
  makeOwner,
  personCookie,
  settle,
  useGatewayStand,
  type AnyGw,
} from './gateway.testkit';

/**
 * Витрина реестра, половина про серверы: кто заводит, кто сносит, кто вправе
 * их править и каким список видит каждый сокет.
 *
 * Витрина у каждого своя — она зависит от введённых паролей, собственных
 * записей и банов, — и именно поэтому рассылка «всем одно и то же» здесь была
 * бы утечкой, а не оптимизацией.
 */

useGatewayStand();

// ── Реестр серверов ───────────────────────────────────────────────────────

describe('server-create', () => {
  it('создаёт сервер и раздаёт обновлённый реестр всем', async () => {
    const { gw, server, registry } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    const b = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой', emoji: '🌚' });
    settle();

    const seen = b.last('servers') as { id: string; name: string; emoji?: string }[];
    expect(seen.map((s) => s.id)).toEqual([MAIN, 'srv']);
    expect(seen[1]).toMatchObject({ name: 'мой', emoji: '🌚', removable: true });

    // И переживёт рестарт: сервер в базе, а не только в памяти процесса.
    await registry.flush();
    expect(await database().getRepository(ServerRow).findOneBy({ id: 'srv' })).toMatchObject({
      name: 'мой',
      emoji: '🌚',
      creatorId: 'dev-a',
    });
  });

  it('создателю сервер приходит с флагом mine, остальным — без', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-a' });
    const other = connect(gw, server, { clientId: 'dev-b' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    settle();

    const find = (s: { last(e: string): unknown }) =>
      (s.last('servers') as { id: string; mine?: boolean }[]).find((x) => x.id === 'srv');
    expect(find(owner)?.mine).toBe(true);
    expect(find(other)?.mine).toBeUndefined();
  });

  it('наружу уходит флаг locked, но не хэш пароля', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'тайный', password: 'пароль' });
    settle();
    const srv = (a.last('servers') as Record<string, unknown>[]).find((s) => s.id === 'srv')!;
    expect(srv.locked).toBe(true);
    expect(Object.keys(srv)).not.toContain('passwordHash');
  });

  it('создатель закрытого сервера сразу разблокирован — второй раз пароль не спрашивают', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'тайный', password: 'пароль' });
    expect((a.data.unlocked as Set<string>).has('srv')).toBe(true);
  });

  it('повторный create с тем же id не плодит дубликат', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'раз' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'два' });
    expect((gw as AnyGw).registry.servers.filter((s) => s.id === 'srv')).toHaveLength(1);
  });

  it('без id или без имени сервер не появляется', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), { id: '', name: 'мой' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: '   ' });
    await gw.handleServerCreate(asSocket(a), { id: 42, name: 'мой' });
    expect((gw as AnyGw).registry.servers).toHaveLength(1);
  });

  it('имя и emoji режутся по длине, пустой emoji не сохраняется', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    await gw.handleServerCreate(asSocket(a), {
      id: 'srv',
      name: 'и'.repeat(100),
      emoji: 'э'.repeat(20),
    });
    await gw.handleServerCreate(asSocket(a), { id: 'srv-2', name: 'второй', emoji: '  ' });
    settle();
    const srv = (gw as AnyGw).registry.servers.find((s) => s.id === 'srv')!;
    expect(srv.name).toHaveLength(32);
    expect(srv.emoji).toHaveLength(8);
    // Из одних пробелов emoji не рождается — наружу такой сервер уходит без поля.
    const public2 = (a.last('servers') as Record<string, unknown>[]).find((s) => s.id === 'srv-2')!;
    expect(public2).not.toHaveProperty('emoji');
  });

  it('потолок в 20 серверов держится', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    for (let i = 0; i < 25; i++) {
      await gw.handleServerCreate(asSocket(a), { id: `srv-${i}`, name: `s${i}` });
      // Бакет на 40 токенов — двигаем время, чтобы упереться именно в потолок.
      vi.advanceTimersByTime(1000);
    }
    expect((gw as AnyGw).registry.servers).toHaveLength(20);
  });

  it('гость сервера не создаёт', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleServerCreate(asSocket(guest), { id: 'srv', name: 'мой' });
    expect((gw as AnyGw).registry.servers).toHaveLength(1);
  });

  it('сохранённые серверы поднимаются вместе с дефолтными, дефолт — источник правды', async () => {
    const { gw } = await makeGateway({
      servers: [
        { id: 'srv', name: 'сохранённый', removable: true },
        { id: MAIN, name: 'подмена', removable: true },
      ],
    });
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toEqual([MAIN, 'srv']);
    expect((gw as AnyGw).registry.servers[0].removable).toBe(false);
  });

  it('удалённый сервер уносит свои каналы и их переписку', async () => {
    const { gw, server, registry } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChatJoin(asSocket(owner), { room: 'чат', name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'привет' });

    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({ ok: true });
    await registry.flush();

    // Канал-сирота теперь невозможен не по договорённости, а по внешнему ключу:
    // сервера нет — нет и каналов, а вместе с каналом уходит его переписка.
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
    expect(await database().getRepository(ChannelRow).countBy({ serverId: 'srv' })).toBe(0);
    expect(await database().getRepository(MessageRow).count()).toBe(0);
  });

  it('канал, выведенный из дефолтов, не возвращается из сохранённого реестра', async () => {
    const { gw } = await makeGateway({
      servers: [{ id: MAIN, name: 'relay', removable: false }],
      channels: [
        {
          id: 'text-general',
          serverId: MAIN,
          type: 'text',
          name: 'general',
          slug: 'general',
          removable: false,
        },
      ],
    });
    expect((gw as AnyGw).registry.channels.find((c) => c.id === 'text-general')).toBeUndefined();
  });

  it('отказ базы не роняет живой реестр в памяти', async () => {
    const { gw, server, registry } = await makeGateway();
    const a = connect(gw, server);
    vi.spyOn(database(), 'transaction').mockRejectedValueOnce(new Error('база отвалилась'));
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await registry.flush();
    // Записать не вышло, но сервер жив: люди, уже сидящие в relay, не должны
    // терять только что созданное из-за того, что база моргнула.
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toContain('srv');
  });
});

describe('server-delete', () => {
  async function withServer(clientId = 'dev-a') {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'болталка',
    });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('владелец удаляет сервер вместе с его каналами', async () => {
    const { gw, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({ ok: true });
    settle();
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toEqual([MAIN]);
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
    expect((owner.last('channels') as unknown[]).length).toBe(3);
  });

  it('читателей текстового канала выписывают явно, а не оставляют гадать', async () => {
    const { gw, server, owner } = await withServer();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: 'болталка', name: 'Читатель' });
    reader.clear();

    await gw.handleServerDelete(asSocket(owner), { id: 'srv' });
    expect(reader.last('chat-closed')).toEqual({ slug: 'болталка' });
    expect(reader.data.chatRoom).toBeUndefined();
  });

  it('главный сервер не удаляется', async () => {
    const { gw, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), { id: MAIN })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('чужой сервер удалить нельзя', async () => {
    const { gw, server } = await withServer('dev-owner');
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
    expect((gw as AnyGw).registry.servers.map((s) => s.id)).toContain('srv');
  });

  it('запись без создателя (создана до правила владения) остаётся общей', async () => {
    const { gw, server } = await makeGateway({
      servers: [{ id: 'старый', name: 'ничей', removable: true }],
    });
    const anyone = connect(gw, server, { clientId: 'dev-кто-угодно' });
    expect(await gw.handleServerDelete(asSocket(anyone), { id: 'старый' })).toEqual({ ok: true });
  });

  it('закрытый сервер удаляет только тот, кто ввёл пароль', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    // Тот же clientId: владение не спасает, пока пароль не введён.
    const stranger = connect(gw, server, { clientId: 'dev-owner' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('живой разговор дороже уборки: сервер с людьми в эфире не удаляется', async () => {
    const { gw, server, owner } = await withServer();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Говорящий' });
    expect(await gw.handleServerDelete(asSocket(owner), { id: 'srv' })).toEqual({
      ok: false,
      error: 'occupied',
      occupants: 1,
    });
  });

  it('пустой id — not-found, гость — forbidden', async () => {
    const { gw, server, owner } = await withServer();
    expect(await gw.handleServerDelete(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-found',
    });
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleServerDelete(asSocket(guest), { id: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

describe('server-stats', () => {
  it('владельцу — цена удаления: каналы, сообщения, люди в эфире', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    await gw.handleChatJoin(asSocket(owner), { room: 'чат', name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'привет' });

    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: 'эфир', name: 'Гость' });

    expect(await gw.handleServerStats(asSocket(owner), { id: 'srv' })).toEqual({
      ok: true,
      channels: 2,
      messages: 1,
      occupants: 1,
    });
  });

  it('чужому серверу срез не показывают', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleServerStats(asSocket(stranger), { id: 'srv' })).toEqual({ ok: false });
  });

  it('главный сервер (неудаляемый) среза не даёт', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(await gw.handleServerStats(asSocket(a), { id: MAIN })).toEqual({ ok: false });
  });

  it('закрытый сервер без введённого пароля молчит', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    const other = connect(gw, server, { clientId: 'dev' });
    expect(await gw.handleServerStats(asSocket(other), { id: 'srv' })).toEqual({ ok: false });
  });
});

// ── Права на реестр ───────────────────────────────────────────────────────

/** Сделать человека владельцем инсталляции — тем же путём, что и ссылка. */
async function makeOwner(owner: OwnerService, identityId: string): Promise<void> {
  const { token } = await owner.issue();
  await owner.claim(token, identityId);
}

describe('права на сервер: личность и владелец инсталляции', () => {
  it('созданный сервер записан на личность, а не на устройство', async () => {
    const { gw, server, registry } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-a' });

    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });
    await registry.flush();

    expect(await database().getRepository(ServerRow).findOneBy({ id: 'srv' })).toMatchObject({
      creatorIdentityId: anya.identityId,
      creatorId: null,
    });
  });

  it('свой сервер правится с другого устройства того же человека', async () => {
    // Ровно то, ради чего права переезжали с clientId: раньше сервер оставался
    // у той вкладки, в которой его создали.
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const laptop = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-a' });
    await gw.handleServerCreate(asSocket(laptop), { id: 'srv', name: 'мой' });
    settle();

    const phone = await connectAs(gw, server, anya.cookie, {
      id: 'b',
      clientId: 'dev-b',
      keep: true,
    });
    const seen = (phone.last('servers') as { id: string; mine?: boolean }[]).find(
      (s) => s.id === 'srv',
    );
    expect(seen?.mine).toBe(true);
    expect(await gw.handleServerDelete(asSocket(phone), { id: 'srv' })).toEqual({ ok: true });
  });

  it('чужой человек чужой сервер не удаляет', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });

    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('владелец инсталляции правит чужое', async () => {
    const { gw, server, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'чужой' });

    await makeOwner(owner, boris.identityId);
    const b = await connectAs(gw, server, boris.cookie, { id: 'b', keep: true });

    const seen = (b.last('servers') as { id: string; mine?: boolean }[]).find(
      (s) => s.id === 'srv',
    );
    expect(seen?.mine).toBe(true);
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({ ok: true });
  });

  it('власть, взятая под живым сокетом, действует сразу — и сразу теряется', async () => {
    // Иначе бывший владелец удалял бы чужое до переподключения, а новый ждал бы
    // перезагрузки страницы, чтобы увидеть свои права.
    const { gw, server, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    await gw.handleServerCreate(asSocket(a), { id: 'srv', name: 'мой' });

    await makeOwner(owner, boris.identityId);
    await gw.syncOwner();
    settle();
    const mine = (sock: { last(e: string): unknown }) =>
      (sock.last('servers') as { id: string; mine?: boolean }[]).find((s) => s.id === 'srv')?.mine;
    expect(mine(b)).toBe(true);

    // Ссылку перевыпустили и открыла её Аня — Борис перестал быть владельцем.
    await makeOwner(owner, anya.identityId);
    await gw.syncOwner();
    settle();
    expect(mine(b)).toBeUndefined();
    expect(await gw.handleServerDelete(asSocket(b), { id: 'srv' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('унаследованный сервер остаётся за своим устройством', async () => {
    // Переписать clientId в личность нечем, поэтому старое правило для старых
    // записей продолжает работать — и не открывается чужой личностью с тем же
    // идентификатором.
    const { gw, server } = await makeGateway({
      servers: [{ id: 'old', name: 'старый', removable: true, creatorId: 'dev-old' }],
    });
    const anya = await personCookie('Аня');
    const stranger = await connectAs(gw, server, anya.cookie, { id: 'a', clientId: 'dev-new' });
    expect(await gw.handleServerDelete(asSocket(stranger), { id: 'old' })).toEqual({
      ok: false,
      error: 'not-owner',
    });

    const sameDevice = connect(gw, server, { id: 'b', clientId: 'dev-old' });
    expect(await gw.handleServerDelete(asSocket(sameDevice), { id: 'old' })).toEqual({ ok: true });
  });
});

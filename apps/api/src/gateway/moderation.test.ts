import { describe, expect, it } from 'vitest';
import { asSocket } from './testkit';
import {
  MAIN,
  connect,
  connectAs,
  knock,
  makeGateway,
  makeOwner,
  ownServer,
  personCookie,
  say,
  slugOf,
  useGatewayStand,
} from './gateway.testkit';

/**
 * Модерация: чья это власть и докуда она достаёт.
 *
 * Право модерировать спрашивают из четырёх мест, а применяют в одном, и
 * послабление «создателя нет — значит можно всем» здесь означало бы, что на
 * главном сервере любой банит кого хочет: создателя у него нет и быть не может.
 */

useGatewayStand();

describe('бан', () => {
  it('забаненного на инсталляцию не пускают на порог', async () => {
    const { gw, server, roles, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    await roles.ban(anya.identityId, null, boss.identityId);

    const { sock, refused } = await knock(gw, server, anya.cookie);
    // Причина уезжает текстом ошибки: это единственный канал, который у
    // отвергнутого сокета есть, и без неё человек видит вечное «соединяюсь».
    expect(refused?.message).toBe('banned');
    expect(sock.got('servers')).toBe(false);
  });

  it('бан вступает в силу под живым сокетом, а не со следующего входа', async () => {
    // Иначе он длился бы ровно столько, сколько человек не перезагружает
    // страницу, — то есть весь скандал, из-за которого его и банили.
    const { gw, server, roles, owner } = await makeGateway();
    const anya = await personCookie('Аня');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boss.cookie, { id: 'b' });

    const id = await say(gw, a, 'obshchii', 'здрасьте');
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    expect(await gw.handleModerationBan(asSocket(b), { id, everywhere: true })).toEqual({
      ok: true,
    });

    expect(a.got('banned')).toBe(true);
    expect(a.disconnected).toBe(true);
    expect((await roles.rightsOf(anya.identityId)).banned).toBe(true);
  });

  it('бан со своего сервера прячет сервер и выписывает из его каналов', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);

    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'привет');
    gw.handleJoin(asSocket(g), { room: slugOf('эфир') });
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });
    g.clear();

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({ ok: true });

    // С причиной: канал на месте, ушёл человек. Клиент по ней и говорит правду
    // вместо «канал удалён».
    expect(g.last('chat-closed')).toEqual({ slug: slugOf('болталка'), reason: 'banned' });
    expect(g.data.room).toBeUndefined();
    const servers = g.last('servers') as { id: string }[];
    expect(servers.map((s) => s.id)).toEqual([MAIN]);
    // Остальная инсталляция при этом на месте: бан со своего сервера — не бан
    // со всей инсталляции.
    const channels = g.last('channels') as { serverId: string }[];
    expect(channels.every((c) => c.serverId === MAIN)).toBe(true);
    expect(g.disconnected).toBe(false);
  });

  it('забаненный не возвращается ни в эфир, ни в реестр', async () => {
    const { gw, server, roles } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    await roles.ban(guest.identityId, 'srv', host.identityId);

    const { sock: g } = await knock(gw, server, guest.cookie, 'g');
    expect((g.last('servers') as { id: string }[]).map((s) => s.id)).toEqual([MAIN]);

    gw.handleJoin(asSocket(g), { room: slugOf('эфир') });
    expect(g.data.room).toBeUndefined();
    await gw.handleChatJoin(asSocket(g), { room: slugOf('болталка') });
    expect(g.data.chatRoom).toBeUndefined();
  });

  it('создатель сервера банит только со своего сервера', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'привет');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });

    expect(await gw.handleModerationBan(asSocket(h), { id, everywhere: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('в чужом канале модерировать нечего', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const other = await personCookie('Посторонний');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const o = await connectAs(gw, server, other.cookie, { id: 'o' });
    const id = await say(gw, h, slugOf('болталка'), 'моё слово');
    await gw.handleChatJoin(asSocket(o), { room: slugOf('болталка') });

    expect(await gw.handleModerationBan(asSocket(o), { id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleModerationBans(asSocket(o), { server: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('владельца инсталляции не банят', async () => {
    // Строка бана на инсталляцию и строка владения — одна и та же пара ключей:
    // забаненный владелец означал бы инсталляцию вообще без владельца.
    const { gw, server, owner } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const boss = await personCookie('Хозяин');
    await makeOwner(owner, boss.identityId);
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const b = await connectAs(gw, server, boss.cookie, { id: 'b' });
    const id = await say(gw, b, slugOf('болталка'), 'зашёл посмотреть');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('гостя по инвайту забанить нечем', async () => {
    // За него ручается токен приглашения, а не ключ: банить нечего, и
    // заканчивается разговор с ним через guest-kick.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const nobody = connect(gw, server, { id: 'n' });
    const id = await say(gw, nobody, slugOf('болталка'), 'здрасьте');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });

    expect(await gw.handleModerationBan(asSocket(h), { id })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('список забаненных и разбан возвращают сервер на место', async () => {
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'привет');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });
    await gw.handleModerationBan(asSocket(h), { id });

    const list = await gw.handleModerationBans(asSocket(h), { server: 'srv' });
    expect(list).toMatchObject({
      ok: true,
      bans: [{ fingerprint: guest.fingerprint, nick: 'Гость', by: 'Хозяйка' }],
    });

    g.clear();
    expect(
      await gw.handleModerationUnban(asSocket(h), {
        fingerprint: guest.fingerprint,
        server: 'srv',
      }),
    ).toEqual({ ok: true });
    expect((g.last('servers') as { id: string }[]).map((s) => s.id)).toContain('srv');
  });

  it('список банов чужого сервера не отдают, и разбанить на нём нечего', async () => {
    // Кто здесь модератор — вопрос про КОНКРЕТНЫЙ сервер. Иначе список банов
    // соседа рассказывал бы, кого он выгнал, любому, кто спросит по id.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const stranger = await personCookie('Прохожий');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'привет');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });
    await gw.handleModerationBan(asSocket(h), { id });

    const s = await connectAs(gw, server, stranger.cookie, { id: 's' });
    expect(await gw.handleModerationBans(asSocket(s), { server: 'srv' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await gw.handleModerationUnban(asSocket(s), {
        fingerprint: guest.fingerprint,
        server: 'srv',
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });

  it('банов на инсталляцию не показывают тому, кто ею не владеет', async () => {
    // Сервер не назван — речь про инсталляцию целиком, а это власть владельца.
    // У создателя сервера её нет, сколько бы серверов он ни завёл.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);

    expect(await gw.handleModerationBans(asSocket(h), {})).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await gw.handleModerationUnban(asSocket(h), { fingerprint: 'что-нибудь' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('разбан незнакомого отпечатка и разбан не забаненного — оба «не найдено»', async () => {
    // Разница между «такого нет» и «он не забанен» наружу не выходит намеренно:
    // по ответу нельзя перебором узнать, чей отпечаток здесь заводили.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);

    expect(
      await gw.handleModerationUnban(asSocket(h), { fingerprint: 'нет-такого', server: 'srv' }),
    ).toEqual({ ok: false, error: 'not-found' });
    expect(
      await gw.handleModerationUnban(asSocket(h), {
        fingerprint: guest.fingerprint,
        server: 'srv',
      }),
    ).toEqual({ ok: false, error: 'not-found' });
  });

  it('модератор удаляет чужое сообщение, но не правит его', async () => {
    // Удалить сказанное — модерация; переписать сказанное чужим именем — подлог.
    const { gw, server } = await makeGateway();
    const host = await personCookie('Хозяйка');
    const guest = await personCookie('Гость');
    const h = await connectAs(gw, server, host.cookie, { id: 'h' });
    await ownServer(gw, h);
    const g = await connectAs(gw, server, guest.cookie, { id: 'g' });
    const id = await say(gw, g, slugOf('болталка'), 'дурное слово');
    await gw.handleChatJoin(asSocket(h), { room: slugOf('болталка') });
    server.clearAll();

    await gw.handleChatEdit(asSocket(h), { id, text: 'подменённое' });
    expect(g.got('chat-edited')).toBe(false);

    await gw.handleChatDelete(asSocket(h), { id });
    expect(g.last('chat-deleted')).toEqual({ id });
  });

  it('в чужом канале своё удаляется, а чужое — нет', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    const mine = await say(gw, a, 'obshchii', 'моё');
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    server.clearAll();

    // Главный сервер не создавал никто — модератора у него нет, и правила в нём
    // прежние: каждый отвечает за своё.
    await gw.handleChatDelete(asSocket(b), { id: mine });
    expect(a.got('chat-deleted')).toBe(false);
    await gw.handleChatDelete(asSocket(a), { id: mine });
    expect(a.last('chat-deleted')).toEqual({ id: mine });
  });
});

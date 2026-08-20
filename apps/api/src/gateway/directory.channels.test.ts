import { describe, expect, it, vi } from 'vitest';
import { issueGuestToken, verifyGuestToken } from '../auth/auth';
import { asSocket } from './testkit';
import { MAX_CHANNELS_PER_SERVER } from './registry.service';
import {
  MAIN,
  connect,
  makeGateway,
  settle,
  slugOf,
  useGatewayStand,
  type AnyGw,
} from './gateway.testkit';

/**
 * Витрина реестра, половина про каналы: создание, режим, переименование,
 * удаление, статистика — и приглашение, которым в канал зовут человека со
 * стороны.
 */

useGatewayStand();

// ── Реестр каналов ────────────────────────────────────────────────────────

describe('channel-create', () => {
  async function withOwnServer() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    settle();
    server.clearAll();
    return { gw, server, owner };
  }

  it('создаёт канал со слагом из имени', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'Общий Чат!',
    });
    const ch = (gw as AnyGw).registry.channels.find((c) => c.serverId === 'srv')!;
    expect(ch.slug).toBe(slugOf('Общий Чат!'));
    expect(ch.type).toBe('text');
    expect(ch.creatorId).toBe('dev-owner');
  });

  it('слаг режется по длине и не копит дефисы', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'а   б   в '.repeat(6),
    });
    const ch = (gw as AnyGw).registry.channels.find((c) => c.serverId === 'srv')!;
    expect(ch.slug.length).toBeLessThanOrEqual(32);
    expect(ch.slug).not.toMatch(/--/);
  });

  it('имя из одной пунктуации канала не даёт', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: '!!! ???',
    });
    expect((gw as AnyGw).registry.channels.some((c) => c.serverId === 'srv')).toBe(false);
  });

  it('в главный сервер каналы не добавляют — набор там фиксирован', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: MAIN, type: 'text', name: 'лишний' });
    // serverId по умолчанию — тоже главный, то есть тот же запрет.
    await gw.handleChannelCreate(asSocket(owner), { type: 'text', name: 'лишний-2' });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });

  it('несуществующий сервер и неизвестный тип канала не создают', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'нет', type: 'text', name: 'висяк' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'видео',
      name: 'что-то',
    });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });

  it('дубликат слага того же типа не создаётся, а другого типа — можно', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'общий' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'общий' });
    expect((gw as AnyGw).registry.channels.filter((c) => c.slug === slugOf('общий'))).toHaveLength(
      1,
    );
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'общий',
    });
    expect((gw as AnyGw).registry.channels.filter((c) => c.slug === slugOf('общий'))).toHaveLength(
      2,
    );
  });

  it('режим sfu пишется только голосовым', async () => {
    const { gw, owner } = await withOwnServer();
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'через сервер',
      mode: 'sfu',
    });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'текст',
      mode: 'sfu',
    });
    expect(
      (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('через сервер'))!.mode,
    ).toBe('sfu');
    expect(
      (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('текст'))!.mode,
    ).toBeUndefined();
  });

  it('в закрытый сервер канал заводит только разблокировавший', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    await gw.handleChannelCreate(asSocket(stranger), {
      serverId: 'srv',
      type: 'text',
      name: 'вторжение',
    });
    expect((gw as AnyGw).registry.channels.some((c) => c.slug === slugOf('вторжение'))).toBe(false);
  });

  /**
   * Потолок каналов считается по своему серверу (audit S2): общий на
   * инсталляцию означал бы, что полсотни каналов в чужом сервере не дают
   * завести первый в своём.
   */
  it('потолок сервера держится, и в отказе стоит само число', async () => {
    const { gw, owner } = await withOwnServer();
    const answers = [];
    for (let i = 0; i < MAX_CHANNELS_PER_SERVER + 2; i++) {
      answers.push(
        await gw.handleChannelCreate(asSocket(owner), {
          serverId: 'srv',
          type: 'text',
          name: `ch${i}`,
        }),
      );
      vi.advanceTimersByTime(1000);
    }
    expect(answers.filter((r) => r.ok)).toHaveLength(MAX_CHANNELS_PER_SERVER);
    expect(answers[answers.length - 1]).toEqual({
      ok: false,
      error: 'limit',
      scope: 'server',
      limit: MAX_CHANNELS_PER_SERVER,
    });
  });

  it('гость каналов не создаёт', async () => {
    const { gw, server } = await withOwnServer();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleChannelCreate(asSocket(guest), {
      serverId: 'srv',
      type: 'text',
      name: 'гостевой',
    });
    expect((gw as AnyGw).registry.channels).toHaveLength(3);
  });
});

describe('channel-mode', () => {
  async function withVoice() {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    settle();
    server.clearAll();
    const voice = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('эфир'))!;
    return { gw, server, owner, voice };
  }

  it('переводит канал на медиасервер и говорит об этом тем, кто в нём сидит', async () => {
    const { gw, server, owner, voice } = await withVoice();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: slugOf('эфир'), name: 'Т' });
    talker.clear();

    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'sfu' });
    expect(voice.mode).toBe('sfu');
    expect(talker.last('voice-mode')).toEqual({ room: slugOf('эфир'), mode: 'sfu' });
  });

  it('возврат на p2p стирает поле, а не пишет строку', async () => {
    const { gw, owner, voice } = await withVoice();
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'sfu' });
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'p2p' });
    expect(voice).not.toHaveProperty('mode');
  });

  it('тот же режим второй раз ничего не рассылает', async () => {
    const { gw, server, owner, voice } = await withVoice();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: slugOf('эфир'), name: 'Т' });
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'p2p' });
    expect(talker.got('voice-mode')).toBe(false);
  });

  it('текстовому каналу режим не меняют', async () => {
    const { gw, owner } = await withVoice();
    const text = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('чат'))!;
    await gw.handleChannelMode(asSocket(owner), { id: text.id, mode: 'sfu' });
    expect(text.mode).toBeUndefined();
  });

  it('дефолтный канал остаётся на p2p — он обязан работать без медиасервера', async () => {
    const { gw, owner } = await withVoice();
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'voice-obshchii')!;
    await gw.handleChannelMode(asSocket(owner), { id: def.id, mode: 'sfu' });
    expect(def.mode).toBeUndefined();
  });

  it('чужой канал не переключают', async () => {
    const { gw, server, voice } = await withVoice();
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    await gw.handleChannelMode(asSocket(stranger), { id: voice.id, mode: 'sfu' });
    expect(voice.mode).toBeUndefined();
  });

  it('без id, с неизвестным режимом или по чужому id — ничего', async () => {
    const { gw, owner, voice } = await withVoice();
    await gw.handleChannelMode(asSocket(owner), { id: voice.id, mode: 'спутник' });
    await gw.handleChannelMode(asSocket(owner), { mode: 'sfu' });
    await gw.handleChannelMode(asSocket(owner), { id: 'нет-такого', mode: 'sfu' });
    expect(voice.mode).toBeUndefined();
  });
});

describe('channel-rename / channel-delete / channel-stats', () => {
  async function withChannels() {
    const { gw, server, registry } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'voice', name: 'эфир' });
    settle();
    server.clearAll();
    const text = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('чат'))!;
    const voice = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('эфир'))!;
    return { gw, server, owner, text, voice, registry };
  }

  it('переименование меняет имя, но не слаг — переписка и комната остаются', async () => {
    const { gw, owner, text } = await withChannels();
    await gw.handleChatJoin(asSocket(owner), { room: slugOf('чат'), name: 'Хозяин' });
    await gw.handleChatMessage(asSocket(owner), { text: 'до' });

    expect(
      await gw.handleChannelRename(asSocket(owner), { id: text.id, name: 'Болталка' }),
    ).toEqual({
      ok: true,
    });
    expect(text.name).toBe('Болталка');
    expect(text.slug).toBe(slugOf('чат'));
    expect(owner.data.chatRoom).toBe(`chat:${slugOf('чат')}`);
  });

  it('пустое имя отвергается внятно', async () => {
    const { gw, owner, text } = await withChannels();
    expect(await gw.handleChannelRename(asSocket(owner), { id: text.id, name: '   ' })).toEqual({
      ok: false,
      error: 'bad-name',
    });
  });

  it('то же имя — успех без лишней записи', async () => {
    const { gw, owner, text, registry } = await withChannels();
    const persist = vi.spyOn(registry, 'persist');
    expect(await gw.handleChannelRename(asSocket(owner), { id: text.id, name: 'чат' })).toEqual({
      ok: true,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('дефолтный и чужой каналы не переименовывают', async () => {
    const { gw, server, text } = await withChannels();
    const owner2 = connect(gw, server, { clientId: 'dev-owner' });
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'obshchii')!;
    expect(await gw.handleChannelRename(asSocket(owner2), { id: def.id, name: 'моё' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleChannelRename(asSocket(stranger), { id: text.id, name: 'моё' })).toEqual({
      ok: false,
      error: 'not-owner',
    });
  });

  it('несуществующий id и пустой id одинаково not-found', async () => {
    const { gw, owner } = await withChannels();
    expect(await gw.handleChannelRename(asSocket(owner), { name: 'моё' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await gw.handleChannelRename(asSocket(owner), { id: 'нет', name: 'моё' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('голосовой канал с людьми не удаляется, опустевший — удаляется', async () => {
    const { gw, server, owner, voice } = await withChannels();
    const talker = connect(gw, server, { id: 'talker' });
    gw.handleJoin(asSocket(talker), { room: slugOf('эфир'), name: 'Т' });
    expect(await gw.handleChannelDelete(asSocket(owner), { id: voice.id })).toEqual({
      ok: false,
      error: 'occupied',
      occupants: 1,
    });
    gw.handleLeave(asSocket(talker));
    expect(await gw.handleChannelDelete(asSocket(owner), { id: voice.id })).toEqual({ ok: true });
  });

  it('текстовый канал уносит историю, читателей выписывают, слаг не наследуется', async () => {
    const { gw, server, owner, text } = await withChannels();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: slugOf('чат'), name: 'Читатель' });
    await gw.handleChatMessage(asSocket(reader), { text: 'привет' });
    reader.clear();

    expect(await gw.handleChannelDelete(asSocket(owner), { id: text.id })).toEqual({ ok: true });
    expect(reader.last('chat-closed')).toEqual({ slug: slugOf('чат') });
    expect(reader.data.chatRoom).toBeUndefined();

    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'чат' });
    const again = connect(gw, server, { id: 'again' });
    await gw.handleChatJoin(asSocket(again), { room: slugOf('чат'), name: 'Новичок' });
    expect(again.last('chat-history')).toMatchObject({
      slug: slugOf('чат'),
      messages: [],
      more: false,
    });
  });

  it('пустой id, дефолтный канал и гость — три разных отказа', async () => {
    const { gw, server, owner } = await withChannels();
    expect(await gw.handleChannelDelete(asSocket(owner), {})).toEqual({
      ok: false,
      error: 'not-found',
    });
    const def = (gw as AnyGw).registry.channels.find((c) => c.slug === 'obshchii')!;
    expect(await gw.handleChannelDelete(asSocket(owner), { id: def.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(await gw.handleChannelDelete(asSocket(guest), { id: def.id })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('срез канала: сколько внутри людей и сколько сообщений', async () => {
    const { gw, server, owner, text, voice } = await withChannels();
    const reader = connect(gw, server, { id: 'reader' });
    await gw.handleChatJoin(asSocket(reader), { room: slugOf('чат'), name: 'Читатель' });
    await gw.handleChatMessage(asSocket(reader), { text: 'раз' });
    await gw.handleChatMessage(asSocket(reader), { text: 'два' });
    expect(await gw.handleChannelStats(asSocket(owner), { id: text.id })).toEqual({
      ok: true,
      occupants: 1,
      messages: 2,
    });
    expect(await gw.handleChannelStats(asSocket(owner), { id: voice.id })).toEqual({
      ok: true,
      occupants: 0,
      messages: 0,
    });
  });

  it('срез чужого канала не выдают', async () => {
    const { gw, server, text } = await withChannels();
    const stranger = connect(gw, server, { clientId: 'dev-stranger' });
    expect(await gw.handleChannelStats(asSocket(stranger), { id: text.id })).toEqual({ ok: false });
  });

  it('канал закрытого сервера отвечает «нет доступа» раньше, чем «не твой»', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev-owner' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'скрытый',
    });
    const hidden = (gw as AnyGw).registry.channels.find((c) => c.slug === slugOf('скрытый'))!;

    // Тот же clientId, что у владельца: если бы владение проверялось первым,
    // ответ был бы «ok». Порядок проверок скрывает даже существование канала.
    const stranger = connect(gw, server, { clientId: 'dev-owner' });
    expect(
      await gw.handleChannelRename(asSocket(stranger), { id: hidden.id, name: 'моё' }),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

// ── Инвайты и пропуск в медиасервер ───────────────────────────────────────

describe('invite-create', () => {
  it('выдаёт токен на видимый голосовой канал', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    const res = gw.handleInviteCreate(asSocket(a), { room: 'voice-obshchii' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(verifyGuestToken(res.token)?.slug).toBe('voice-obshchii');
    expect(res.exp).toBeGreaterThan(Date.now());
  });

  it('на текстовый канал и на несуществующий — отказ', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server);
    expect(gw.handleInviteCreate(asSocket(a), { room: 'obshchii' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(gw.handleInviteCreate(asSocket(a), { room: 'нет' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('канал закрытого сервера не приглашает, пока пароль не введён', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const stranger = connect(gw, server);
    expect(gw.handleInviteCreate(asSocket(stranger), { room: slugOf('тайный эфир') })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(gw.handleInviteCreate(asSocket(owner), { room: slugOf('тайный эфир') })).toMatchObject({
      ok: true,
    });
  });

  it('гость инвайтов не раздаёт', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    expect(gw.handleInviteCreate(asSocket(guest), { room: 'voice-obshchii' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('ссылка в открытый канал раздаёт голос, в закрытый — только слух', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const open = gw.handleInviteCreate(asSocket(owner), { room: 'voice-obshchii' });
    expect(open).toMatchObject({ ok: true, listen: false });
    if (open.ok) expect(verifyGuestToken(open.token)?.listen).toBe(false);

    // Пароль запирает и голос: приглашающий раздаёт по ссылке ровно то, что
    // имеет сам, а пароля он не отдавал.
    const locked = gw.handleInviteCreate(asSocket(owner), { room: slugOf('тайный эфир') });
    expect(locked).toMatchObject({ ok: true, listen: true });
    if (locked.ok) expect(verifyGuestToken(locked.token)?.listen).toBe(true);
  });
});

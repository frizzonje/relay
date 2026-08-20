import { describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import type { Attachment } from '../uploads';
import { asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  personCookie,
  putUpload,
  settle,
  useGatewayStand,
} from './gateway.testkit';

/**
 * Чат-сессия: в какой ленте сидит сокет, под каким именем пишет и что из
 * сказанного ему видно.
 *
 * Пара «комната + имя» живёт и умирает вместе: имя без комнаты попадает в
 * ростер канала, из которого человек уже вышел, а комната без имени — это
 * участник, которого ростер молча пропускает.
 */

useGatewayStand();

// ── Текстовый канал ───────────────────────────────────────────────────────

describe('chat-join', () => {
  it('новичку — история и ростер', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatMessage(asSocket(a), { text: 'первое' });

    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    expect(b.last('chat-history')).toMatchObject({
      slug: 'obshchii',
      messages: [expect.objectContaining({ text: 'первое' })],
      more: false,
    });
    expect(b.last('chat-roster')).toEqual([{ nick: 'A' }, { nick: 'B' }]);
  });

  it('в составе — человек с лицом, а не имя строкой', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Аня' });
    expect(a.last('chat-roster')).toEqual([{ nick: 'Аня', fingerprint: anya.fingerprint }]);
  });

  it('одна личность с двух устройств — одна строка в составе', async () => {
    // 1.0 разрешает войти с телефона и с ноутбука разом. Без склейки по
    // отпечатку человек стоял бы в списке дважды — двумя строками с одинаковым
    // лицом и одинаковым именем, и «в сети — 2» на одного присутствующего.
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const phone = await connectAs(gw, server, anya.cookie, { id: 'phone' });
    const laptop = await connectAs(gw, server, anya.cookie, { id: 'laptop' });
    await gw.handleChatJoin(asSocket(phone), { room: 'obshchii', name: 'Аня' });
    await gw.handleChatJoin(asSocket(laptop), { room: 'obshchii', name: 'Аня' });
    expect(laptop.last('chat-roster')).toEqual([{ nick: 'Аня', fingerprint: anya.fingerprint }]);
  });

  it('гостей по инвайту склеивать нечем — каждый сам по себе', async () => {
    // У них нет ключа, и два одноимённых гостя — это и правда два человека.
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Аня' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'Аня' });
    expect(b.last('chat-roster')).toEqual([{ nick: 'Аня' }, { nick: 'Аня' }]);
  });

  it('несуществующий канал отвечает chat-closed, а не тишиной', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'нет-такого', name: 'A' });
    expect(a.last('chat-closed')).toEqual({ slug: 'нет-такого' });
    expect(a.data.chatRoom).toBeUndefined();
  });

  it('канал закрытого сервера молча не пускает — вводить пароль никто не запрещал', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });

    const stranger = connect(gw, server, { id: 'stranger' });
    await gw.handleChatJoin(asSocket(stranger), { room: 'тайный-чат', name: 'Ч' });
    expect(stranger.data.chatRoom).toBeUndefined();
    expect(stranger.got('chat-closed')).toBe(false);
  });

  it('неудачный вход не выбрасывает из канала, где человек уже сидит', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(a), { room: 'нет-такого', name: 'A' });
    expect(a.data.chatRoom).toBe('chat:obshchii');
  });

  it('переход в другой канал выводит из прежнего', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'мой' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'второй',
    });

    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(a), { room: 'второй', name: 'A' });
    expect(a.data.chatRoom).toBe('chat:второй');
    expect(a.rooms.has('chat:obshchii')).toBe(false);
  });

  it('без имени человек становится Анонимом', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii' });
    expect(a.data.chatName).toBe('Аноним');
  });

  it('выход из чата обновляет ростер оставшимся', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    b.clear();
    gw.handleChatLeave(asSocket(a));
    expect(b.last('chat-roster')).toEqual([{ nick: 'B' }]);
  });

  it('гость в текстовые каналы не заходит', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    await gw.handleChatJoin(asSocket(guest), { room: 'obshchii', name: 'Г' });
    expect(guest.data.chatRoom).toBeUndefined();
  });
});

describe('chat-message', () => {
  async function inChat() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    server.clearAll();
    return { gw, server, a, b };
  }

  it('сообщение доходит и до автора, и до соседа', async () => {
    const { gw, a, b } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    expect(a.last('chat')).toMatchObject({ name: 'A', text: 'привет' });
    expect(b.last('chat')).toMatchObject({ name: 'A', text: 'привет' });
  });

  it('пустое сообщение без вложения не отправляется', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: '   ' });
    await gw.handleChatMessage(asSocket(a), {});
    expect(a.got('chat')).toBe(false);
  });

  it('вне канала писать нечем', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    await gw.handleChatMessage(asSocket(loner), { text: 'ау' });
    expect(loner.got('chat')).toBe(false);
  });

  it('текст режется до 500 символов', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'я'.repeat(900) });
    expect((a.last('chat') as { text: string }).text).toHaveLength(500);
  });

  it('вложение берут из реестра, а не из тела сообщения', async () => {
    const { gw, a } = await inChat();
    await putUpload('up-1');
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'up-1' });
    expect((a.last('chat') as { attachment: Attachment }).attachment).toMatchObject({
      url: '/uploads/up-1',
      kind: 'image',
    });

    a.clear();
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'нет-такого' });
    expect(a.got('chat')).toBe(false);
  });

  it('спойлер — метка сообщения: общий реестр не мутируется', async () => {
    const { gw, a } = await inChat();
    const stored: Attachment = {
      url: '/uploads/up-1',
      name: 'кот.png',
      size: 10,
      mime: 'image/png',
      kind: 'image',
    };
    await putUpload('up-1');
    await gw.handleChatMessage(asSocket(a), { text: '', uploadId: 'up-1', spoiler: true });
    expect((a.last('chat') as { attachment: Attachment }).attachment.spoiler).toBe(true);
    expect(stored.spoiler).toBeUndefined();
  });

  it('ответ хранит снимок цитаты — правка оригинала его не трогает', async () => {
    const { gw, a, b } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'исходное' });
    const src = a.last('chat') as { id: string };
    await gw.handleChatMessage(asSocket(b), { text: 'ответ', replyTo: src.id });
    const reply = b.last('chat') as { replyTo?: { id: string; name: string; text: string } };
    expect(reply.replyTo).toEqual({ id: src.id, name: 'A', text: 'исходное' });

    await gw.handleChatEdit(asSocket(a), { id: src.id, text: 'переписал' });
    expect(reply.replyTo!.text).toBe('исходное');
  });

  it('ответ на несуществующее сообщение просто теряет цитату', async () => {
    const { gw, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'ответ', replyTo: 'нет-такого' });
    expect(a.last('chat')).not.toHaveProperty('replyTo');
  });

  it('в канал входят на последнюю страницу, остальное подтягивают вверх', async () => {
    const { gw, server, a } = await inChat();
    for (let i = 0; i < 60; i++) {
      await gw.handleChatMessage(asSocket(a), { text: `${i}` });
      vi.advanceTimersByTime(200);
    }
    const fresh = connect(gw, server, { id: 'fresh' });
    await gw.handleChatJoin(asSocket(fresh), { room: 'obshchii', name: 'F' });

    // Пятьдесят свежих и честное «выше есть ещё» — а не обрезанная лента,
    // молча притворяющаяся всей историей, как было до базы.
    const page = fresh.last('chat-history') as {
      messages: { text: string; id: string; ts: number }[];
      more: boolean;
    };
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0].text).toBe('10');
    expect(page.messages[49].text).toBe('59');
    expect(page.more).toBe(true);

    const top = page.messages[0];
    const older = await gw.handleChatHistoryMore(asSocket(fresh), {
      beforeTs: top.ts,
      beforeId: top.id,
    });
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
    // Выше десятого — начало канала, и это разные вещи с «страница кончилась».
    expect(older.more).toBe(false);
  });

  it('пинг активности схлопывается и уходит тем, кому канал виден', async () => {
    const { gw, server, a } = await inChat();
    const watcher = connect(gw, server, { id: 'watcher' });
    await gw.handleChatMessage(asSocket(a), { text: 'раз' });
    await gw.handleChatMessage(asSocket(a), { text: 'два' });
    settle();
    expect(watcher.all('chat-activity')).toHaveLength(1);
    expect(watcher.last('chat-activity')).toMatchObject({ slug: 'obshchii' });
  });

  it('активность в канале закрытого сервера посторонним не рассылают', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'text',
      name: 'тайный чат',
    });
    await gw.handleChatJoin(asSocket(owner), { room: 'тайный-чат', name: 'Х' });
    const stranger = connect(gw, server, { id: 'stranger' });
    settle();
    server.clearAll();

    await gw.handleChatMessage(asSocket(owner), { text: 'секрет' });
    settle();
    expect(stranger.got('chat-activity')).toBe(false);
    expect(owner.got('chat-activity')).toBe(true);
  });

  it('время последней реплики приезжает вместе с реестром каналов', async () => {
    const { gw, server, a } = await inChat();
    await gw.handleChatMessage(asSocket(a), { text: 'привет' });
    const ts = (a.last('chat') as { ts: number }).ts;
    const fresh = connect(gw, server, { id: 'fresh' });
    gw.handleConnection(asSocket(fresh));
    const channels = fresh.last('channels') as { slug: string; lastTs?: number }[];
    expect(channels.find((c) => c.slug === 'obshchii')?.lastTs).toBe(ts);
  });

  it('гость в чат не пишет', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    guest.data.chatRoom = 'chat:obshchii';
    await gw.handleChatMessage(asSocket(guest), { text: 'вторжение' });
    expect(guest.got('chat')).toBe(false);
  });
});

describe('chat-edit / chat-delete / chat-react / chat-typing', () => {
  async function withMessage() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'A' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii', name: 'B' });
    await gw.handleChatMessage(asSocket(a), { text: 'исходное' });
    const id = (a.last('chat') as { id: string }).id;
    server.clearAll();
    return { gw, server, a, b, id };
  }

  it('автор правит своё сообщение', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatEdit(asSocket(a), { id, text: 'переписал' });
    expect(b.last('chat-edited')).toMatchObject({ id, text: 'переписал' });
    expect((b.last('chat-edited') as { editedTs: number }).editedTs).toBeGreaterThan(0);
  });

  it('чужое сообщение не правят', async () => {
    const { gw, b, id } = await withMessage();
    await gw.handleChatEdit(asSocket(b), { id, text: 'подмена' });
    expect(b.got('chat-edited')).toBe(false);
  });

  it('пустой текст правки и правку без id игнорируют', async () => {
    const { gw, a, id } = await withMessage();
    await gw.handleChatEdit(asSocket(a), { id, text: '   ' });
    await gw.handleChatEdit(asSocket(a), { text: 'без id' });
    expect(a.got('chat-edited')).toBe(false);
  });

  it('автор удаляет своё сообщение, и оно пропадает из истории', async () => {
    const { gw, server, a, b, id } = await withMessage();
    await gw.handleChatDelete(asSocket(a), { id });
    expect(b.last('chat-deleted')).toEqual({ id });
    const fresh = connect(gw, server, { id: 'fresh' });
    await gw.handleChatJoin(asSocket(fresh), { room: 'obshchii', name: 'F' });
    expect(fresh.last('chat-history')).toMatchObject({ messages: [], more: false });
  });

  it('чужое и несуществующее сообщение не удаляют', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatDelete(asSocket(b), { id });
    await gw.handleChatDelete(asSocket(a), { id: 'нет-такого' });
    await gw.handleChatDelete(asSocket(a), {});
    expect(a.got('chat-deleted')).toBe(false);
  });

  it('реакция ставится и снимается тем же нажатием', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatReact(asSocket(b), { id, emoji: '🔥' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: { '🔥': ['B'] } });
    await gw.handleChatReact(asSocket(b), { id, emoji: '🔥' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: {} });
  });

  it('реакции складываются по участникам', async () => {
    const { gw, a, b, id } = await withMessage();
    await gw.handleChatReact(asSocket(a), { id, emoji: '👍' });
    await gw.handleChatReact(asSocket(b), { id, emoji: '👍' });
    expect(a.last('chat-reaction')).toEqual({ id, reactions: { '👍': ['A', 'B'] } });
  });

  it('эмодзи вне белого списка и чужой id не проходят', async () => {
    const { gw, a, id } = await withMessage();
    await gw.handleChatReact(asSocket(a), { id, emoji: '🍆' });
    await gw.handleChatReact(asSocket(a), { id: 'нет', emoji: '👍' });
    expect(a.got('chat-reaction')).toBe(false);
  });

  it('«печатает» уходит соседям, но не себе', async () => {
    const { gw, a, b } = await withMessage();
    gw.handleChatTyping(asSocket(a));
    expect(b.last('chat-typing')).toEqual({ name: 'A' });
    expect(a.got('chat-typing')).toBe(false);
  });

  it('вне канала правка, удаление, реакция и «печатает» молчат', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleChatTyping(asSocket(loner));
    await gw.handleChatEdit(asSocket(loner), { id: 'x', text: 'y' });
    await gw.handleChatDelete(asSocket(loner), { id: 'x' });
    await gw.handleChatReact(asSocket(loner), { id: 'x', emoji: '👍' });
    expect(loner.emitted).toHaveLength(0);
  });
});

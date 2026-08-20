import { describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  personCookie,
  settle,
  useGatewayStand,
} from './gateway.testkit';

/**
 * Упоминания: кого назвали, кому об этом сказать и сколько раз назвали, пока
 * человека не было.
 *
 * Общее правило у всех трёх — одно: упоминание не должно рассказывать о канале
 * больше, чем человеку видно. Слаг канала закрытого сервера сам по себе часть
 * секрета, по нему заходят.
 */

useGatewayStand();

describe('упоминания', () => {
  /** Дождаться того, что гейтвей делает после подключения асинхронно. */
  async function until(check: () => boolean, what = 'ожидаемое событие'): Promise<void> {
    for (let i = 0; i < 400 && !check(); i += 1) await vi.advanceTimersByTimeAsync(5);
    if (!check()) throw new Error(`не дождались: ${what}`);
  }

  /** Двое в одном канале — минимум, на котором упоминание кого-то означает. */
  async function twoInChannel() {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii' });
    await gw.handleChatJoin(asSocket(b), { room: 'obshchii' });
    a.clear();
    b.clear();
    return { gw, server, a, b, anya, boris };
  }

  it('названный получает вызов, а комната — обычную реплику', async () => {
    const { gw, a, b, anya } = await twoInChannel();

    await gw.handleChatMessage(asSocket(b), {
      text: '@Аня, ты идёшь?',
      mentions: [anya.fingerprint],
    });

    expect(a.last('mention')).toMatchObject({ slug: 'obshchii' });
    // Написавшему свой же вызов не возвращается: он и так знает, кого позвал.
    expect(b.got('mention')).toBe(false);
    // Сама реплика уходит всем, и упоминание едет в ней снимком.
    expect(a.last('chat')).toMatchObject({
      mentions: [{ fingerprint: anya.fingerprint, nick: 'Аня' }],
    });
  });

  it('названный, но не написанный, никого не зовёт', async () => {
    const { gw, a, b, anya } = await twoInChannel();

    // Отпечаток прислан, имени в тексте нет — беззвучный вызов, которого в
    // ленте не видно ни ему, ни остальным.
    await gw.handleChatMessage(asSocket(b), { text: 'просто текст', mentions: [anya.fingerprint] });

    expect(a.got('mention')).toBe(false);
    expect((a.last('chat') as { mentions?: unknown }).mentions).toBeUndefined();
  });

  it('ник в снимке — из базы, а не из тела сообщения', async () => {
    const { gw, a, b, anya } = await twoInChannel();
    await gw.handleChatMessage(asSocket(b), {
      text: '@Аня привет',
      mentions: [anya.fingerprint],
      name: 'кто угодно',
    });
    expect((a.last('chat') as { mentions: { nick: string }[] }).mentions[0].nick).toBe('Аня');
  });

  it('вызов доезжает на все устройства человека', async () => {
    const { gw, server, b, anya } = await twoInChannel();
    const phone = await connectAs(gw, server, anya.cookie, { id: 'phone' });

    await gw.handleChatMessage(asSocket(b), { text: '@Аня!', mentions: [anya.fingerprint] });

    // Телефон в канале не сидит — и всё равно обязан загореться: счётчик
    // «тебя звали» принадлежит человеку, а не открытой вкладке.
    expect(phone.last('mention')).toMatchObject({ slug: 'obshchii' });
  });

  it('своё имя в своей реплике себя не зовёт', async () => {
    const { gw, a, anya } = await twoInChannel();
    await gw.handleChatMessage(asSocket(a), {
      text: 'меня зовут @Аня',
      mentions: [anya.fingerprint],
    });
    expect(a.got('mention')).toBe(false);
  });

  it('вызов не летит туда, где канал не виден', async () => {
    const { gw, server } = await makeGateway({
      servers: [{ id: 'srv', name: 'тайный', removable: true, passwordHash: 'x:y' }],
      channels: [
        { id: 'c1', serverId: 'srv', type: 'text', name: 'тайны', slug: 'тайны', removable: true },
      ],
    });
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
    const b = await connectAs(gw, server, boris.cookie, { id: 'b' });
    // Борис пароль знает (подсовываем разблокировку), Аня — нет.
    (b.data.unlocked as Set<string>).add('srv');
    await gw.handleChatJoin(asSocket(b), { room: 'тайны' });
    a.clear();

    await gw.handleChatMessage(asSocket(b), { text: '@Аня, сюда', mentions: [anya.fingerprint] });

    // Слаг канала закрытого сервера — часть секрета: по нему туда и заходят.
    expect(a.got('mention')).toBe(false);
  });

  it('правка зовёт дописанного и молчит о том, кто уже был назван', async () => {
    const { gw, a, b, anya } = await twoInChannel();
    await gw.handleChatMessage(asSocket(b), { text: '@Аня раз', mentions: [anya.fingerprint] });
    const msg = b.last('chat') as { id: string };
    a.clear();

    // Правка опечатки при том же названном — не повод звонить второй раз.
    await gw.handleChatEdit(asSocket(b), {
      id: msg.id,
      text: '@Аня, раз!',
      mentions: [anya.fingerprint],
    });
    expect(a.got('mention')).toBe(false);
    expect(a.last('chat-edited')).toMatchObject({
      mentions: [{ fingerprint: anya.fingerprint, nick: 'Аня' }],
    });

    // А имя, убранное правкой, уносит с собой и упоминание.
    await gw.handleChatEdit(asSocket(b), { id: msg.id, text: 'неважно', mentions: [] });
    expect(a.last('chat-edited')).toMatchObject({ mentions: [] });
  });

  it('снимок счётчиков приезжает на подключении', async () => {
    const { gw, server, b, anya } = await twoInChannel();
    await gw.handleChatMessage(asSocket(b), { text: '@Аня!', mentions: [anya.fingerprint] });

    const again = await connectAs(gw, server, anya.cookie, { id: 'again', keep: true });
    await until(() => again.got('mentions'), 'счётчик упоминаний');
    expect(again.last('mentions')).toEqual({ counts: { obshchii: 1 } });
  });

  it('после ввода пароля счётчики закрытого сервера доезжают, не дожидаясь перезахода', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Борис');
    const owner = await connectAs(gw, server, boris.cookie, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'пароль' });
    await gw.handleChannelCreate(asSocket(owner), { serverId: 'srv', type: 'text', name: 'тайны' });
    settle();
    await gw.handleChatJoin(asSocket(owner), { room: 'тайны' });
    await gw.handleChatMessage(asSocket(owner), {
      text: '@Аня, сюда',
      mentions: [anya.fingerprint],
    });

    const a = await connectAs(gw, server, anya.cookie, { id: 'a', keep: true });
    await until(() => a.got('mentions'), 'счётчик упоминаний');
    // Пока сервер заперт, о его каналах ей знать неоткуда.
    expect(a.last('mentions')).toEqual({ counts: {} });

    a.clear();
    await gw.handleServerUnlock(asSocket(a), { id: 'srv', password: 'пароль' });
    await until(() => a.got('mentions'), 'счётчик упоминаний');
    expect(a.last('mentions')).toEqual({ counts: { тайны: 1 } });
  });

  describe('подсказка после «@»', () => {
    it('называет тех, кто здесь сейчас, — и себя в список не кладёт', async () => {
      const { gw, a } = await twoInChannel();
      const res = await gw.handleMentionSuggest(asSocket(a), { prefix: '' });
      expect(res.people).toEqual([
        { fingerprint: expect.any(String), nick: 'Борис', online: true },
      ]);
    });

    it('и тех, кто здесь говорил, — по началу имени', async () => {
      const { gw, server, a, b } = await twoInChannel();
      await gw.handleChatMessage(asSocket(b), { text: 'я тут был' });
      b.disconnect();
      server.remove('b');

      const res = await gw.handleMentionSuggest(asSocket(a), { prefix: 'бор' });
      expect(res.people).toEqual([
        { fingerprint: expect.any(String), nick: 'Борис', online: false },
      ]);
      expect((await gw.handleMentionSuggest(asSocket(a), { prefix: 'зю' })).people).toEqual([]);
    });

    it('не предлагает того, кому этот канал не виден', async () => {
      const { gw, server } = await makeGateway({
        servers: [{ id: 'srv', name: 'тайный', removable: true, passwordHash: 'x:y' }],
        channels: [
          {
            id: 'c1',
            serverId: 'srv',
            type: 'text',
            name: 'тайны',
            slug: 'тайны',
            removable: true,
          },
        ],
      });
      const anya = await personCookie('Аня');
      const boris = await personCookie('Борис');
      const a = await connectAs(gw, server, anya.cookie, { id: 'a' });
      await connectAs(gw, server, boris.cookie, { id: 'b' });
      (a.data.unlocked as Set<string>).add('srv');
      await gw.handleChatJoin(asSocket(a), { room: 'тайны' });

      // Предложить позвать Бориса значило бы предложить позвать его в комнату
      // за дверью, ключа от которой у него нет.
      expect((await gw.handleMentionSuggest(asSocket(a), { prefix: '' })).people).toEqual([]);
    });

    it('вне канала и гостю — пустой список, а не отказ', async () => {
      const { gw, server } = await makeGateway();
      const nobody = connect(gw, server, { id: 'n' });
      expect(await gw.handleMentionSuggest(asSocket(nobody), { prefix: '' })).toEqual({
        ok: true,
        people: [],
      });

      const { token } = issueGuestToken('voice-obshchii');
      const guest = connect(gw, server, { guest: token });
      expect(await gw.handleMentionSuggest(asSocket(guest), { prefix: 'а' })).toEqual({
        ok: true,
        people: [],
      });
    });

    it('мусор вместо префикса — тот же список, а не ошибка', async () => {
      const { gw, a } = await twoInChannel();
      for (const prefix of [undefined, 42 as unknown as string, { nope: true }]) {
        expect(await gw.handleMentionSuggest(asSocket(a), { prefix })).toMatchObject({ ok: true });
      }
    });
  });
});

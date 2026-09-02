import { describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { Presence, type PresenceEntry, type PresenceState } from './presence';
import { asSocket, type FakeServer, type FakeSocket } from './testkit';
import {
  connectAs,
  disconnect,
  makeGateway,
  personCookie,
  settle,
  useGatewayStand,
} from './gateway.testkit';
import type { SignalingGateway } from './signaling.gateway';

/**
 * Глобальное присутствие личности: где человек вообще, а не кто в этой комнате.
 *
 * Пер-канальный `voice-presence` отвечает на второй вопрос и для дозвона не
 * годится — звонят человеку, а не комнате. Поэтому здесь проверяется ровно то,
 * чем присутствие отличается от состава эфира: запись у личности одна на все её
 * устройства, уход не мгновенен, а рассылка коалесцируется.
 */

useGatewayStand();

/** Что сказала последняя дельта: отпечаток → состояние. */
function delta(sock: FakeSocket): Record<string, PresenceState> {
  const last = (sock.last('presence-update') ?? []) as PresenceEntry[];
  return Object.fromEntries(last.map((e) => [e.fingerprint, e.state]));
}

/**
 * Присутствие глазами НОВОГО сокета этой личности.
 *
 * Спросить владельца напрямую нельзя — он приватное поле гейтвея, — а снимок на
 * подключении и есть его ответ на «как оно сейчас». Заодно это проверяет, что
 * снимок и дельта говорят одно и то же.
 */
async function seen(
  gw: SignalingGateway,
  server: FakeServer,
  cookie: string,
  id: string,
): Promise<Record<string, PresenceState>> {
  const sock = await connectAs(gw, server, cookie, { id, keep: true });
  const list = (sock.last('presence') ?? []) as PresenceEntry[];
  return Object.fromEntries(list.map((e) => [e.fingerprint, e.state]));
}

describe('присутствие личности', () => {
  it('человек в сети, пока у него есть хоть один сокет', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Боря');
    const phone = await connectAs(gw, server, anya.cookie, { id: 'телефон' });
    await connectAs(gw, server, anya.cookie, { id: 'ноутбук' });
    const watcher = await connectAs(gw, server, boris.cookie, { id: 'боря' });
    settle();
    server.clearAll();

    disconnect(gw, server, phone);
    settle();

    // Ушло устройство, а не человек: остальным сказать нечего.
    expect(watcher.all('presence-update')).toEqual([]);
    expect(await seen(gw, server, boris.cookie, 'ещё-боря')).toMatchObject({
      [anya.fingerprint]: 'online',
    });
  });

  it('ушедший становится «недавно», а не «офлайн» мгновенно', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Боря');
    const sock = await connectAs(gw, server, anya.cookie, { id: 'аня' });
    const watcher = await connectAs(gw, server, boris.cookie, { id: 'боря' });
    settle();
    server.clearAll();

    disconnect(gw, server, sock);
    settle();
    expect(delta(watcher)).toEqual({ [anya.fingerprint]: 'recent' });

    watcher.clear();
    vi.advanceTimersByTime(Presence.RECENT_MS);
    expect(delta(watcher)).toEqual({ [anya.fingerprint]: 'offline' });
  });

  it('вошедший в голосовой канал показывается «в голосе»', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const boris = await personCookie('Боря');
    const sock = await connectAs(gw, server, anya.cookie, { id: 'аня' });
    const watcher = await connectAs(gw, server, boris.cookie, { id: 'боря' });
    settle();
    server.clearAll();

    gw.handleJoin(asSocket(sock), { room: 'voice-obshchii', name: 'Аня' });
    settle();
    expect(delta(watcher)).toEqual({ [anya.fingerprint]: 'in-voice' });

    watcher.clear();
    gw.handleLeave(asSocket(sock));
    settle();
    expect(delta(watcher)).toEqual({ [anya.fingerprint]: 'online' });
  });

  it('дельта уходит один раз на пачку изменений', async () => {
    const { gw, server } = await makeGateway();
    const boris = await personCookie('Боря');
    const watcher = await connectAs(gw, server, boris.cookie, { id: 'боря' });
    settle();
    server.clearAll();

    const anya = await personCookie('Аня');
    const vera = await personCookie('Вера');
    const gleb = await personCookie('Глеб');
    await connectAs(gw, server, anya.cookie, { id: 'аня' });
    await connectAs(gw, server, vera.cookie, { id: 'вера' });
    await connectAs(gw, server, gleb.cookie, { id: 'глеб' });
    settle();

    expect(watcher.all('presence-update')).toHaveLength(1);
    expect(delta(watcher)).toEqual({
      [anya.fingerprint]: 'online',
      [vera.fingerprint]: 'online',
      [gleb.fingerprint]: 'online',
    });
  });

  it('гость по инвайту в присутствии не появляется', async () => {
    const { gw, server } = await makeGateway();
    const anya = await personCookie('Аня');
    const watcher = await connectAs(gw, server, anya.cookie, { id: 'аня' });
    settle();
    server.clearAll();

    const { token } = issueGuestToken('voice-obshchii');
    const guest = server.connect({ id: 'гость', auth: { guest: token } });
    gw.handleConnection(asSocket(guest));
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'гость' });
    settle();

    // Присутствия гость не получает вовсе: личности у него нет, звонить ему
    // некуда и незачем.
    expect(guest.got('presence')).toBe(false);
    expect(guest.all('presence-update')).toEqual([]);
    // И в чужой картине его нет — даже войдя в эфир.
    expect(watcher.all('presence-update')).toEqual([]);
    expect(Object.keys(await seen(gw, server, anya.cookie, 'ещё-аня'))).toEqual([anya.fingerprint]);
  });
});

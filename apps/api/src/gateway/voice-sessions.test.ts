import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { asSocket, type FakeSocket } from './testkit';
import { DmService } from './dm.service';
import { callRoom } from './voice-sessions';
import {
  connect,
  connectAs,
  disconnect,
  makeGateway,
  personCookie,
  settle,
  slugOf,
  tune,
  useGatewayStand,
} from './gateway.testkit';
import type { SignalingGateway } from './signaling.gateway';

/**
 * Голосовая сессия: кто в эфире, что о нём знают остальные и как между
 * участниками ходит сигналинг.
 *
 * Состав эфира — единственное состояние гейтвея, которое видно всем сразу:
 * ошибка здесь показывает человека там, где его нет, или прячет там, где он
 * есть. Поэтому и проверяется не «дошло ли», а КОМУ ушло.
 */

// Живость медиасервера — сетевой пинг с кэшем на уровне модуля. Кэш пережил бы
// границу теста, поэтому подменяем целиком.
const sfuHealthy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../sfu/sfu-health', () => ({ sfuHealthy }));

useGatewayStand();

beforeEach(() => {
  sfuHealthy.mockResolvedValue(true);
});

// ── Голосовой канал ───────────────────────────────────────────────────────

describe('join / leave', () => {
  it('новичку — список пиров, остальным — уведомление', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    b.clear();
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });

    expect(b.last('peers')).toEqual([{ id: 'a', name: 'A' }]);
    expect(a.last('peer-joined')).toEqual({ id: 'b', name: 'B' });
    expect(b.got('peer-joined')).toBe(false);
  });

  it('пустая комната игнорируется, длинная — обрезается', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: '   ' });
    expect(a.data.room).toBeUndefined();
    gw.handleJoin(asSocket(a), { room: 'к'.repeat(100) });
    // Потолок имени комнаты (`LIMIT.room`) шире слага канала: в него обязан
    // помещаться адрес комнаты беседы — он длиннее слага на приставку.
    expect((a.data.room as string).length).toBe(40);
  });

  it('повторный join выводит из прежней комнаты', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(watcher), { room: 'voice-obshchii', name: 'W' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    watcher.clear();
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(watcher.last('peer-left')).toEqual({ id: 'a' });
    expect(a.rooms.has('voice-obshchii')).toBe(false);
  });

  it('перезагрузка страницы не двоит участника: призрак прошлой вкладки уходит', async () => {
    const { gw, server } = await makeGateway();
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(watcher), { room: 'voice-obshchii', name: 'W' });

    const first = connect(gw, server, { id: 'tab-1', clientId: 'dev-a' });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'A' });
    // Вкладку перезагрузили: сокета уже нет, а комната о нём ещё помнит.
    gw.handleDisconnect(asSocket(first));
    server.all.delete('tab-1');
    watcher.clear();

    const second = connect(gw, server, { id: 'tab-2', clientId: 'dev-a' });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'A' });
    expect(watcher.all('peer-left')).toContainEqual({ id: 'tab-1' });
    expect((second.last('peers') as { id: string }[]).map((p) => p.id)).toEqual(['watcher']);
  });

  it('второй живой таб того же устройства выводится штатно', async () => {
    const { gw, server } = await makeGateway();
    const first = connect(gw, server, { id: 'tab-1', clientId: 'dev-a' });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'A' });
    const second = connect(gw, server, { id: 'tab-2', clientId: 'dev-a' });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'A' });
    expect(first.data.room).toBeUndefined();
  });

  it('отвалившийся пир не попадает в список пиров новичка', async () => {
    const { gw, server } = await makeGateway();
    const ghost = connect(gw, server, { id: 'ghost' });
    gw.handleJoin(asSocket(ghost), { room: 'voice-obshchii', name: 'G' });
    server.all.delete('ghost');

    const fresh = connect(gw, server, { id: 'fresh' });
    gw.handleJoin(asSocket(fresh), { room: 'voice-obshchii', name: 'F' });
    expect(fresh.last('peers')).toEqual([]);
  });

  it('транспорт называет клиент, а молчащему его подставляет выданный пропуск', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A', transport: 'sfu' });
    expect(a.data.transport).toBe('sfu');

    const b = connect(gw, server, { id: 'b' });
    await gw.handleSfuToken(asSocket(b), { room: 'voice-obshchii-sfu', name: 'B' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii-sfu', name: 'B' });
    expect(b.data.transport).toBe('sfu');

    const c = connect(gw, server, { id: 'c' });
    gw.handleJoin(asSocket(c), { room: 'voice-obshchii', name: 'C' });
    expect(c.data.transport).toBe('p2p');
  });

  it('пропуск в медиасервер не переживает уход из канала', async () => {
    // Сервер догадывается о транспорте клиента, который его не называет, по
    // выданному пропуску. Пропуск, забытый от прошлого канала, превращает
    // обычный p2p-звонок в «расщеплённый»: остальные видят участника «через
    // медиасервер» и получают красное «тебя не слышат» в исправном канале.
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });

    await gw.handleSfuToken(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(a.data.transport).toBe('sfu');

    // Ушёл в обычный канал. Клиент прошлой версии транспорт не называет.
    gw.handleLeave(asSocket(a));
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    expect(a.data.transport).toBe('p2p');
  });

  it('отказ в пропуске стирает прошлый — иначе он врёт про транспорт', async () => {
    // Переход без выхода: клиент спрашивает пропуск в новый канал и получает
    // «это не sfu-канал». Этого ответа достаточно, чтобы прежний пропуск
    // перестал что-либо значить.
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    await gw.handleSfuToken(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });

    const denied = await gw.handleSfuToken(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    expect(denied).toMatchObject({ ok: false, error: 'not-sfu' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    expect(a.data.transport).toBe('p2p');
  });

  it('расщепление комнаты по транспортам попадает в лог', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A', transport: 'p2p' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B', transport: 'sfu' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('split across transports'))).toBe(
      true,
    );
  });

  it('в канал закрытого сервера по одному слагу не войти', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });

    const stranger = connect(gw, server, { id: 'stranger' });
    gw.handleJoin(asSocket(stranger), { room: slugOf('тайный эфир'), name: 'Ч' });
    expect(stranger.data.room).toBeUndefined();
  });

  it('комната-сирота (канал удалили под разговором) остаётся доступной', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'ничей-эфир', name: 'A' });
    expect(a.data.room).toBe('ничей-эфир');
  });

  it('гость не заходит в чужую комнату, но в свою — да', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii-sfu', name: 'Г' });
    expect(guest.data.room).toBeUndefined();
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });
    expect(guest.data.room).toBe('voice-obshchii');
  });

  it('гость помечен гостем и в списке пиров, и в уведомлении', async () => {
    const { gw, server } = await makeGateway();
    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });

    const host = connect(gw, server, { id: 'host' });
    gw.handleJoin(asSocket(host), { room: 'voice-obshchii', name: 'Х' });
    expect(host.last('peers')).toEqual([{ id: 'guest', name: 'Г', guest: true }]);
    expect(guest.last('peer-joined')).toEqual({ id: 'host', name: 'Х' });
  });

  it('clientId из join принимают только если в handshake его не было', async () => {
    const { gw, server } = await makeGateway();
    const named = connect(gw, server, { id: 'a', clientId: 'dev-настоящий' });
    gw.handleJoin(asSocket(named), { room: 'voice-obshchii', name: 'A', clientId: 'dev-чужой' });
    expect(named.data.clientId).toBe('dev-настоящий');

    const silent = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(silent), { room: 'voice-obshchii', name: 'B', clientId: 'dev-старый' });
    expect(silent.data.clientId).toBe('dev-старый');
  });

  it('выход снимает состояние сокета и сообщает комнате', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a', clientId: 'dev-a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleLeave(asSocket(a));
    expect(b.last('peer-left')).toEqual({ id: 'a' });
    expect(a.data.room).toBeUndefined();
    expect(a.data.transport).toBeUndefined();
  });

  it('выход из комнаты, в которой не был, — не событие', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleLeave(asSocket(a));
    expect(b.got('peer-left')).toBe(false);
  });
});

describe('presence', () => {
  it('состав эфиров рассылают всем, включая тех, кто сам не в звонке', async () => {
    const { gw, server } = await makeGateway();
    const talker = connect(gw, server, { id: 'talker' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(talker), { room: 'voice-obshchii', name: 'Т' });
    settle();
    expect(watcher.last('voice-presence')).toEqual({
      'voice-obshchii': [
        { id: 'talker', name: 'Т', micOn: true, deafened: false, transport: 'p2p' },
      ],
    });
  });

  it('пачка событий схлопывается в одну рассылку', async () => {
    const { gw, server } = await makeGateway();
    const watcher = connect(gw, server, { id: 'watcher' });
    for (let i = 0; i < 5; i++) {
      const s = connect(gw, server, { id: `p${i}` });
      gw.handleJoin(asSocket(s), { room: 'voice-obshchii', name: `P${i}` });
    }
    watcher.clear();
    settle();
    expect(watcher.all('voice-presence')).toHaveLength(1);
  });

  it('комнату, за которой нет видимого канала, посторонним не показывают', async () => {
    const { gw, server } = await makeGateway();
    const inventor = connect(gw, server, { id: 'inventor' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(inventor), { room: 'выдуманный-канал', name: 'И' });
    settle();
    expect(watcher.last('voice-presence')).toEqual({});
    // А сам он свою комнату видит: не показать было бы враньём.
    expect(Object.keys(inventor.last('voice-presence') as object)).toEqual(['выдуманный-канал']);
  });

  it('эфир закрытого сервера не виден до ввода пароля', async () => {
    const { gw, server } = await makeGateway();
    const owner = connect(gw, server, { id: 'owner', clientId: 'dev' });
    await gw.handleServerCreate(asSocket(owner), { id: 'srv', name: 'тайный', password: 'п' });
    await gw.handleChannelCreate(asSocket(owner), {
      serverId: 'srv',
      type: 'voice',
      name: 'тайный эфир',
    });
    gw.handleJoin(asSocket(owner), { room: 'тайный-эфир', name: 'Х' });

    const stranger = connect(gw, server, { id: 'stranger' });
    settle();
    expect(stranger.last('voice-presence')).toEqual({});
    expect(Object.keys(owner.last('voice-presence') as object)).toContain('тайный-эфир');
  });

  it('гостю достаётся только его комната', async () => {
    const { gw, server } = await makeGateway();
    const other = connect(gw, server, { id: 'other' });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii-sfu', name: 'O' });

    const { token } = issueGuestToken('voice-obshchii');
    const guest = connect(gw, server, { id: 'guest', guest: token });
    gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: 'Г' });
    guest.clear();
    settle();
    expect(Object.keys(guest.last('voice-presence') as object)).toEqual(['voice-obshchii']);
  });

  it('безымянный участник показывается как Аноним', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii' });
    settle();
    const presence = a.last('voice-presence') as Record<string, { name: string }[]>;
    expect(presence['voice-obshchii'][0].name).toBe('Аноним');
  });
});

describe('media-update', () => {
  /** Заход + первое состояние медиа, как его шлёт живой клиент сразу после join. */
  async function inCall() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    const watcher = connect(gw, server, { id: 'watcher' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    gw.handleMediaUpdate(asSocket(a), {});
    settle();
    server.clearAll();
    return { gw, server, a, b, watcher };
  }

  it('состояние камеры и экрана уходит в комнату, но не в presence', async () => {
    const { gw, a, b, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { camOn: true, screenOn: true });
    expect(b.last('media-update')).toEqual({
      from: 'a',
      camOn: true,
      screenOn: true,
      micOn: true,
      deafened: false,
    });
    settle();
    expect(watcher.got('voice-presence')).toBe(false);
  });

  it('смена мута доходит до presence — индикаторы видны и вне эфира', async () => {
    const { gw, a, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false, deafened: true });
    settle();
    const presence = watcher.last('voice-presence') as Record<string, Record<string, unknown>[]>;
    expect(presence['voice-obshchii'].find((p) => p.id === 'a')).toMatchObject({
      micOn: false,
      deafened: true,
    });
  });

  it('повтор того же состояния на весь сервер не рассылают', async () => {
    const { gw, server, a, watcher } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    settle();
    server.clearAll();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    settle();
    expect(watcher.got('voice-presence')).toBe(false);
  });

  it('вне эфира media-update ничего не делает', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleMediaUpdate(asSocket(loner), { micOn: false });
    expect(loner.data.micOn).toBeUndefined();
  });

  it('новый заход не тащит мут прошлого', async () => {
    const { gw, a } = await inCall();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(a.data.micOn).toBeUndefined();
  });
});

describe('сигналинг', () => {
  async function pair() {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    settle();
    server.clearAll();
    return { gw, server, a, b };
  }

  it('offer доходит адресату вместе с именем отправителя', async () => {
    const { gw, a, b } = await pair();
    gw.handleOffer(asSocket(a), { to: 'b', sdp: 'v=0' });
    expect(b.last('offer')).toEqual({ from: 'a', name: 'A', sdp: 'v=0' });
  });

  it('answer и ice-candidate ходят так же', async () => {
    const { gw, a, b } = await pair();
    gw.handleAnswer(asSocket(b), { to: 'a', sdp: 'v=0-ответ' });
    gw.handleIceCandidate(asSocket(a), { to: 'b', candidate: { candidate: 'host' } });
    expect(a.last('answer')).toEqual({ from: 'b', sdp: 'v=0-ответ' });
    expect(b.last('ice-candidate')).toEqual({ from: 'a', candidate: { candidate: 'host' } });
  });

  it('в чужую комнату сигнал не пересылают', async () => {
    const { gw, server, a } = await pair();
    const outsider = connect(gw, server, { id: 'outsider' });
    gw.handleJoin(asSocket(outsider), { room: 'voice-obshchii-sfu', name: 'O' });
    outsider.clear();
    gw.handleOffer(asSocket(a), { to: 'outsider', sdp: 'v=0' });
    expect(outsider.got('offer')).toBe(false);
  });

  it('несуществующий адресат, нестроковый адрес и отправитель вне комнаты — молчание', async () => {
    const { gw, server } = await makeGateway();
    const loner = connect(gw, server, { id: 'loner' });
    gw.handleOffer(asSocket(loner), { to: 'нет', sdp: 'v=0' });
    gw.handleOffer(asSocket(loner), { to: 42, sdp: 'v=0' });
    expect(loner.emitted).toHaveLength(0);
  });
});

describe('rename', () => {
  it('меняет подпись в эфире и в ростере чата', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'Старое' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    await gw.handleChatJoin(asSocket(a), { room: 'obshchii', name: 'Старое' });
    settle();
    server.clearAll();

    await gw.handleRename(asSocket(a), { name: 'Новое' });
    expect(b.last('peer-renamed')).toEqual({ id: 'a', name: 'Новое' });
    expect(a.last('chat-roster')).toEqual([{ nick: 'Новое' }]);
    settle();
    const presence = b.last('voice-presence') as Record<string, { name: string }[]>;
    expect(presence['voice-obshchii'].map((p) => p.name)).toContain('Новое');
  });

  it('новое имя доезжает до всех устройств человека, а не до одного', async () => {
    // Имя принадлежит личности. Переименовавшись с телефона, человек обязан
    // смениться и в той комнате, где сидит его же десктоп: до этой правки
    // второе устройство несло старое имя до перезахода — и в подписи плитки,
    // и в ростере, и в presence.
    const { gw, server, identities } = await makeGateway();
    const { cookie } = await personCookie('Аня');
    const phone = await connectAs(gw, server, cookie, { id: 'phone' });
    const desk = await connectAs(gw, server, cookie, { id: 'desk' });
    const other = connect(gw, server, { id: 'other' });

    gw.handleJoin(asSocket(desk), { room: 'voice-obshchii' });
    gw.handleJoin(asSocket(other), { room: 'voice-obshchii', name: 'Борис' });
    await gw.handleChatJoin(asSocket(desk), { room: 'obshchii' });
    settle();
    server.clearAll();

    const speaker = phone.data.identity as { id: string };
    await identities.rename(speaker.id, 'Аня-Б');
    await gw.handleRename(asSocket(phone), { name: 'Аня-Б' });
    settle();

    // Комната узнаёт о смене от того устройства, которое в ней сидит: id в
    // событии — это id плитки, и id телефона переименовал бы не ту.
    expect(other.last('peer-renamed')).toEqual({ id: 'desk', name: 'Аня-Б' });
    expect(desk.last('chat-roster')).toEqual([{ nick: 'Аня-Б', fingerprint: expect.any(String) }]);
    const presence = other.last('voice-presence') as Record<string, { name: string }[]>;
    expect(presence['voice-obshchii'].map((p) => p.name)).toContain('Аня-Б');
    // И сам экран второго устройства: без этого он до перезахода подписывает
    // реплики прежним именем, споря с ростером, который сервер уже переписал.
    expect(desk.last('renamed')).toEqual({ name: 'Аня-Б' });
    expect(phone.got('renamed')).toBe(false);
  });

  it('пустое имя и то же имя ничего не меняют', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    await gw.handleRename(asSocket(a), { name: '  ' });
    await gw.handleRename(asSocket(a), { name: 'A' });
    expect(b.got('peer-renamed')).toBe(false);
  });
});

/**
 * Настройки голоса. Проверяется ровно то, ради чего они заведены: пока панель
 * не открывали, ничего не изменилось, — а когда владелец что-то запретил,
 * человек узнаёт об этом словами, а не тишиной. Молчаливый отказ здесь дороже,
 * чем где-либо: `join` клиент не отличает от удавшегося, и «я в канале, меня
 * не слышат» разбирается потом только по серверному логу.
 */
describe('настройки голоса', () => {
  it('панель не открывали: в канал пускают всех, кто до него дошёл', async () => {
    const { gw, server } = await makeGateway();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const sock = connect(gw, server, { id });
      gw.handleJoin(asSocket(sock), { room: 'voice-obshchii', name: id });
      expect(sock.data.room).toBe('voice-obshchii');
      expect(sock.got('voice-refused')).toBe(false);
    }
  });

  it('сверх предела не пускают и говорят почему', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'spaces.maxVoiceOccupants', 2);
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    const c = connect(gw, server, { id: 'c' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleJoin(asSocket(c), { room: 'voice-obshchii', name: 'C' });

    expect(c.data.room).toBeUndefined();
    expect(c.last('voice-refused')).toEqual({ reason: 'room-full' });
    // Разговор двоих отказ третьему не задевает ничем.
    expect(b.got('peer-joined')).toBe(false);
    expect(a.data.room).toBe('voice-obshchii');
  });

  it('отказ не выкидывает из той комнаты, где человек уже сидел', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'spaces.maxVoiceOccupants', 1);
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii-sfu', name: 'B' });

    gw.handleJoin(asSocket(a), { room: 'voice-obshchii-sfu', name: 'A' });
    expect(a.last('voice-refused')).toEqual({ reason: 'room-full' });
    expect(a.data.room).toBe('voice-obshchii');
  });

  it('своего же призрака в счёт не берут: перезагрузка вкладки не запирает канал', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'spaces.maxVoiceOccupants', 1);
    const first = connect(gw, server, { id: 'таб-1', clientId: 'устройство' });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'A' });
    // Перезагрузка страницы: новый socket.id, то же устройство.
    const second = connect(gw, server, { id: 'таб-2', clientId: 'устройство' });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'A' });

    expect(second.got('voice-refused')).toBe(false);
    expect(second.data.room).toBe('voice-obshchii');
  });

  it('панель не открывали: гостей по ссылке приходит сколько угодно', async () => {
    const { gw, server } = await makeGateway();
    for (const id of ['г-1', 'г-2', 'г-3']) {
      const { token } = issueGuestToken('voice-obshchii');
      const guest = connect(gw, server, { id, guest: token });
      gw.handleJoin(asSocket(guest), { room: 'voice-obshchii', name: id });
      expect(guest.data.room).toBe('voice-obshchii');
    }
  });

  it('гостей больше предела не пускают, а своих это не касается', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'invites.maxGuestsPerChannel', 1);
    const first = connect(gw, server, {
      id: 'г-1',
      guest: issueGuestToken('voice-obshchii').token,
    });
    gw.handleJoin(asSocket(first), { room: 'voice-obshchii', name: 'Г1' });

    const second = connect(gw, server, {
      id: 'г-2',
      guest: issueGuestToken('voice-obshchii').token,
    });
    gw.handleJoin(asSocket(second), { room: 'voice-obshchii', name: 'Г2' });
    expect(second.data.room).toBeUndefined();
    // Причина своя: «канал полон» человек переждёт, а тут ждать нечего —
    // ссылка своё отработала, и звать надо иначе.
    expect(second.last('voice-refused')).toEqual({ reason: 'guests-full' });

    // Предел на гостей защищает канал от разошедшейся ссылки, а не от своих.
    const host = connect(gw, server, { id: 'свой' });
    gw.handleJoin(asSocket(host), { room: 'voice-obshchii', name: 'Х' });
    expect(host.data.room).toBe('voice-obshchii');
  });

  it('панель не открывали: камера и экран включаются как прежде', async () => {
    const { gw, server } = await makeGateway();
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleMediaUpdate(asSocket(a), { camOn: true, screenOn: true });

    expect(b.last('media-update')).toMatchObject({ camOn: true, screenOn: true });
    expect(a.got('voice-refused')).toBe(false);
  });

  it('выключённое видео не даёт включить камеру и говорит почему', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'voice.videoEnabled', false);
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleMediaUpdate(asSocket(a), { camOn: true });

    // Плитка «с камерой» при выключенном видео — худший из ответов: человек
    // считал бы, что его видно.
    expect(b.last('media-update')).toMatchObject({ camOn: false });
    expect(a.last('voice-refused')).toEqual({ reason: 'video-off' });
    // Экран при этом не задет: запреты разные и живут порознь.
    a.clear();
    b.clear();
    gw.handleMediaUpdate(asSocket(a), { screenOn: true });
    expect(b.last('media-update')).toMatchObject({ screenOn: true });
    expect(a.got('voice-refused')).toBe(false);
  });

  it('выключённая демонстрация экрана отвечает своей причиной', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'voice.screenShareEnabled', false);
    const a = connect(gw, server, { id: 'a' });
    const b = connect(gw, server, { id: 'b' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    gw.handleJoin(asSocket(b), { room: 'voice-obshchii', name: 'B' });
    b.clear();
    gw.handleMediaUpdate(asSocket(a), { camOn: true, screenOn: true });

    expect(b.last('media-update')).toMatchObject({ camOn: true, screenOn: false });
    expect(a.last('voice-refused')).toEqual({ reason: 'screen-share-off' });
  });

  it('выключённое не жалуется тому, кто его и не включал', async () => {
    const { gw, server, settings } = await makeGateway();
    await tune(settings, 'voice.videoEnabled', false);
    await tune(settings, 'voice.screenShareEnabled', false);
    const a = connect(gw, server, { id: 'a' });
    gw.handleJoin(asSocket(a), { room: 'voice-obshchii', name: 'A' });
    a.clear();
    gw.handleMediaUpdate(asSocket(a), { micOn: false });
    expect(a.got('voice-refused')).toBe(false);
  });
});

// ── Комната беседы ────────────────────────────────────────────────────────

/**
 * Разговор двоих: комната, которую открыл принятый вызов.
 *
 * От обычного голосового канала она отличается тремя вещами, и все три —
 * заслоны, а не украшения: войти в неё могут только двое, названные её
 * адресом; уход любого из них кончает разговор для второго; медиасервера для
 * двоих не бывает никогда. Первое проверяется тем, что третьему отказано
 * СЛЫШНО: молчащий отказ клиент не отличает от удавшегося входа.
 */
describe('комната беседы', () => {
  /** Двое приняли вызов: сокеты обоих и адрес открывшейся комнаты. */
  async function talk() {
    const stand = await makeGateway();
    const { gw, server, settings } = stand;
    // Умолчание каталога — «звонить тому, с кем есть переписка»; заводить её
    // здесь значило бы проверять ЛС, а не комнату.
    await tune(settings, 'calls.whoCanCall', 'everyone');
    const anya = await personCookie('Аня');
    const boris = await personCookie('Боря');
    const hers = await connectAs(gw, server, anya.cookie, { id: 'аня' });
    const his = await connectAs(gw, server, boris.cookie, { id: 'боря' });
    settle();
    const room = callRoom(DmService.address(anya.identityId, boris.identityId));
    const ring = await gw.handleCallStart(asSocket(hers), { fingerprint: boris.fingerprint });
    const ringId = ring.ok ? ring.ringId : '';
    return { ...stand, anya, boris, hers, his, room, ringId };
  }

  /**
   * Сессия вернулась после обрыва: socket.io восстанавливает и карту сокетов,
   * и комнаты (их снимок лежит в сохранённой сессии), и только потом зовёт
   * `handleConnection` с тем же id.
   */
  function recover(gw: SignalingGateway, server: FakeServer, sock: FakeSocket, room: string) {
    server.all.set(sock.id, sock);
    sock.join(sock.id);
    sock.join(room);
    gw.handleConnection(asSocket(sock));
  }

  /** Ответить на вызов — с этого мгновения комната и существует. */
  function accept(gw: SignalingGateway, sock: FakeSocket, ringId: string) {
    expect(gw.handleCallAccept(asSocket(sock), { ringId })).toEqual({ ok: true });
  }

  it('вход — по принятию: до ответа собеседника не входит и сам звонящий', async () => {
    const { gw, hers, room } = await talk();
    hers.clear();

    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });

    expect(hers.data.room).toBeUndefined();
    expect(hers.last('voice-refused')).toEqual({ reason: 'not-in-call' });
  });

  it('принятый вызов открывает дверь обоим', async () => {
    const { gw, server, anya, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    server.clearAll();

    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });

    expect([hers.data.room, his.data.room]).toEqual([room, room]);
    expect(his.last('peers')).toEqual([{ id: 'аня', name: 'Аня', fingerprint: anya.fingerprint }]);
    expect(hers.last('peer-joined')).toMatchObject({ id: 'боря', name: 'Боря' });
  });

  it('третий в комнату беседы не входит, и ему говорят почему', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });

    // Трое посторонних, и каждый — своя дверь: чужая личность, клиент без
    // личности вовсе и гость по инвайту, у которого личность в куке есть.
    const vera = await personCookie('Вера');
    const hers3 = await connectAs(gw, server, vera.cookie, { id: 'вера' });
    const nameless = connect(gw, server, { id: 'без-личности' });
    const guest = await connectAs(gw, server, vera.cookie, {
      id: 'вера-по-ссылке',
      guest: issueGuestToken(room).token,
    });
    server.clearAll();

    gw.handleJoin(asSocket(hers3), { room, name: 'Вера' });
    gw.handleJoin(asSocket(nameless), { room, name: 'Никто' });
    gw.handleJoin(asSocket(guest), { room, name: 'Вера' });

    // Перечислены поимённо, а не отобраны условием: отбор по id фикстуры
    // позеленел бы впустую в тот день, когда id поменяются.
    for (const sock of [hers3, nameless, guest]) {
      expect([sock.id, sock.data.room, sock.last('voice-refused')]).toEqual([
        sock.id,
        undefined,
        { reason: 'not-in-call' },
      ]);
    }
    // И разговор этого даже не заметил.
    expect([hers.got('peer-joined'), his.got('peer-joined')]).toEqual([false, false]);
  });

  it('комнату беседы, которой не открывали, не угадать', async () => {
    const { gw, hers } = await talk();
    hers.clear();

    // Адрес правильной формы, но такого разговора нет. Дверь в него заперта не
    // тем, что имя трудно угадать, а тем, что комнаты без принятого вызова не
    // существует вовсе.
    gw.handleJoin(asSocket(hers), { room: callRoom('dm-0123456789abcdef01234567') });

    expect(hers.data.room).toBeUndefined();
    expect(hers.last('voice-refused')).toEqual({ reason: 'not-in-call' });
  });

  it('уход одного кончает разговор у второго', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    gw.handleLeave(asSocket(hers));

    // Оставшийся не сидит в комнате на одного: его выводит сам сервер — и
    // говорит ему об этом, иначе вкладка держала бы экран звонка и микрофон.
    expect(his.data.room).toBeUndefined();
    expect(his.last('call-over')).toEqual({ room });
    // Разговора больше нет: вернуться в него нельзя даже участнику.
    his.clear();
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    expect([his.data.room, his.last('voice-refused')]).toEqual([
      undefined,
      { reason: 'not-in-call' },
    ]);
  });

  it('моргание сети разговор не кончает — грейс тот же, что у канала', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    disconnect(gw, server, hers);
    expect([his.data.room, his.got('call-over')]).toEqual([room, false]);

    vi.advanceTimersByTime(30_000);
    expect([his.data.room, his.last('call-over')]).toEqual([undefined, { room }]);
  });

  it('пределы канала комнаты беседы не касаются', async () => {
    const { gw, settings, hers, his, room, ringId } = await talk();
    // Предел считает «сколько человек в канале»; разговор двоих каналом не
    // является, и выставленная единица не должна оставлять снаружи того, кто
    // вызов принял.
    await tune(settings, 'spaces.maxVoiceOccupants', 1);
    accept(gw, his, ringId);

    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });

    expect([hers.data.room, his.data.room]).toEqual([room, room]);
    expect(his.got('voice-refused')).toBe(false);
  });

  it('второе устройство того же человека перехватывает разговор, а не входит третьим', async () => {
    const { gw, server, anya, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    const phone = await connectAs(gw, server, anya.cookie, { id: 'аня-телефон' });
    settle();
    server.clearAll();

    gw.handleJoin(asSocket(phone), { room, name: 'Аня' });

    // Разговор переехал: в комнате по-прежнему двое, а не трое — иначе Аню
    // было бы слышно дважды, и себя саму она слышала бы эхом.
    expect([phone.data.room, hers.data.room, his.data.room]).toEqual([room, undefined, room]);
    // Прошлому устройству сказано то же, что говорят оставшемуся при уходе
    // собеседника: этот разговор для него кончился.
    expect(hers.last('call-over')).toEqual({ room });
    // А сам разговор жив: собеседника из него никто не выводил.
    expect(his.got('call-over')).toBe(false);
  });

  it('конец разговора догоняет того, у кого моргнула сеть', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    // У Ани моргнула сеть. Сокет уходит из комнаты вместе с картой сокетов —
    // адаптер снимает его сам (`leaveAll` раньше `nsp._remove`), — поэтому
    // сказать ей поимённо в этот миг нечем: адресата не существует. Работает
    // только рассылка В КОМНАТУ, которую адаптер переигрывает по комнатам
    // сохранённой сессии (у поддельного сервера буфера восстановления нет,
    // поэтому здесь виден второй заслон — `resumeCall`).
    disconnect(gw, server, hers);

    gw.handleLeave(asSocket(his));

    // Сессия вернулась — и первым делом узнаёт, что разговора больше нет.
    // Иначе Аня сидела бы в комнате, которой нет: микрофон открыт, присутствие
    // считает её «в голосе», а для новых звонков она занята.
    recover(gw, server, hers, room);
    expect([hers.data.room, hers.last('call-over')]).toEqual([undefined, { room }]);
    // И войти обратно уже некуда: разговор кончился, а не «висит».
    hers.clear();
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    expect([hers.data.room, hers.last('voice-refused')]).toEqual([
      undefined,
      { reason: 'not-in-call' },
    ]);
  });

  it('моргнул и вернулся в свой же разговор — остаётся в нём', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    // Обрыв внутри грейса — и возвращение. Это тот самый случай, который
    // проверка вернувшейся сессии не имеет права испортить: место всё ещё её.
    disconnect(gw, server, hers);
    vi.advanceTimersByTime(10_000);
    recover(gw, server, hers, room);

    expect([hers.data.room, his.data.room]).toEqual([room, room]);
    expect([hers.got('call-over'), his.got('call-over')]).toEqual([false, false]);

    // И отложенный выход снят: грейс истекает, разговор продолжается.
    vi.advanceTimersByTime(60_000);
    expect([hers.data.room, his.data.room]).toEqual([room, room]);
  });

  it('сторож считает места, а не живые сокеты: моргание разговор не рвёт', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    // Обрыв на десятой секунде: к тридцатой, когда просыпается сторож, живых
    // сокетов в комнате один. Считай он живых — уничтожил бы разговор, который
    // и окно восстановления (20 с), и грейс (24 с) вернули бы целым.
    vi.advanceTimersByTime(10_000);
    disconnect(gw, server, hers);
    vi.advanceTimersByTime(20_500);

    expect([his.data.room, his.got('call-over')]).toEqual([room, false]);
    recover(gw, server, hers, room);
    expect([hers.data.room, hers.got('call-over')]).toEqual([room, false]);
  });

  it('переоткрытая комната не теряет мест уже идущего разговора', async () => {
    const { gw, server, settings, anya, boris, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    // Инсталляция, где сидящий в голосе не считается занятым (каталог такое
    // выключение прямо описывает), — те же двое могут набрать друг друга
    // прямо посреди своего разговора.
    await tune(settings, 'calls.busyWhenInVoice', false);
    server.clearAll();

    const again = await gw.handleCallStart(asSocket(hers), { fingerprint: boris.fingerprint });
    accept(gw, his, again.ok ? again.ringId : '');

    // Комната та же — адрес считается из двух id, — и заново её открыли поверх
    // живого разговора. Места обязаны уцелеть: обнулись они, `freeSeat` отвечал
    // бы «ушёл не участник» обоим, разговор стало бы нечем кончить, а
    // оставшийся навсегда числился бы «в голосе».
    expect(callRoom(DmService.address(anya.identityId, boris.identityId))).toBe(room);
    gw.handleLeave(asSocket(hers));
    expect([his.data.room, his.last('call-over')]).toEqual([undefined, { room }]);
  });

  it('вытесненное устройство, вернувшись, в чужой уже разговор не садится', async () => {
    const { gw, server, anya, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });

    // У ноутбука моргнула сеть, и Аня взяла телефон.
    disconnect(gw, server, hers);
    const phone = await connectAs(gw, server, anya.cookie, { id: 'аня-телефон' });
    settle();
    gw.handleJoin(asSocket(phone), { room, name: 'Аня' });
    server.clearAll();

    // Ноутбук вернулся: место уже не его — в комнате его не ждут, а разговор
    // на телефоне идёт.
    recover(gw, server, hers, room);
    expect([hers.data.room, hers.last('call-over')]).toEqual([undefined, { room }]);
    expect([phone.data.room, his.data.room, his.got('call-over')]).toEqual([room, room, false]);
  });

  it('грейс вытесненного устройства разговор на новом не кончает', async () => {
    const { gw, server, anya, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });

    // Ноутбук моргнул и больше не вернулся — Аня договорила с телефона.
    disconnect(gw, server, hers);
    const phone = await connectAs(gw, server, anya.cookie, { id: 'аня-телефон' });
    settle();
    gw.handleJoin(asSocket(phone), { room, name: 'Аня' });
    server.clearAll();

    // Грейс ноутбука истекает — и это уход СОКЕТА, а не человека: место его
    // уже занято его же телефоном. Кончи он этим разговор, звонок обрывался бы
    // ровно через двадцать четыре секунды после переезда на другое устройство.
    vi.advanceTimersByTime(60_000);

    expect([phone.data.room, his.data.room]).toEqual([room, room]);
    expect([phone.got('call-over'), his.got('call-over')]).toEqual([false, false]);
  });

  it('повторный join в ту же комнату разговора не рушит', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    // Клиент, не знающий протокола (нативка, обрыв), повторяет `join` — и это
    // возвращение, а не уход: кончать им разговор собеседнику нельзя.
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });

    expect([hers.data.room, his.data.room]).toEqual([room, room]);
    expect([hers.got('call-over'), his.got('call-over')]).toEqual([false, false]);
  });

  it('комната, в которой так и не стало двоих, кончается сама', async () => {
    const { gw, server, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);
    // Боря вошёл, Аня — нет: у неё не вышло сесть (нет WebRTC, не дали
    // микрофон, закрыли вкладку). Сервер об этой неудаче не узнаёт ничем,
    // кроме того, что второй так и не пришёл.
    gw.handleJoin(asSocket(his), { room, name: 'Боря' });
    server.clearAll();

    vi.advanceTimersByTime(31_000);

    // Боря не сидит в живой комнате один: одному в ней слушать нечего, а
    // числился бы он в ней разговором — и «занят» для новых звонков.
    expect([his.data.room, his.last('call-over')]).toEqual([undefined, { room }]);
    // Комнаты больше нет вовсе — опоздавшая Аня входит уже в никуда.
    gw.handleJoin(asSocket(hers), { room, name: 'Аня' });
    expect([hers.data.room, hers.last('voice-refused')]).toEqual([
      undefined,
      { reason: 'not-in-call' },
    ]);
  });

  it('SFU для комнаты беседы не выдают, о чём бы клиент ни просил', async () => {
    process.env.SFU_URL = 'https://relay.example/sfu';
    process.env.SFU_SECRET = 'секрет';
    const { gw, hers, his, room, ringId } = await talk();
    accept(gw, his, ringId);

    // Пропуска нет: за комнатой беседы не стоит канала реестра, а режим `sfu`
    // — свойство канала.
    expect(await gw.handleSfuToken(asSocket(hers), { room, name: 'Аня' })).toMatchObject({
      ok: false,
      error: 'not-sfu',
    });
    // И названный клиентом транспорт комнату беседы не касается: двоим
    // медиасервер не нужен никогда, а спросить его клиент волен.
    gw.handleJoin(asSocket(hers), { room, name: 'Аня', transport: 'sfu' });
    expect([hers.data.room, hers.data.transport]).toEqual([room, 'p2p']);
  });
});

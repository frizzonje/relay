import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGuestToken } from '../auth/auth';
import { asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  personCookie,
  settle,
  slugOf,
  useGatewayStand,
} from './gateway.testkit';

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
    expect((a.data.room as string).length).toBe(32);
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

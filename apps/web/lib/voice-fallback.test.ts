import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import type { TransportHost } from './voice/types';

/**
 * Что дирижёр делает, когда медиасервер не даётся.
 *
 * Проверяем не медиа (для него нужен настоящий WebRTC), а РЕШЕНИЕ дирижёра:
 * SFU-транспорт заменён заглушкой, которая по команде теста говорит «я не
 * вывез» (или «встал») — ровно как настоящий. Дальше смотрим, куда дирижёр
 * повёл звонок.
 *
 * Правило одно: режим канала — закон. Sfu-канал звонит только через
 * медиасервер: упал — ждём и переподключаемся к нему же, в p2p не уходит никто
 * и никогда. Раньше уходили — поодиночке и целыми комнатами, — комната
 * разъезжалась по транспортам, переезды гасили дорожки, и эфир оставался без
 * звука до перезаходов.
 */

/** Ответ-маркер: api не ответил на запрос пропуска вовсе. */
const TIMEOUT = Symbol('timeout');
let ticketAnswer: unknown = { ok: false, error: 'not-sfu' };

// Счётчик запросов пропуска в медиасервер: по нему видно, сколько кругов
// ожидания сделал дирижёр.
const ticketRequests = vi.fn();

const sockets = {
  id: 'self',
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  timeout: () => ({
    emitWithAck: ticketRequests.mockImplementation(() =>
      ticketAnswer === TIMEOUT
        ? Promise.reject(new Error('operation has timed out'))
        : Promise.resolve(ticketAnswer),
    ),
  }),
};
const handlers: Record<string, (...a: unknown[]) => unknown> = {};
sockets.on = vi.fn((event: string, h: (...a: unknown[]) => unknown) => {
  handlers[event] = h;
});

// Заглушка SFU-транспорта: запоминает дирижёра (через него тест и «ломает»
// связь) и ведёт журнал вызовов интерфейса.
let sfuHost: TransportHost | null = null;
const sfuCalls: string[] = [];

vi.mock('@/lib/socket', () => ({ getSocket: () => sockets }));
vi.mock('@/lib/config', () => ({ getIceServers: () => Promise.resolve([]) }));
vi.mock('@/lib/sfx', () => ({ getSfx: () => ({ play: vi.fn() }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/voice/sfu', () => ({
  createSfuTransport: (host: TransportHost) => {
    sfuHost = host;
    // Выход из комнаты, в которую не входили, — no-op, как и у настоящего
    // транспорта (там разбирать нечего: сокета нет). Иначе журнал показывал бы
    // выходы, которых транспорт совершить не мог.
    let inRoom = false;
    return {
      init: () => {},
      join: () => {
        inRoom = true;
        sfuCalls.push('join');
      },
      leave: () => {
        if (!inRoom) return;
        inRoom = false;
        sfuCalls.push('leave');
      },
      publishVideo: () => {},
      unpublishVideo: () => {},
      publishScreen: () => {},
      unpublishScreen: () => {},
      replaceMicTrack: () => {},
      retuneVideo: () => {},
      pollStats: () => {},
      renamePeer: () => {},
      reset: () => {},
    };
  },
}));

const VIDEO_SDP = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join(
  '\r\n',
);

class FakePC {
  static instances: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  onnegotiationneeded: (() => Promise<void> | void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePC.instances.push(this);
  }
  addTrack(t: unknown) {
    return { track: t };
  }
  getSenders() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: VIDEO_SDP };
  }
  async createAnswer() {
    return { type: 'answer', sdp: VIDEO_SDP };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  restartIce() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = 'closed';
  }
}

const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
const fakeStream = {
  getAudioTracks: () => [audioTrack],
  getVideoTracks: () => [],
  getTracks: () => [audioTrack],
};

let voice: typeof import('./voice');

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  voice = await import('./voice');
  voice.initVoice();
});

beforeEach(() => {
  FakePC.instances.length = 0;
  sfuCalls.length = 0;
  // sfuHost НЕ обнуляем: транспорт создаётся один раз на приложение и живёт
  // между входами — как настоящий.
  sockets.emit.mockClear();
  ticketRequests.mockClear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  ticketAnswer = { ok: true, url: '/', token: 'ticket' }; // канал в режиме SFU
});

afterEach(() => {
  voice.leaveVoice(true);
});

function joins() {
  return sockets.emit.mock.calls.filter((c) => c[0] === 'join');
}

describe('медиасервер не даётся — ждём его, в p2p не уходим', () => {
  it('не поднялись на входе → остаёмся в канале и переподключаемся', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    expect(sfuCalls).toEqual(['join']); // пропуск выдан — пошли в медиасервер

    // Транспорт исчерпал лестницу ещё до первого звука.
    sfuHost!.transportLost('setup');
    await vi.advanceTimersByTimeAsync(0);

    // Никакого mesh: ни переезда, ни прямых соединений.
    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
    await Promise.resolve(handlers['peers']([{ id: 'zzz', name: 'Z' }]));
    expect(FakePC.instances).toHaveLength(0);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);

    // Круг ожидания переподключил к медиасерверу же — с новым пропуском.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join', 'leave', 'join']);
    expect(joins()).toHaveLength(2);
    expect(joins()[1][1]).toMatchObject({ transport: 'sfu' });
  });

  it('развалилось в звонке, даже вдвоём → ждём медиасервер, а не звоним напрямую', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    sfuHost!.addTile('a', 'A', null, false);

    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(0);

    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
    expect(FakePC.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join', 'leave', 'join']);
    expect(joins()[1][1]).toMatchObject({ transport: 'sfu' });
  });

  it('пока сервер лежит: круги всё реже, тост один, в mesh не срываемся', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    ticketAnswer = { ok: false, error: 'unavailable' }; // медиасервер мёртв
    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(0);
    const asked = () => ticketRequests.mock.calls.length - 1; // минус вход

    // Паузы растут: 5 → 10 → 20 → 30 → 30 с.
    for (const [pause, total] of [
      [5000, 1],
      [10_000, 2],
      [20_000, 3],
      [30_000, 4],
      [30_000, 5],
    ]) {
      await vi.advanceTimersByTimeAsync(pause - 1);
      expect(asked()).toBe(total - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked()).toBe(total);
    }

    // Сказали один раз на весь обрыв, а не на каждый круг.
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(sfuCalls).toEqual(['join']);
    expect(FakePC.instances).toHaveLength(0);
  });

  it('«медиасервер вернулся» — только когда транспорт встал; пауза снова с базы', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join', 'leave', 'join']);

    // Пропуск выдан и транспорт в пути — это ещё не связь.
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    sfuHost!.transportUp();
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);

    // Встали — счёт промахов обнулён: следующий обрыв ждёт снова 5 с, а не 10.
    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join', 'leave', 'join', 'leave', 'join']);
  });

  it('транспорт встал раньше круга ожидания → круг не разбирает живой звонок', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(2000);

    // Связь вернулась сама, до круга (так было на стенде: медиасервер
    // поднялся раньше, чем круг спросил пропуск).
    sfuHost!.transportUp();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
  });

  it('сервер лежит уже на входе → входим в канал через медиасервер и ждём его', async () => {
    ticketAnswer = { ok: false, error: 'unavailable' };
    await voice.joinVoice('room-sfu', 'SFU-канал');

    // В комнате мы есть — и объявлены тем, что велит канал.
    expect(joins()).toHaveLength(1);
    expect(joins()[0][1]).toMatchObject({ transport: 'sfu' });
    expect(sfuCalls).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);

    ticketAnswer = { ok: true, url: '/', token: 'ticket' }; // сервер поднялся
    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(2);
    expect(joins()[1][1]).toMatchObject({ transport: 'sfu' });
  });

  it('api не ответил → ждём молча и спрашиваем снова; «канал прямой» уводит в p2p', async () => {
    ticketAnswer = TIMEOUT;
    await voice.joinVoice('room-x', 'Канал');

    // Режим неизвестен: не кричим «медиасервер лежит» и не звоним напрямую.
    expect(joins()).toHaveLength(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

    ticketAnswer = { ok: false, error: 'not-sfu' }; // оказалось — прямой
    await vi.advanceTimersByTimeAsync(5000);
    expect(joins()).toHaveLength(2);
    expect(joins()[1][1]).toMatchObject({ transport: 'p2p' });
    await Promise.resolve(handlers['peers']([{ id: 'zzz', name: 'Z' }]));
    expect(FakePC.instances).toHaveLength(1);

    // В прямом канале круг ожидания гаснет — больше никаких вопросов.
    const before = ticketRequests.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ticketRequests.mock.calls.length).toBe(before);
  });

  it('сокет api вернулся, пока канал ждёт сервер → снова sfu, а не mesh', async () => {
    ticketAnswer = { ok: false, error: 'unavailable' };
    await voice.joinVoice('room-sfu', 'SFU-канал');

    handlers['connect']();
    await vi.advanceTimersByTimeAsync(0);

    expect(joins()).toHaveLength(2);
    expect(joins()[1][1]).toMatchObject({ transport: 'sfu' });
    expect(FakePC.instances).toHaveLength(0);
  });
});

/**
 * Расщепление комнаты по транспортам. Так выглядит клиент, который медиасервер
 * не умеет вовсе (нативный iOS — mesh-only): в канале он есть, а слышать его
 * не может никто. Дирижёр замечает раскол и честно о нём говорит, но комнату
 * никуда не утаскивает. Раньше малая комната съезжала в p2p целиком, переезд
 * гасил дорожки у всех, и эфир оставался без звука до перезаходов.
 */
describe('расщепление комнаты по транспортам', () => {
  const peer = (id: string, transport: 'p2p' | 'sfu') => ({
    id,
    name: id.toUpperCase(),
    micOn: true,
    deafened: false,
    transport,
  });

  it('малая комната: кто-то напрямую → с медиасервера не уезжаем', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    expect(sfuCalls).toEqual(['join']);

    // Мы через медиасервер, телефон — напрямую: друг друга не слышим. Но
    // переезд всей комнаты к нему ломал всех: остаёмся на сервере и честно
    // предупреждаем.
    handlers['voice-presence']({
      'room-sfu': [peer('self', 'sfu'), peer('phone', 'p2p')],
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sfuCalls).toEqual(['join']); // никуда не съехали
    expect(joins()).toHaveLength(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });

  it('большая комната: остаёмся на медиасервере, а не душим всех mesh', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');

    handlers['voice-presence']({
      'room-sfu': [
        peer('self', 'sfu'),
        ...['a', 'b', 'c', 'd'].map((id) => peer(id, 'sfu')),
        peer('phone', 'p2p'),
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
  });

  it('мы напрямую, остальные на сервере → предупреждаем, но никуда не едем', async () => {
    ticketAnswer = { ok: false, error: 'not-sfu' };
    await voice.joinVoice('room-x', 'Канал'); // канал прямой — вошли как p2p
    const askedBefore = ticketRequests.mock.calls.length;

    handlers['voice-presence']({
      'room-x': [peer('self', 'p2p'), peer('a', 'sfu')],
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(ticketRequests.mock.calls.length).toBe(askedBefore); // и не стучимся
    expect(sfuCalls).toEqual([]);
    expect(joins()).toHaveLength(1);
  });

  it('все на одном транспорте → никаких переездов', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');

    handlers['voice-presence']({
      'room-sfu': [peer('self', 'sfu'), peer('a', 'sfu'), peer('b', 'sfu')],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
  });
});

/**
 * Смена транспорта канала владельцем (кнопка P2P/SFU в строке канала). Переезжают
 * все, кто в эфире, но не одновременно: пропуск в медиасервер каждый спрашивает
 * сам, и пока комната в пути, участники неизбежно оказываются на разных
 * транспортах. Раньше первый же такой срез читался как расщепление и утаскивал
 * переехавшего обратно в mesh, а следом за ним и остальных — то есть кнопка
 * режима рвала разговор. Проверяем, что середина переезда больше не путается с
 * расщеплением, что настоящее расщепление замечается, но комнату не утаскивает,
 * и что второе нажатие не оставляет позади первый транспорт.
 */
describe('смена режима канала', () => {
  const peer = (id: string, transport: 'p2p' | 'sfu') => ({
    id,
    name: id.toUpperCase(),
    micOn: true,
    deafened: false,
    transport,
  });

  /** Мы в p2p-канале, владелец включил медиасервер — мы переехали первыми. */
  async function switchToSfu() {
    ticketAnswer = { ok: false, error: 'not-sfu' }; // канал пока прямой
    await voice.joinVoice('room-x', 'Канал');
    ticketAnswer = { ok: true, url: '/', token: 'ticket' }; // владелец щёлкнул режим
    handlers['voice-mode']({ room: 'room-x', mode: 'sfu' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sfuCalls).toEqual(['join']);
    expect(joins()[1][1]).toMatchObject({ transport: 'sfu' });
  }

  it('пока комната переезжает, разные транспорты не считаются расщеплением', async () => {
    await switchToSfu();

    // Мы уже в медиасервере, сосед ещё ждёт свой пропуск.
    handlers['voice-presence']({ 'room-x': [peer('self', 'sfu'), peer('a', 'p2p')] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sfuCalls).toEqual(['join']); // никуда не съехали

    // Сосед доехал — расщепления и не было.
    handlers['voice-presence']({ 'room-x': [peer('self', 'sfu'), peer('a', 'sfu')] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(2);
  });

  it('расщепление, пережившее переезд, замечается — но комнату не утаскивает', async () => {
    await switchToSfu();

    // Сосед в медиасервер так и не попал (нативный клиент, mesh-only).
    handlers['voice-presence']({ 'room-x': [peer('self', 'sfu'), peer('a', 'p2p')] });
    await vi.advanceTimersByTimeAsync(20_000);

    // Остаёмся на сервере: уезжать всей комнатой — значит порвать связь всем
    // ради одного. Глухого предупреждаем, возвращается он сам.
    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(2);
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });

  it('канал объявили прямым, а мы и так звоним напрямую — звук не рвём', async () => {
    // Обычная развязка: у одного медиасервер не поднялся, он уехал в p2p, и
    // владелец ради него переключил канал. Переезжать ему некуда, а переезд —
    // это снятые плитки и пересобранные соединения, то есть секунды тишины за
    // событие, которое его не касается.
    ticketAnswer = { ok: false, error: 'not-sfu' };
    await voice.joinVoice('room-x', 'Канал');
    const before = joins().length;

    handlers['voice-mode']({ room: 'room-x', mode: 'p2p' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(joins()).toHaveLength(before); // ни одного повторного join
    expect(sfuCalls).toEqual([]);
  });

  it('два переключения подряд не оставляют позади первый транспорт', async () => {
    ticketAnswer = { ok: false, error: 'not-sfu' };
    await voice.joinVoice('room-x', 'Канал');

    // Владелец щёлкнул кнопку дважды: сперва в медиасервер, тут же обратно.
    // Первый переезд ещё ждёт пропуск — доехать после второго он не вправе.
    ticketAnswer = { ok: true, url: '/', token: 'ticket' };
    handlers['voice-mode']({ room: 'room-x', mode: 'sfu' });
    ticketAnswer = { ok: false, error: 'not-sfu' };
    handlers['voice-mode']({ room: 'room-x', mode: 'p2p' });
    await vi.advanceTimersByTimeAsync(0);

    // В медиасервер не пошли вовсе: иначе за спиной остался бы живой сокет SFU
    // при mesh-плитках — звонок без звука и без пути назад.
    expect(sfuCalls).toEqual([]);
    expect(joins()).toHaveLength(2);
    expect(joins()[1][1]).toMatchObject({ transport: 'p2p' });
  });
});

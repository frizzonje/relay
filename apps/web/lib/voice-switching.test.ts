import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import type { TransportHost } from './voice/types';

/**
 * Прыжки по каналам. Вход в канал — не одно действие, а цепочка с двумя
 * ожиданиями посередине: микрофон и пропуск в медиасервер. Пока они летят,
 * человек успевает щёлкнуть по соседнему каналу, и в дирижёре одновременно
 * живут два захода — а транспорт, устройства и комната у него одни.
 *
 * Здесь проверяется ровно то, что должно пережить такой обгон: заход, которого
 * обогнали, обязан сойти с дистанции целиком; состав комнаты до выбора
 * транспорта не считается расщеплением; сорвавшийся вход уезжает в p2p, а не
 * оставляет человека в тишине; ожидание вернувшегося медиасервера не воскресает
 * поверх нового захода; и микрофон на два клика берётся один раз.
 */

type Ticket = { ok: true; url: string; token: string } | { ok: false; error: string };

const SFU: Ticket = { ok: true, url: '/', token: 'ticket' };
const P2P: Ticket = { ok: false, error: 'not-sfu' };

// Пропуск выдаём либо сразу (обычный режим), либо по требованию теста: очередь
// запросов, ответ отдаёт сам тест — так и воспроизводится обгон.
let ticketFor: (room: string) => Ticket = () => P2P;
let manual = false;
const asked: { room: string; reply: (t: Ticket) => void }[] = [];

const sockets = {
  id: 'self',
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  timeout: () => ({
    emitWithAck: (_event: string, payload: { room: string }) =>
      manual
        ? new Promise<Ticket>((reply) => asked.push({ room: payload.room, reply }))
        : Promise.resolve(ticketFor(payload.room)),
  }),
};
const handlers: Record<string, (...a: unknown[]) => unknown> = {};
sockets.on = vi.fn((event: string, h: (...a: unknown[]) => unknown) => {
  handlers[event] = h;
});

// Заглушка SFU-транспорта: журнал вызовов интерфейса + возможность сломать сам
// его подъём (динамический чанк mediasoup-client не доехал).
let sfuHost: TransportHost | null = null;
const sfuCalls: string[] = [];
let sfuBroken = false;
let sfuBreaks = 0;

vi.mock('@/lib/socket', () => ({ getSocket: () => sockets }));
vi.mock('@/lib/config', () => ({ getIceServers: () => Promise.resolve([]) }));
vi.mock('@/lib/sfx', () => ({ getSfx: () => ({ play: vi.fn(), setAllMuted: vi.fn() }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/voice/sfu', () => ({
  createSfuTransport: (host: TransportHost) => {
    if (sfuBroken) {
      sfuBreaks++;
      throw new Error('chunk load failed');
    }
    sfuHost = host;
    // Как у настоящего транспорта: выход из комнаты, в которую не входили, —
    // no-op (разбирать нечего, сокета нет).
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

class FakePC {
  static instances: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: unknown = null;
  onnegotiationneeded: (() => Promise<void> | void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePC.instances.push(this);
  }
  addTrack(t: unknown) {
    return { track: t };
  }
  getSenders() {
    return [];
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\n' };
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

/** Дорожка микрофона: новая на каждый getUserMedia — чтобы видеть утечку. */
function makeStream() {
  const track = { kind: 'audio', enabled: true, contentHint: '', stop: vi.fn() };
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
      getTracks: () => [track],
      addTrack: () => {},
      removeTrack: () => {},
    },
  };
}

const takenMics: ReturnType<typeof makeStream>[] = [];
const getUserMedia = vi.fn(async () => {
  const mic = makeStream();
  takenMics.push(mic);
  return mic.stream;
});

let voice: typeof import('./voice');

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  voice = await import('./voice');
  voice.initVoice();
});

beforeEach(() => {
  FakePC.instances.length = 0;
  sfuCalls.length = 0;
  takenMics.length = 0;
  asked.length = 0;
  manual = false;
  sfuBroken = false;
  ticketFor = () => P2P;
  sockets.emit.mockClear();
  getUserMedia.mockClear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(async () => {
  voice.leaveVoice(true);
  await vi.advanceTimersByTimeAsync(0);
});

function joins() {
  return sockets.emit.mock.calls.filter((c) => c[0] === 'join');
}

/** Прокрутить микрозадачи (все await'ы дирижёра), не двигая время. */
function settle() {
  return vi.advanceTimersByTimeAsync(0);
}

/** Ответить на запрос пропуска по комнате (первый неотвеченный). */
function reply(room: string, ticket: Ticket) {
  const idx = asked.findIndex((a) => a.room === room);
  if (idx === -1) throw new Error(`пропуск для "${room}" никто не спрашивал`);
  asked.splice(idx, 1)[0].reply(ticket);
}

/** Занять микрофон заранее — тесты про обгон не должны спотыкаться о getUserMedia. */
async function warmMic() {
  await voice.joinVoice('warm-up', 'разогрев');
  voice.leaveVoice(false); // мягкий выход: поток остаётся жить, как при смене канала
  sockets.emit.mockClear();
  sfuCalls.length = 0;
  getUserMedia.mockClear();
}

const peer = (id: string, transport: 'p2p' | 'sfu') => ({
  id,
  name: id.toUpperCase(),
  micOn: true,
  deafened: false,
  transport,
});

/**
 * Идёт ПЕРВЫМ в файле намеренно: транспорт медиасервера создаётся один раз на
 * приложение и переживает выходы из канала, так что сломать его подъём можно,
 * только пока он ещё не создан. Счётчик срабатываний сторожит это условие —
 * иначе тест тихо перестал бы проверять что-либо.
 */
describe('сорвавшийся вход', () => {
  it('транспорт медиасервера не поднялся → уезжаем в p2p, а не в тишину', async () => {
    sfuBroken = true; // чанк mediasoup-client не доехал
    ticketFor = () => SFU;

    await voice.joinVoice('room-sfu', 'SFU-канал');
    await settle();

    expect(sfuBreaks).toBeGreaterThan(0); // подъём действительно ломали
    // Заход обязан состояться: канал у человека открыт, и остаться в нём без
    // единого `join` — это «подключено» с полной тишиной и без пути назад.
    expect(joins()).toHaveLength(1);
    expect(joins()[0][1]).toMatchObject({ room: 'room-sfu', transport: 'p2p' });
  });
});

describe('обгон при прыжках по каналам', () => {
  it('заход, которого обогнали, не встаёт поверх приехавшего', async () => {
    await warmMic();
    manual = true;

    // Три клика подряд: p2p-канал, соседний, и снова первый. Пропуска ещё ни у
    // кого нет — все три захода висят на ожидании.
    const first = voice.joinVoice('room-x', 'X');
    await settle();
    const second = voice.joinVoice('room-y', 'Y');
    await settle();
    const third = voice.joinVoice('room-x', 'X');
    await settle();
    expect(asked.map((a) => a.room)).toEqual(['room-x', 'room-y', 'room-x']);

    // Отвечаем в порядке, который легко получается живьём: соседний канал
    // отвалился как p2p, последний клик доехал до медиасервера, а самый первый
    // запрос дотащился последним — и с другим ответом (он ушёл ещё до того, как
    // владелец щёлкнул режим, а мог и просто отвалиться по таймауту).
    reply('room-y', P2P);
    await settle();
    reply('room-x', SFU); // это ответ ПЕРВОМУ запросу (он первый в очереди)
    await settle();
    reply('room-x', P2P); // а это — третьему
    await settle();
    await Promise.all([first, second, third]);

    // Приехать должен ровно один заход — последний. Иначе позади остаётся живой
    // сокет медиасервера при mesh-плитках: звук уходит в комнату, из которой мы
    // ушли, а вернуться некуда.
    expect(joins()).toHaveLength(1);
    expect(joins()[0][1]).toMatchObject({ room: 'room-x', transport: 'p2p' });
    expect(sfuCalls).toEqual([]);
  });

  it('два быстрых клика не берут микрофон дважды', async () => {
    // Микрофон ещё не взят: оба захода упрутся в getUserMedia.
    const first = voice.joinVoice('room-a', 'A');
    const second = voice.joinVoice('room-b', 'B');
    await settle();
    await Promise.all([first, second]);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // И ни одна дорожка не осталась висеть живой мимо дирижёра.
    expect(takenMics.filter((m) => m.track.stop.mock.calls.length === 0)).toHaveLength(1);
  });
});

describe('расщепление на входе', () => {
  it('пока транспорт не выбран, состав комнаты не считается расщеплением', async () => {
    await warmMic();
    manual = true;

    const entering = voice.joinVoice('room-sfu', 'SFU-канал');
    await settle();

    // Пропуск ещё в пути, а сервер уже разослал присутствие: наш `leave` из
    // прошлого канала его и вызвал. Транспорта у нас в этот момент нет вовсе —
    // и «нет транспорта» не значит «звоню напрямую».
    handlers['voice-presence']({ 'room-sfu': [peer('a', 'sfu'), peer('b', 'sfu')] });
    await settle();
    expect(toast.error).not.toHaveBeenCalled();

    reply('room-sfu', SFU);
    await entering;
    await settle();
    expect(sfuCalls).toEqual(['join']);

    // И настоящее расщепление после входа по-прежнему разбирается.
    handlers['voice-presence']({ 'room-sfu': [peer('self', 'sfu'), peer('a', 'p2p')] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sfuCalls).toEqual(['join', 'leave']);
  });
});

describe('ожидание вернувшегося медиасервера', () => {
  it('не воскресает поверх нового захода в тот же канал', async () => {
    ticketFor = () => SFU;
    await voice.joinVoice('room-sfu', 'SFU-канал');
    await settle();
    // Комната большая — в p2p не уезжаем, встаём ждать сервер.
    for (const id of ['a', 'b', 'c', 'd', 'e']) sfuHost!.addTile(id, id, null, false);
    sfuHost!.transportLost('lost');
    await settle();
    expect(sfuCalls).toEqual(['join']);

    // Круг ожидания начался, пропуск в пути.
    manual = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toHaveLength(1);

    // А человек тем временем вышел и зашёл снова — в тот же канал.
    voice.leaveVoice(true);
    manual = false;
    await voice.joinVoice('room-sfu', 'SFU-канал');
    await settle();
    const after = [...sfuCalls];
    const joinsAfter = joins().length;

    // Запоздавший круг ожидания приезжает в комнату, где всё уже собрано заново.
    manual = true;
    reply('room-sfu', SFU);
    await settle();

    expect(sfuCalls).toEqual(after);
    expect(joins()).toHaveLength(joinsAfter);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { TransportHost } from './voice/types';

/**
 * Политика фолбэка при падении медиасервера (шаг E, docs/sfu-plan.md).
 *
 * Проверяем не медиа (для него нужен настоящий WebRTC), а РЕШЕНИЕ дирижёра:
 * SFU-транспорт заменён заглушкой, которая по команде теста говорит «я не
 * вывез» — ровно как настоящий, исчерпав лестницу восстановления. Дальше
 * смотрим, куда дирижёр увёл звонок.
 *
 * Правило: не поднялись на входе — всегда в p2p (человек ещё никого не слышал);
 * развалилось в звонке — в p2p только при малом составе, иначе ждём сервер,
 * потому что mesh на таком числе людей и есть та боль, ради которой был SFU.
 */

let ticketAnswer: unknown = { ok: false, error: 'not-sfu' };

const sockets = {
  id: 'self',
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  timeout: () => ({ emitWithAck: () => Promise.resolve(ticketAnswer) }),
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
    return {
      init: () => {},
      join: () => void sfuCalls.push('join'),
      leave: () => void sfuCalls.push('leave'),
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
  ticketAnswer = { ok: true, url: '/', token: 'ticket' }; // канал в режиме SFU
});

afterEach(() => {
  voice.leaveVoice(true);
});

function joins() {
  return sockets.emit.mock.calls.filter((c) => c[0] === 'join');
}

describe('фолбэк на p2p при недоступном медиасервере', () => {
  it('не поднялись на входе → уезжаем в mesh и звоним напрямую', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    expect(sfuCalls).toEqual(['join']); // пропуск выдан — пошли в медиасервер
    expect(joins()).toHaveLength(1);

    // Транспорт исчерпал лестницу ещё до первого звука.
    sfuHost!.transportLost('setup');
    await vi.advanceTimersByTimeAsync(0); // переезд асинхронный (запрос пропуска)

    expect(sfuCalls).toEqual(['join', 'leave']);
    expect(joins()).toHaveLength(2); // объявились в комнате заново, уже как mesh

    // И это действительно mesh: состав комнаты поднимает p2p-соединение.
    await Promise.resolve(handlers['peers']([{ id: 'zzz', name: 'Z' }]));
    expect(FakePC.instances).toHaveLength(1);
  });

  it('развалилось в звонке при малом составе → тоже mesh', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    sfuHost!.addTile('a', 'A', null, false);
    sfuHost!.addTile('b', 'B', null, false);

    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(0);

    expect(sfuCalls).toEqual(['join', 'leave']);
    expect(joins()).toHaveLength(2);
  });

  it('развалилось в звонке при большом составе → ждём сервер, а не душим mesh', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    for (const id of ['a', 'b', 'c', 'd', 'e']) sfuHost!.addTile(id, id, null, false);

    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(0);

    // В mesh не поехали: звонок остаётся ждать медиасервер.
    expect(sfuCalls).toEqual(['join']);
    expect(joins()).toHaveLength(1);
    expect(FakePC.instances).toHaveLength(0);

    // Сервер вернулся — пропуск снова выдают, переподключаемся к нему же.
    await vi.advanceTimersByTimeAsync(5000);
    expect(sfuCalls).toEqual(['join', 'leave', 'join']);
    expect(joins()).toHaveLength(2);
  });

  it('пока сервер лежит, повторные попытки не срываются в mesh', async () => {
    await voice.joinVoice('room-sfu', 'SFU-канал');
    for (const id of ['a', 'b', 'c', 'd', 'e']) sfuHost!.addTile(id, id, null, false);

    ticketAnswer = { ok: false, error: 'unavailable' }; // медиасервер всё ещё мёртв
    sfuHost!.transportLost('lost');
    await vi.advanceTimersByTimeAsync(20_000); // четыре круга ожидания

    expect(sfuCalls).toEqual(['join']);
    expect(FakePC.instances).toHaveLength(0);
  });
});

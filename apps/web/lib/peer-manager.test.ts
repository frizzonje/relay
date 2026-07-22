import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * Юнит-тест mesh-транспорта (lib/voice/mesh.ts) через публичный API дирижёра
 * lib/voice.ts — проверяем связку целиком: perfect-negotiation
 * (offer/answer, glare-подавление у «невежливой» стороны) и очередь ICE-
 * кандидатов с дренажём после setRemoteDescription. RTCPeerConnection,
 * getUserMedia и socket замоканы — реальной сети/медиа не требуется.
 */

// ─── Моки внешних зависимостей voice.ts ──────────────────────────────────
// `timeout().emitWithAck()` — так дирижёр спрашивает пропуск в медиасервер при
// входе. Здесь он всегда отказ: тест про mesh, и транспорт должен выбраться он.
const sockets = {
  id: 'self',
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  timeout: () => ({
    emitWithAck: () => Promise.resolve({ ok: false, error: 'not-sfu' }),
  }),
};
const handlers: Record<string, (...a: unknown[]) => unknown> = {};
sockets.on = vi.fn((event: string, h: (...a: unknown[]) => unknown) => {
  handlers[event] = h;
});

vi.mock('@/lib/socket', () => ({ getSocket: () => sockets }));
vi.mock('@/lib/config', () => ({ getIceServers: () => Promise.resolve([]) }));
vi.mock('@/lib/sfx', () => ({ getSfx: () => ({ play: vi.fn() }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

// SDP с видеокодеком (VP8/pt96) — чтобы проверить, что boostVideoBitrate применён.
const VIDEO_SDP = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 max-fs=12288',
  '',
].join('\r\n');

// ─── Мок RTCPeerConnection ───────────────────────────────────────────────
class FakePC {
  static instances: FakePC[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  onnegotiationneeded: (() => Promise<void> | void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  tracks: unknown[] = [];
  addedIce: unknown[] = [];

  constructor() {
    FakePC.instances.push(this);
  }
  addTrack(t: unknown) {
    this.tracks.push(t);
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
  async setLocalDescription(d: { type: string; sdp?: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp?: string }) {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown) {
    this.addedIce.push(c);
  }
  restartIce() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = 'closed';
  }
}

// Фейковый локальный медиапоток (один аудиотрек).
const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
const fakeStream = {
  getAudioTracks: () => [audioTrack],
  getVideoTracks: () => [],
  getTracks: () => [audioTrack],
};

let voice: typeof import('./voice');

beforeAll(async () => {
  vi.useFakeTimers(); // нейтрализуем ping-setInterval
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  voice = await import('./voice');
  voice.initVoice(); // регистрирует socket-хендлеры
});

beforeEach(() => {
  FakePC.instances.length = 0;
  sockets.emit.mockClear();
});

afterEach(() => {
  voice.leaveVoice(true); // сбрасывает room/peers/localStream
});

// Вызвать зарегистрированный socket-хендлер и дождаться его завершения.
async function fire(event: string, payload?: unknown) {
  const h = handlers[event];
  if (!h) throw new Error(`нет хендлера для ${event}`);
  await Promise.resolve(h(payload));
}

function emitted(event: string) {
  return sockets.emit.mock.calls.filter((c) => c[0] === event);
}

describe('PeerManager — perfect negotiation', () => {
  it('входящий offer → answer с поднятым битрейтом', async () => {
    sockets.id = 'aaa'; // 'aaa' < 'zzz' ⇒ мы «вежливые»
    await voice.joinVoice('room1', 'Канал 1');

    await fire('offer', { from: 'zzz', name: 'Z', sdp: { type: 'offer', sdp: VIDEO_SDP } });

    const answers = emitted('answer');
    expect(answers).toHaveLength(1);
    const payload = answers[0][1] as { to: string; sdp: { type: string; sdp: string } };
    expect(payload.to).toBe('zzz');
    expect(payload.sdp.type).toBe('answer');
    expect(payload.sdp.sdp).toContain('x-google-start-bitrate');

    const pc = FakePC.instances[0];
    expect(pc.remoteDescription?.type).toBe('offer');
  });

  it('glare: «невежливая» сторона игнорирует встречный offer', async () => {
    sockets.id = 'zzz'; // 'zzz' < 'aaa' ложь ⇒ мы «невежливые»
    await voice.joinVoice('room1', 'Канал 1');

    // создаём пира и сами уходим в have-local-offer (запускаем negotiation вручную)
    await fire('peers', [{ id: 'aaa', name: 'A' }]);
    const pc = FakePC.instances[0];
    await pc.onnegotiationneeded?.();
    expect(pc.signalingState).toBe('have-local-offer');
    expect(emitted('offer')).toHaveLength(1);

    sockets.emit.mockClear();
    // встречный offer во время коллизии — невежливый должен его проигнорировать
    await fire('offer', { from: 'aaa', name: 'A', sdp: { type: 'offer', sdp: VIDEO_SDP } });

    expect(emitted('answer')).toHaveLength(0);
    expect(pc.remoteDescription).toBeNull(); // setRemoteDescription не вызывался
  });
});

describe('PeerManager — очередь ICE-кандидатов', () => {
  it('кандидат до remoteDescription буферизуется и дренажится после offer', async () => {
    sockets.id = 'aaa';
    await voice.joinVoice('room1', 'Канал 1');

    await fire('peers', [{ id: 'zzz', name: 'Z' }]); // peer есть, remoteDescription = null
    const pc = FakePC.instances[0];

    await fire('ice-candidate', { from: 'zzz', candidate: { candidate: 'cand-1' } });
    expect(pc.addedIce).toHaveLength(0); // ещё нет remoteDescription → в очередь

    await fire('offer', { from: 'zzz', name: 'Z', sdp: { type: 'offer', sdp: VIDEO_SDP } });
    expect(pc.remoteDescription?.type).toBe('offer');
    expect(pc.addedIce).toHaveLength(1); // дренаж очереди
    expect((pc.addedIce[0] as { candidate: string }).candidate).toBe('cand-1');
  });

  it('кандидат при готовом remoteDescription добавляется сразу', async () => {
    sockets.id = 'aaa';
    await voice.joinVoice('room1', 'Канал 1');

    await fire('offer', { from: 'zzz', name: 'Z', sdp: { type: 'offer', sdp: VIDEO_SDP } });
    const pc = FakePC.instances[0];
    const before = pc.addedIce.length;

    await fire('ice-candidate', { from: 'zzz', candidate: { candidate: 'cand-2' } });
    expect(pc.addedIce.length).toBe(before + 1);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * Mesh-транспорт целиком, через публичный API дирижёра (`lib/voice.ts`).
 *
 * Через дирижёра, а не по файлам: mesh разрезан на предметы — переговоры,
 * лестница, сторож тишины, метрики, публикация дорожек, — и ценно здесь ровно
 * то, как они работают ВМЕСТЕ. Чужой offer доезжает до сторожа ступени, сторож
 * тишины дёргает ту же лестницу, что и провал ICE; все известные баги этой
 * машины жили как раз на стыках, а не внутри предметов.
 *
 * RTCPeerConnection, getUserMedia и socket замоканы — реальной сети и медиа
 * не требуется.
 */

// ─── Моки внешних зависимостей voice.ts ──────────────────────────────────
// `timeout().emitWithAck()` — так дирижёр спрашивает пропуск в медиасервер при
// входе. Здесь он всегда отказ: тест про mesh, и транспорт должен выбраться он.
const sockets = {
  id: 'self',
  connected: true,
  recovered: false, // socket.io восстановил сессию с тем же id
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
  iceConnectionState = 'new';
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  onnegotiationneeded: (() => Promise<void> | void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  tracks: unknown[] = [];
  addedIce: unknown[] = [];
  restarts = 0;
  closed = false;
  // Что вернёт getStats — тест подменяет, чтобы разыграть «звук перестал идти».
  stats: Map<string, Record<string, unknown>> = new Map();
  // Сколько раз за тик у соединения спросили статистику: читателей трое, а
  // снимок должен быть один (иначе они видят три разных момента времени).
  statCalls = 0;

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
  getTransceivers() {
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
  restartIce() {
    this.restarts += 1;
  }
  async getStats() {
    this.statCalls += 1;
    return this.stats;
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
    this.closed = true;
  }

  /** Разыграть смену состояния связи так, как её сообщает браузер. */
  setState(conn: string, ice = conn) {
    this.connectionState = conn;
    this.iceConnectionState = ice;
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

// Фейковый локальный медиапоток (один аудиотрек).
const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
const fakeStream = {
  getAudioTracks: () => [audioTrack],
  getVideoTracks: () => [],
  getTracks: () => [audioTrack],
};

let voice: typeof import('@/lib/voice');

beforeAll(async () => {
  vi.useFakeTimers(); // нейтрализуем ping-setInterval
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  voice = await import('@/lib/voice');
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

// Звонок с одним собеседником, инициатор — мы. 'zzz' < 'aaa' ложь ⇒ мы
// «невежливые» и идём по ступеням лестницы без задержки: POLITE_LAG_MS в
// расчёт времени в этих тестах не входит.
async function callWith(peerId = 'aaa') {
  sockets.id = 'zzz';
  sockets.connected = true;
  await voice.joinVoice('room1', 'Канал 1');
  await fire('peers', [{ id: peerId, name: 'A' }]);
  return FakePC.instances[0];
}

describe('mesh — perfect negotiation', () => {
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

  it('собеседник, пересобравший связь, узнаётся по отпечатку DTLS', async () => {
    sockets.id = 'aaa'; // «вежливые» — отвечаем на чужие offer'ы
    sockets.connected = true;
    await voice.joinVoice('room1', 'Канал 1');

    const offer = (fp: string) => ({
      from: 'zzz',
      name: 'Z',
      sdp: { type: 'offer', sdp: `a=fingerprint:sha-256 ${fp}\r\n${VIDEO_SDP}` },
    });

    await fire('offer', offer('AA:BB'));
    const first = FakePC.instances[0];
    expect(first.remoteDescription?.type).toBe('offer');

    // Тот же отпечаток — обычная ренеготиация: соединение не трогаем.
    await fire('offer', offer('AA:BB'));
    expect(FakePC.instances).toHaveLength(1);
    expect(first.closed).toBe(false);

    // Отпечаток сменился ⇒ за тем же id уже другой pc. Наш выбрасываем.
    await fire('offer', offer('CC:DD'));
    expect(first.closed).toBe(true);
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[1].localDescription?.type).toBe('answer');
  });
});

describe('mesh — лестница восстановления', () => {
  it('промежуточное «connecting» больше не гасит сторож ступени', async () => {
    const pc = await callWith();

    pc.setState('disconnected');
    await vi.advanceTimersByTimeAsync(4000); // RECOVER_GRACE_MS → ступень 1
    expect(pc.restarts).toBe(1);

    // Так браузер отвечает на restartIce: ICE уходит перебирать пары. Раньше на
    // этом переходе сторож снимался, и связь застревала здесь навсегда.
    pc.setState('connecting', 'checking');
    await vi.advanceTimersByTimeAsync(7000); // RECOVER_WINDOW_MS → ступень 2

    expect(pc.closed).toBe(true);
    expect(FakePC.instances).toHaveLength(2); // соединение пересобрано
    expect(FakePC.instances[1].closed).toBe(false);
  });

  it('пересборки повторяются, а не заканчиваются снятием собеседника', async () => {
    const pc = await callWith();
    pc.setState('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restarts).toBe(1); // ступень 1 — сразу, без грейса

    await vi.advanceTimersByTimeAsync(7000); // пересборка №1
    expect(FakePC.instances).toHaveLength(2);

    FakePC.instances[1].setState('failed');
    await vi.advanceTimersByTimeAsync(14_000); // пересборка №2 (пауза растёт)
    expect(FakePC.instances).toHaveLength(3);
  });

  it('пока сигналинг лежит, ступени не жгутся', async () => {
    const pc = await callWith();
    sockets.connected = false;

    pc.setState('failed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pc.restarts).toBe(0);
    expect(FakePC.instances).toHaveLength(1);

    // Сокет вернулся с тем же id — догоняем упущенное (voice.ts зовёт resync).
    sockets.connected = true;
    sockets.recovered = true;
    await fire('connect');
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restarts).toBe(1);
    sockets.recovered = false;
  });
});

describe('mesh — сторож тишины', () => {
  it('связь есть, а звука нет — чиним, а не только пишем в консоль', async () => {
    const pc = await callWith();
    pc.setState('connected');
    // Входящий звук замер на одном и том же счётчике байт.
    pc.stats = new Map([['in-a', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 4096 }]]);

    await vi.advanceTimersByTimeAsync(3000); // первый снимок — база
    expect(pc.restarts).toBe(0);
    await vi.advanceTimersByTimeAsync(9000); // SILENCE_MS вышло → ступень 1
    expect(pc.restarts).toBe(1);
    await vi.advanceTimersByTimeAsync(9000); // всё ещё тихо → пересборка
    expect(pc.closed).toBe(true);
    expect(FakePC.instances).toHaveLength(2);
  });
});

describe('mesh — метрики', () => {
  async function callWith(peerId = 'aaa') {
    sockets.id = 'zzz';
    sockets.connected = true;
    await voice.joinVoice('room1', 'Канал 1');
    await fire('peers', [{ id: peerId, name: 'A' }]);
    return FakePC.instances[0];
  }

  it('за тик у соединения статистику спрашивают один раз, а не трижды', async () => {
    const pc = await callWith();
    pc.setState('connected');
    pc.statCalls = 0;

    await vi.advanceTimersByTimeAsync(3000);
    expect(pc.statCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(pc.statCalls).toBe(2);
  });

  it('пока связь не встала, статистику не спрашивают вовсе', async () => {
    const pc = await callWith();
    pc.statCalls = 0;

    await vi.advanceTimersByTimeAsync(3000);
    expect(pc.statCalls).toBe(0);
  });
});

describe('mesh — очередь ICE-кандидатов', () => {
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

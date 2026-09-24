import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Микрофон после разреза: дорожка одна — та, что пришла с устройства, — и она
 * же уходит собеседникам. Здесь проверяется то, что ломается молча:
 *  - в сеть не уходит выход Web Audio (на Linux это треск);
 *  - анализатор слушает клон — иначе закрытый затвор оглох бы навсегда;
 *  - мут, затвор и смена устройства сходятся в одну формулу `micOn && gateOpen`;
 *  - выход гасит и дорожку, и клон — иначе лампочка записи горит до перезагрузки.
 */

const h = vi.hoisted(() => {
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
  const sources: { getAudioTracks(): unknown[] }[] = [];
  return {
    rms: 0,
    sources,
    ctx: {
      currentTime: 0,
      destination: {},
      createMediaStreamSource: (s: { getAudioTracks(): unknown[] }) => {
        sources.push(s);
        return node();
      },
      createAnalyser: () => ({ ...node(), fftSize: 0 }),
      createGain: () => ({ ...node(), gain: { value: 1, setTargetAtTime: () => {} } }),
      // Старый код гнал голос сюда и отдавал собеседникам ЭТУ дорожку. Подделка
      // умеет выход Web Audio, чтобы тест «в сеть уходит дорожка устройства»
      // падал на старом коде, а не проходил из-за отката на сырую дорожку.
      createMediaStreamDestination: () => ({
        ...node(),
        stream: new (
          globalThis as unknown as { MediaStream: new (t: unknown[]) => unknown }
        ).MediaStream([{ kind: 'audio', id: 'web-audio', enabled: true, contentHint: '' }]),
      }),
    },
  };
});

vi.mock('@/lib/voice/output', () => ({
  ANALYSER_FFT_SIZE: 512,
  analyserRms: () => h.rms,
  // audioContext новому mic.ts не нужен; он здесь, чтобы старый код падал на
  // проверках, а не на TypeError в таймере гейта (шаг 2).
  audioContext: () => h.ctx,
  getAudioCtx: () => h.ctx,
  refreshOutputDevices: () => {},
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

class FakeTrack {
  kind = 'audio';
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  label: string;
  constructor(readonly id: string) {
    this.label = `mic ${id}`;
  }
  /** Как в браузере: клон наследует enabled оригинала. */
  clone(): FakeTrack {
    const c = new FakeTrack(`${this.id}~clone`);
    c.enabled = this.enabled;
    return c;
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: `dev-${this.id}` };
  }
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getTracks() {
    return [...this.tracks];
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

let mic: typeof import('./mic');
let outgoing: FakeStream | null;
let captured: FakeTrack[];
let replaced: [FakeTrack | null, FakeTrack][];
let announced: number;
let synced: number;

/** Уровень в шкале метра: micLevelNorm = sqrt(rms / 0.5). */
const level = (norm: number) => {
  h.rms = norm * norm * 0.5;
};
const sent = () => outgoing!.getAudioTracks()[0];
const meter = () => h.sources.at(-1)!.getAudioTracks()[0] as FakeTrack;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
  });
  h.rms = 0;
  h.sources.length = 0;
  captured = [];
  replaced = [];
  outgoing = null;
  announced = 0;
  synced = 0;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('window', {
    AudioContext: class {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        const t = new FakeTrack(String(captured.length + 1));
        captured.push(t);
        return new FakeStream([t]);
      },
      enumerateDevices: async () => [],
    },
  });
  mic = await import('./mic');
  mic.initMic({
    stream: () => outgoing as unknown as MediaStream,
    adopt: (s) => {
      outgoing = s as unknown as FakeStream;
    },
    screenAudioTrack: () => null,
    replaceTrack: (from, to) =>
      replaced.push([from as unknown as FakeTrack | null, to as unknown as FakeTrack]),
    syncStore: () => {
      synced++;
    },
    announce: () => {
      announced++;
    },
  });
});

afterEach(() => {
  mic.teardownMic();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('одна дорожка', () => {
  it('в сеть уходит дорожка устройства — и при включённом пороге тоже', async () => {
    mic.setMicThreshold(0.5);
    await mic.ensureLocalStream();
    expect(sent()).toBe(captured[0]);
    expect(outgoing!.getAudioTracks()).toHaveLength(1);
  });

  it('анализатор слушает клон, а не дорожку, которую глушит затвор', async () => {
    await mic.ensureLocalStream();
    expect(meter()).not.toBe(captured[0]);
    expect(meter().id).toBe('1~clone');
  });
});

describe('затвор', () => {
  beforeEach(async () => {
    mic.setMicThreshold(0.5);
    await mic.ensureLocalStream();
    mic.startGate();
    announced = 0;
    synced = 0;
  });

  it('тише порога — выключена, громче — включена, после спада держится 250 мс', () => {
    level(0.1);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(false);
    expect(meter().enabled).toBe(true); // клон затвор не глушит

    level(0.8);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(true);

    level(0.1);
    vi.advanceTimersByTime(200);
    expect(sent().enabled).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sent().enabled).toBe(false);
  });

  it('затвор — не мут: собеседникам и витрине ничего не объявляется', () => {
    level(0.1);
    vi.advanceTimersByTime(50);
    level(0.8);
    vi.advanceTimersByTime(50);
    expect(announced).toBe(0);
    expect(synced).toBe(0);
  });

  it('мут главнее открытого затвора, а снятый мут при закрытом затворе не включает', () => {
    level(0.8);
    vi.advanceTimersByTime(50);
    mic.setMicOn(false);
    expect(sent().enabled).toBe(false);

    level(0.1);
    vi.advanceTimersByTime(300);
    mic.setMicOn(true);
    expect(sent().enabled).toBe(false);
  });

  it('порог 0 открывает затвор сразу, не дожидаясь тика', () => {
    level(0);
    vi.advanceTimersByTime(50);
    expect(sent().enabled).toBe(false);
    mic.setMicThreshold(0);
    expect(sent().enabled).toBe(true);
  });
});

it('без анализатора затвор не глушит — иначе человека не слышно вовсе', async () => {
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  mic.setMicThreshold(0.5);
  await mic.ensureLocalStream();
  mic.startGate();
  vi.advanceTimersByTime(100);
  expect(mic.hasLocalAnalyser()).toBe(false);
  expect(sent().enabled).toBe(true);
});

it('выход гасит и дорожку устройства, и клон — лампочка записи гаснет', async () => {
  await mic.ensureLocalStream();
  const clone = meter();
  mic.teardownMic();
  expect(captured[0].readyState).toBe('ended');
  expect(clone.readyState).toBe('ended');
});

describe('смена устройства', () => {
  it('одна ветка: подмена у собеседников, старое погашено, мут переехал', async () => {
    await mic.ensureLocalStream();
    const oldClone = meter();
    mic.setMicOn(false);
    await mic.setMic('dev-x');
    expect(replaced).toEqual([[captured[0], captured[1]]]);
    expect(sent()).toBe(captured[1]);
    expect(outgoing!.getAudioTracks()).toHaveLength(1);
    expect(captured[1].enabled).toBe(false);
    expect(captured[0].readyState).toBe('ended');
    expect(oldClone.readyState).toBe('ended');
  });

  it('клон, снятый при муте, всё равно слышит — метр и затвор живы', async () => {
    await mic.ensureLocalStream();
    mic.setMicOn(false);
    await mic.setMic('dev-x');
    expect(meter().id).toBe('2~clone');
    expect(meter().enabled).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TransportHost } from '../types';
import { SIGNALING_GRACE_MS } from './recovery';

/**
 * Сессии SFU-транспорта. Транспорт один на всё приложение и переживает выходы,
 * а вход (`welcome` → устройство → транспорты → публикация) — цепочка ожиданий.
 * Разобрать звонок посреди неё успевают: переезд, выход, реконнект.
 *
 * Недоделанный вход прошлой сессии раньше доезжал до конца и звал `giveUp` уже
 * в лестнице, которую `teardown` только что сбросил: лестница становилась
 * «уже сдавшейся», а следующий `join` без прошлого сокета её не сбрасывал. У
 * новой сессии не было ни сторожа входа, ни ступеней — звонок мог молча висеть
 * без звука. На overhype это читалось как «sfu setup failed no transports»
 * уже после ухода с медиасервера.
 */

type Handler = (...args: unknown[]) => unknown;
type Reply = (err: unknown, res?: unknown) => void;

/**
 * Ответ сервера на запрос. По умолчанию ответа нет вовсе: первым тестам важно
 * только, что вход остановился на ожидании.
 */
let answer: (event: string, payload: unknown, reply: Reply) => void = () => {};

class FakeSocket {
  handlers: Record<string, Handler> = {};
  connected = true;
  recovered = false;
  /** Остановлен нами (`disconnect()`): сам он больше не переподключится. */
  stopped = false;
  opts: Record<string, unknown> = {};
  asked: string[] = [];
  on(event: string, h: Handler) {
    this.handlers[event] = h;
    return this;
  }
  timeout() {
    return {
      emit: (event: string, payload: unknown, reply: Reply) => {
        this.asked.push(event);
        answer(event, payload, reply);
      },
    };
  }
  removeAllListeners() {
    this.handlers = {};
  }
  disconnect() {
    this.connected = false;
    this.stopped = true;
  }
}

const sockets: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
  io: (_url: unknown, opts: Record<string, unknown>) => {
    const s = new FakeSocket();
    s.opts = opts;
    sockets.push(s);
    return s;
  },
}));

// Загрузку устройства держим, пока тест не отпустит: ровно в этом ожидании
// звонок и разбирают.
let releaseLoad: () => void = () => {};
let devices = 0;
// Роли, чья публикация сорвётся один раз — как `produce`, ответ на который
// пропал вместе с сокетом.
const failOnce = new Set<string>();
const produced: string[] = [];

function fakeTransport(id: string) {
  return {
    id,
    connectionState: 'connected',
    on() {},
    close() {},
    async produce({ track, appData }: { track: { kind: string }; appData: { source: string } }) {
      if (failOnce.delete(appData.source)) throw new Error('socket has been disconnected');
      produced.push(appData.source);
      return {
        id: `prod-${appData.source}`,
        kind: track.kind,
        closed: false,
        rtpParameters: { codecs: [{ mimeType: 'x' }] },
        close() {},
        async replaceTrack() {},
      };
    },
    async consume(o: { id: string; producerId: string; kind: string }) {
      return { ...o, closed: false, track: { muted: false }, close() {} };
    },
  };
}

vi.mock('mediasoup-client', () => ({
  Device: class {
    rtpCapabilities = {};
    constructor() {
      devices += 1;
    }
    load() {
      return new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
    }
    canProduce() {
      return true;
    }
    createSendTransport(params: { id: string }) {
      return fakeTransport(params.id);
    }
    createRecvTransport(params: { id: string }) {
      return fakeTransport(params.id);
    }
  },
}));
vi.mock('@/stores/config', () => ({ setting: () => 8 }));
vi.mock('@/lib/i18n', () => ({ tx: (key: string) => key }));

const SETUP_TIMEOUT_MS = 12_000;

function makeHost() {
  return {
    setStatus: vi.fn(),
    diag: vi.fn(),
    transportLost: vi.fn(),
    transportUp: vi.fn(),
    setUplink: vi.fn(),
    setScreenSend: vi.fn(),
    setTileState: vi.fn(),
    setTileNet: vi.fn(),
  } as unknown as TransportHost & {
    diag: ReturnType<typeof vi.fn>;
    transportLost: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  answer = () => {};
  failOnce.clear();
  produced.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('сессии SFU-транспорта', () => {
  it('недоделанный вход разобранной сессии не глушит сторожа следующей', async () => {
    const { createSfuTransport } = await import('./index');
    const host = makeHost();
    const sfu = createSfuTransport(host);
    const ticket = { url: 'https://sfu.example', token: 't' };

    // Первая сессия: сервер поздоровался, грузим устройство…
    sfu.join('room', ticket);
    void sockets[0].handlers['welcome']({ routerRtpCapabilities: {}, peers: [] });
    await vi.advanceTimersByTimeAsync(0);

    // …и тут звонок разбирают (переезд, выход).
    sfu.leave();
    // Загрузка доехала уже после разбора: вход прошлой сессии обязан сойти.
    releaseLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.transportLost).not.toHaveBeenCalled();
    expect(host.diag).not.toHaveBeenCalledWith('sfu setup failed', expect.anything());

    // Вторая сессия не встаёт — сторож входа обязан это заметить.
    sfu.join('room', ticket);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(host.transportLost).toHaveBeenCalledTimes(1);
    expect(host.transportLost).toHaveBeenCalledWith('setup');
  });

  it('сдавшаяся лестница не переживает новый вход и без прошлого сокета', async () => {
    const { createSfuTransport } = await import('./index');
    const host = makeHost();
    const sfu = createSfuTransport(host);
    const ticket = { url: 'https://sfu.example', token: 't' };

    // Первая сессия не встала и сдалась — дирижёр позван.
    sfu.join('room', ticket);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(host.transportLost).toHaveBeenCalledTimes(1);
    sfu.leave();

    // Новая сессия со своим сторожем: не встала — позван снова.
    sfu.join('room', ticket);
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(host.transportLost).toHaveBeenCalledTimes(2);
  });

  /**
   * Обрыв сигналинга посреди звонка. Сокет переподключается сам, а медиасервер
   * держит сессию на время восстановления: вернулась та же сессия — звонок
   * идёт дальше как шёл. Не вернулась — сервер нас уже не помнит, и честнее
   * сразу войти заново, чем сидеть на транспортах, которых у него больше нет.
   */
  it('сокет медиасервера переподключается сам', async () => {
    const { createSfuTransport } = await import('./index');
    const sfu = createSfuTransport(makeHost());
    sfu.join('room', { url: 'https://sfu.example', token: 't' });
    expect(sockets[0].opts.reconnection).toBe(true);
  });

  it('вернулась та же сессия — не сдаёмся; не та — сдаёмся сразу и чужой welcome не берём', async () => {
    const { createSfuTransport } = await import('./index');
    const host = makeHost();
    const sfu = createSfuTransport(host);
    sfu.join('room', { url: 'https://sfu.example', token: 't' });
    const s = sockets[0];
    s.handlers['connect']();

    s.recovered = true;
    s.handlers['connect']();
    expect(host.transportLost).not.toHaveBeenCalled();

    s.recovered = false;
    s.handlers['connect']();
    expect(host.transportLost).toHaveBeenCalledTimes(1);
  });

  it('второй welcome на том же сокете не запускает второй вход', async () => {
    const { createSfuTransport } = await import('./index');
    const host = makeHost();
    const sfu = createSfuTransport(host);
    sfu.join('room', { url: 'https://sfu.example', token: 't' });
    const s = sockets[0];
    const before = devices;
    const welcome = { routerRtpCapabilities: {}, peers: [] };
    void s.handlers['welcome'](welcome);
    void s.handlers['welcome'](welcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(devices - before).toBe(1);
  });

  it('сокет, не открывшийся на входе, останавливается и не входит сам позже', async () => {
    const { createSfuTransport } = await import('./index');
    const host = makeHost();
    const sfu = createSfuTransport(host);
    sfu.join('room', { url: 'https://sfu.example', token: 't' });
    const s = sockets[0];
    const before = devices;
    s.handlers['connect_error']({ message: 'timeout' });
    expect(host.transportLost).toHaveBeenCalledWith('setup');
    expect(s.connected).toBe(false);
    // Даже если welcome всё же доедет — входа нет.
    void s.handlers['welcome']({ routerRtpCapabilities: {}, peers: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(devices - before).toBe(0);
  });

  it('уходя со страницы, прощаемся с медиасервером явно — он снимет нас сразу', async () => {
    const g = globalThis as { window?: EventTarget };
    const had = g.window;
    g.window = new EventTarget();
    try {
      const { createSfuTransport } = await import('./index');
      const sfu = createSfuTransport(makeHost());
      sfu.join('room', { url: 'https://sfu.example', token: 't' });
      g.window.dispatchEvent(new Event('pagehide'));
      expect(sockets[0].connected).toBe(false);
    } finally {
      g.window = had;
    }
  });
});

/**
 * Звонок, который встал: транспорты построены, микрофон и камера уехали.
 * Сервер отвечает на всё «ок», транспорт заводит с id по направлению.
 */
function serverSaysOk(event: string, payload: unknown, reply: Reply) {
  if (event === 'create-transport') {
    reply(null, { ok: true, params: { id: `t-${(payload as { direction: string }).direction}` } });
  } else {
    reply(null, { ok: true });
  }
}

function makeCallHost() {
  const mic = { kind: 'audio' };
  const cam = { kind: 'video' };
  return {
    ...makeHost(),
    localStream: () => ({ getAudioTracks: () => [mic] }),
    screenAudioTrack: () => null,
    videoTrack: () => cam,
    screenOn: () => false,
    addTile: vi.fn(),
    attachRemoteAudio: vi.fn(),
  } as unknown as ReturnType<typeof makeHost> & {
    transportUp: ReturnType<typeof vi.fn>;
    attachRemoteAudio: ReturnType<typeof vi.fn>;
  };
}

async function upAndRunning(host: ReturnType<typeof makeCallHost>) {
  const { createSfuTransport } = await import('./index');
  const sfu = createSfuTransport(host);
  answer = serverSaysOk;
  sfu.join('room', { url: 'https://sfu.example', token: 't' });
  const s = sockets[sockets.length - 1];
  s.handlers['connect']();
  void s.handlers['welcome']({ routerRtpCapabilities: {}, peers: [] });
  await vi.advanceTimersByTimeAsync(0);
  releaseLoad();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.transportUp).toHaveBeenCalled();
  return s;
}

/** Сокет оборвался и вернулся той же сессией. */
async function blip(s: FakeSocket) {
  s.connected = false;
  s.handlers['disconnect']();
  s.connected = true;
  s.recovered = true;
  s.handlers['connect']();
  await vi.advanceTimersByTimeAsync(0);
}

describe('обрыв сигналинга посреди звонка', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', class {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Сдавшейся сессии сокет не нужен: новую заводит дирижёр. Сам же он
   * переподключается — и пока медиасервер лежит (api не выдаёт пропусков, и
   * дирижёр ничего не разбирает), долбил бы его раз в пару секунд, каждый раз
   * с вехой на сервер.
   */
  it('сдавшись, сокет больше не дозванивается сам', async () => {
    const host = makeCallHost();
    const s = await upAndRunning(host);
    s.connected = false;
    s.handlers['disconnect']();
    await vi.advanceTimersByTimeAsync(SIGNALING_GRACE_MS);
    expect(host.transportLost).toHaveBeenCalledWith('lost');
    expect(s.stopped).toBe(false);

    s.handlers['connect_error']({ message: 'xhr poll error' });
    expect(s.stopped).toBe(true);
  });

  it('сессию, вернувшуюся уже после отказа, не подбираем', async () => {
    const host = makeCallHost();
    const s = await upAndRunning(host);
    s.connected = false;
    s.handlers['disconnect']();
    await vi.advanceTimersByTimeAsync(SIGNALING_GRACE_MS);

    s.connected = true;
    s.recovered = true;
    s.handlers['connect']();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stopped).toBe(true);
    expect(s.asked).not.toContain('snapshot');
  });

  /**
   * Ответы на запросы, бывшие в полёте, обрыв уносит, а сессия идёт дальше —
   * без сверки сорвавшаяся подписка значила бы «его не слышно» до конца
   * звонка, а сорвавшаяся публикация — камеру, которую никто не видит.
   */
  it('вернувшись, добирает то, что обрыв унёс: свою камеру и чужой микрофон', async () => {
    const host = makeCallHost();
    failOnce.add('cam');
    const s = await upAndRunning(host);
    expect(produced).toEqual(['mic']);

    answer = (event, payload, reply) => {
      if (event === 'snapshot') {
        reply(null, {
          ok: true,
          peers: [
            { peerId: 'b', name: 'Боря', producers: [{ id: 'pb', kind: 'audio', source: 'mic' }] },
          ],
        });
      } else if (event === 'consume') {
        reply(null, {
          ok: true,
          consumer: {
            id: 'cb',
            producerId: 'pb',
            peerId: 'b',
            kind: 'audio',
            rtpParameters: {},
            source: 'mic',
          },
        });
      } else serverSaysOk(event, payload, reply);
    };
    await blip(s);

    // Микрофон жив — его не трогаем; камеру публикуем заново.
    expect(produced).toEqual(['mic', 'cam']);
    expect(host.attachRemoteAudio).toHaveBeenCalledWith(
      'b',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('дорожку, на которую уже подписываемся, снимок второй раз не подписывает', async () => {
    const host = makeCallHost();
    const s = await upAndRunning(host);
    const pb = { id: 'pb', kind: 'audio', source: 'mic' };
    let consumed: Reply = () => {};
    answer = (event, payload, reply) => {
      if (event === 'snapshot')
        reply(null, { ok: true, peers: [{ peerId: 'b', name: 'Боря', producers: [pb] }] });
      else if (event === 'consume')
        consumed = reply; // ответ задержался
      else serverSaysOk(event, payload, reply);
    };

    // Доигранное за обрыв `new-producer` и снимок приходят почти разом.
    s.handlers['new-producer']({ peerId: 'b', producer: pb });
    await blip(s);
    consumed(null, {
      ok: true,
      consumer: {
        id: 'cb',
        producerId: 'pb',
        peerId: 'b',
        kind: 'audio',
        rtpParameters: {},
        source: 'mic',
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(s.asked.filter((e) => e === 'consume')).toHaveLength(1);
    expect(host.attachRemoteAudio).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TransportHost } from '../types';

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

class FakeSocket {
  handlers: Record<string, Handler> = {};
  connected = true;
  recovered = false;
  opts: Record<string, unknown> = {};
  on(event: string, h: Handler) {
    this.handlers[event] = h;
    return this;
  }
  timeout() {
    // Ответа на запросы не будет: для этих тестов важно только, что вход
    // остановился на ожидании.
    return { emit: () => {} };
  }
  removeAllListeners() {
    this.handlers = {};
  }
  disconnect() {
    this.connected = false;
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
vi.mock('mediasoup-client', () => ({
  Device: class {
    constructor() {
      devices += 1;
    }
    load() {
      return new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
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

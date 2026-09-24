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
  io: () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  },
}));

// Загрузку устройства держим, пока тест не отпустит: ровно в этом ожидании
// звонок и разбирают.
let releaseLoad: () => void = () => {};
vi.mock('mediasoup-client', () => ({
  Device: class {
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
});

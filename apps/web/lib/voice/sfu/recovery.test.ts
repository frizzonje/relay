import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLadder, type Ladder } from './recovery';
import type { TransportHost } from '../types';

/**
 * Лестница восстановления связи с медиасервером.
 *
 * До этого файла у неё не было ни одного теста — при десяти у лестницы mesh, —
 * и оба бага, найденные в ней до сих пор, нашлись глазами и поздно. Проверяем
 * то, что в живом звонке проверить нечем: что ступени идут по порядку, что
 * сдача случается ровно один раз и что после неё сторожа замолкают.
 */

const RECOVER_WINDOW_MS = 8_000;
const SETUP_TIMEOUT_MS = 12_000;

function makeHost() {
  return {
    setStatus: vi.fn(),
    diag: vi.fn(),
    transportLost: vi.fn(),
  } as unknown as TransportHost & {
    setStatus: ReturnType<typeof vi.fn>;
    diag: ReturnType<typeof vi.fn>;
    transportLost: ReturnType<typeof vi.fn>;
  };
}

describe('лестница SFU', () => {
  let host: ReturnType<typeof makeHost>;
  let ladder: Ladder;
  let broken: boolean;
  let connected: boolean;
  let restarts: number;
  let rebuilds: number;
  let tiles: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    host = makeHost();
    broken = false;
    connected = true;
    restarts = 0;
    rebuilds = 0;
    tiles = [];
    ladder = createLadder({
      host,
      broken: () => broken,
      hasSocket: () => true,
      socketConnected: () => connected,
      restartIce: async () => {
        restarts += 1;
      },
      rebuild: async () => {
        rebuilds += 1;
      },
      tellTiles: (b) => tiles.push(b),
    });
  });

  afterEach(() => {
    ladder.reset();
    vi.useRealTimers();
  });

  /** Довести до «мы на связи», как это делает удавшийся вход. */
  function up() {
    ladder.armSetup();
    ladder.markUp();
    ladder.transportState('send', 'connected');
    ladder.transportState('recv', 'connected');
  }

  it('вход не поднялся за отведённое время — это отказ, а не «ещё чуть-чуть»', async () => {
    ladder.armSetup();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);
    expect(host.transportLost).toHaveBeenCalledWith('setup');
  });

  it('успели встать — сторож входа больше не выстрелит', async () => {
    up();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS * 2);
    expect(host.transportLost).not.toHaveBeenCalled();
  });

  it('транспорт упал: ступень 1, ступень 2, сдача', async () => {
    up();
    broken = true;
    ladder.transportState('recv', 'failed');

    await vi.advanceTimersByTimeAsync(0);
    expect(restarts).toBe(1);
    expect(rebuilds).toBe(0);

    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(rebuilds).toBe(1);

    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(host.transportLost).toHaveBeenCalledWith('lost');
  });

  it('«отвалилось» получает фору, «умерло» лечится сразу', async () => {
    up();
    broken = true;
    ladder.transportState('send', 'disconnected');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(restarts).toBe(0); // фора ещё идёт
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restarts).toBe(1);
  });

  it('отпустило само, пока ждали, — ступень не жжётся', async () => {
    up();
    broken = true;
    ladder.transportState('recv', 'disconnected');
    broken = false;

    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(restarts).toBe(0);
    expect(host.transportLost).not.toHaveBeenCalled();
  });

  it('пока лестница идёт, на плитках об этом написано — и снимается это один раз', async () => {
    up();
    expect(tiles).toEqual([]); // вставать молча — правильно

    broken = true;
    ladder.transportState('recv', 'failed');
    ladder.transportState('send', 'failed'); // второй транспорт — та же беда
    expect(tiles).toEqual([true]);

    broken = false;
    ladder.transportState('recv', 'connected');
    ladder.transportState('send', 'connected');
    expect(tiles).toEqual([true, false]);
  });

  it('пока лежит второй транспорт, надпись не снимаем', () => {
    up();
    broken = true;
    ladder.transportState('recv', 'failed');
    // Первый вернулся, второй ещё нет: связи по-прежнему нет.
    ladder.transportState('recv', 'connected');
    expect(tiles).toEqual([true]);
  });

  it('до того как мы встали, лестница молчит: чинить нечего', async () => {
    ladder.armSetup();
    broken = true;
    ladder.transportState('recv', 'failed');
    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(restarts).toBe(0);
    expect(tiles).toEqual([]);
  });

  it('сигналинг оборвался и не вернулся — сдаёмся; вернулся — нет', async () => {
    up();
    connected = false;
    ladder.signalingLost();
    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(host.transportLost).toHaveBeenCalledWith('lost');

    // И то же самое, но сокет успел вернуться.
    ladder.reset();
    host.transportLost.mockClear();
    up();
    connected = false;
    ladder.signalingLost();
    connected = true;
    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS);
    expect(host.transportLost).not.toHaveBeenCalled();
  });

  it('сдались один раз — дирижёра второй раз не зовём и сторожа не заводим', async () => {
    up();
    broken = true;
    ladder.giveUp('lost');
    ladder.giveUp('lost');
    ladder.transportState('recv', 'failed');
    await vi.advanceTimersByTimeAsync(RECOVER_WINDOW_MS * 3);

    expect(host.transportLost).toHaveBeenCalledTimes(1);
    expect(restarts).toBe(0);
    expect(rebuilds).toBe(0);
  });
});

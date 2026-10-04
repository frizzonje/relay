import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMetrics } from './metrics';
import type { ConsumerEntry, Subscriber } from './subscribe';
import type { TransportHost } from '../types';

/**
 * Сторож односторонней тишины.
 *
 * Путь до медиасервера у нас один на всех, а молчать может один собеседник —
 * у него отвалилась сеть, заснул телефон. Раньше молчание любого одного
 * поднимало у ВСЕХ слушателей ступени 2 и 3: каждый переизбирал ICE и
 * пересобирал свои транспорты, и на секунды глохла вся комната (overhype,
 * 29.09, 20:49 и 21:11). Свой путь чинить стоит, только когда не слышно никого.
 */

const TICK_MS = 3_000;

/** Входящая аудиодорожка: байты либо растут каждый тик, либо стоят. */
function audio(peerId: string, flowing: () => boolean): ConsumerEntry {
  let bytes = 1_000;
  const consumer = {
    id: `c-${peerId}`,
    kind: 'audio',
    closed: false,
    getStats: async () => {
      if (flowing()) bytes += 4_000;
      return new Map([
        ['in', { type: 'inbound-rtp', kind: 'audio', bytesReceived: bytes, packetsReceived: 1 }],
      ]);
    },
  };
  return { producerId: `p-${peerId}`, peerId, source: 'mic', consumer } as unknown as ConsumerEntry;
}

function setup(entries: ConsumerEntry[]) {
  const host = {
    setTileNet: vi.fn(),
    setPing: vi.fn(),
    setUplink: vi.fn(),
    setScreenSend: vi.fn(),
    screenOn: () => false,
    videoTrack: () => null,
    setTileState: vi.fn(),
    diag: vi.fn(),
  } as unknown as TransportHost;
  const subscriber = {
    peerIds: () => [...new Set(entries.map((e) => e.peerId))],
    entries: () => entries,
    nameOf: (id: string) => id,
    layerOf: () => null,
    sayTileState: vi.fn(),
  } as unknown as Subscriber;
  const ask = vi.fn(async () => ({ ok: true as const }));
  const restartIce = vi.fn(async () => {});
  const rebuild = vi.fn(async () => {});
  const metrics = createMetrics({
    host,
    subscriber,
    ask,
    transports: () => [],
    uplink: async () => 'ok',
    screenSend: async () => null,
    broken: () => false,
    isUp: () => true,
    gaveUp: () => false,
    restartIce,
    rebuild,
  });
  async function run(ms: number) {
    for (let t = 0; t <= ms; t += TICK_MS) {
      await metrics.tick();
      vi.advanceTimersByTime(TICK_MS);
    }
  }
  return { ask, restartIce, rebuild, run };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('сторож тишины SFU', () => {
  it('молчит один, остальных слышно — свою связь не трогаем, только будим его дорожку', async () => {
    const { ask, restartIce, rebuild, run } = setup([
      audio('молчун', () => false),
      audio('говорун', () => true),
    ]);
    await run(60_000);
    expect(restartIce).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith('resume', { consumerId: 'c-молчун' });
  });

  it('не слышно никого — значит, сломан наш путь: лестница идёт как шла', async () => {
    const { restartIce, rebuild, run } = setup([audio('a', () => false), audio('b', () => false)]);
    await run(40_000);
    expect(restartIce).toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalled();
  });

  it('собеседник один, и он молчит — отличить нельзя, чиним свой путь', async () => {
    const { restartIce, run } = setup([audio('a', () => false)]);
    await run(30_000);
    expect(restartIce).toHaveBeenCalled();
  });
});

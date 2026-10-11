import { describe, expect, it, vi } from 'vitest';
import type { TransportHost } from '../types';
import { createMetrics, type MetricsPeer } from './metrics';
import type { Silence } from './silence';

/**
 * Тик опроса ждёт `getStats` каждого соединения. За это время собеседника
 * успевают пересобрать (новый pc) или звонок покидают вовсе: снимок старого
 * pc нельзя ни отдавать сторожу тишины — он записал бы его счётчик байтов
 * новому соединению и «чинил» здоровое, — ни рисовать после выхода.
 */
describe('mesh metrics tick', () => {
  function setup() {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pc = (bytes: number) =>
      ({
        getStats: vi.fn(async () => {
          await held;
          return new Map([['in', { type: 'inbound-rtp', kind: 'audio', bytesReceived: bytes }]]);
        }),
        getTransceivers: () => [],
      }) as unknown as RTCPeerConnection;
    const old = pc(50_000);
    let table = new Map<string, MetricsPeer>([['a', { name: 'Аня', pc: old, connected: true }]]);
    let room = true;
    const silence = { check: vi.fn(() => []), forget: vi.fn() } as unknown as Silence;
    const host = {
      setPing: vi.fn(),
      setTileNet: vi.fn(),
      setUplink: vi.fn(),
      setScreenSend: vi.fn(),
      screenOn: () => false,
      diag: vi.fn(),
    } as unknown as TransportHost;
    const metrics = createMetrics({
      host,
      silence,
      peers: () => new Map(table),
      inRoom: () => room,
      receivesScreen: () => false,
      repair: vi.fn(),
    });
    return {
      metrics,
      silence,
      host,
      release,
      rebuild: () => (table = new Map([['a', { name: 'Аня', pc: pc(0), connected: true }]])),
      leave: () => {
        room = false;
        table = new Map();
      },
    };
  }

  it('a snapshot of a rebuilt connection never reaches the silence watchdog', async () => {
    const { metrics, silence, release, rebuild } = setup();
    const tick = metrics.tick();
    rebuild();
    release();
    await tick;
    const probes = vi.mocked(silence.check).mock.calls.flatMap(([p]) => p);
    expect(probes).toEqual([]);
  });

  it('a tick that outlived the call writes nothing', async () => {
    const { metrics, host, silence, release, leave } = setup();
    const tick = metrics.tick();
    leave();
    release();
    await tick;
    expect(host.setPing).not.toHaveBeenCalled();
    expect(silence.check).not.toHaveBeenCalled();
  });
});

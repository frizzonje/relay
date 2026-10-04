import { describe, expect, it } from 'vitest';
import { createScreenTelemetry, readTx } from './screen-telemetry';

/** Отчёт `getStats()` — `Map` с `forEach` и `get`, как в stats.test.ts. */
function report(...records: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>();
  records.forEach((r, i) => map.set((r.id as string) ?? `r${i}`, r));
  return map as unknown as RTCStatsReport;
}

const codec = { id: 'c1', type: 'codec', mimeType: 'video/H264' };
const pair = {
  type: 'candidate-pair',
  state: 'succeeded',
  nominated: true,
  availableOutgoingBitrate: 7_900_000,
};

function layer(rid: string, height: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'outbound-rtp',
    kind: 'video',
    rid,
    codecId: 'c1',
    frameWidth: Math.round((height * 16) / 10),
    frameHeight: height,
    framesPerSecond: 30,
    bytesSent: 0,
    targetBitrate: 6_000_000,
    qualityLimitationReason: 'none',
    encoderImplementation: 'VideoToolbox',
    ...extra,
  };
}

describe('readTx', () => {
  it('слои снизу вверх, оценка канала и кодек — из того же отчёта', () => {
    const tx = readTx(report(codec, pair, layer('r1', 1440), layer('r0', 720)));
    expect(tx.layers.map((l) => [l.rid, l.height])).toEqual([
      ['r0', 720],
      ['r1', 1440],
    ]);
    expect(tx.bweKbps).toBe(7900);
    expect(tx.codec).toBe('H264');
    expect(tx.impl).toBe('VideoToolbox');
  });

  it('выключенный движком слой — «не идёт», а не нулевой кадр', () => {
    const tx = readTx(report(codec, layer('r0', 720), layer('r1', 0, { frameHeight: undefined })));
    expect(tx.layers[1].sending).toBe(false);
  });
});

describe('createScreenTelemetry', () => {
  function setup() {
    const lines: string[] = [];
    let now = 0;
    const telemetry = createScreenTelemetry(
      (event, detail) => lines.push(`${event}: ${detail}`),
      () => now,
    );
    return { lines, telemetry, at: (ms: number) => (now = ms) };
  }

  it('пишет картину, причину и оценку канала по каждому слою', () => {
    const { lines, telemetry } = setup();
    telemetry.tx(
      report(codec, pair, layer('r0', 720), layer('r1', 624, { qualityLimitationReason: 'cpu' })),
    );
    expect(lines).toEqual([
      'screen tx: r0 1152x720@30 ?/6.0M | r1 998x624@30 ?/6.0M cpu | bwe 7.9M H264 VideoToolbox',
    ]);
  });

  it('без перемен молчит до пульса, перемену пишет не чаще раза в 6 с', () => {
    const { lines, telemetry, at } = setup();
    const steady = () => report(codec, layer('r0', 720), layer('r1', 1440));
    telemetry.tx(steady());
    at(10_000);
    telemetry.tx(steady()); // та же картина — тишина
    at(12_000);
    telemetry.tx(report(codec, layer('r0', 720), layer('r1', 624))); // перемена через 12 с — пишем
    at(14_000);
    telemetry.tx(report(codec, layer('r0', 720), layer('r1', 540))); // перемена, но 2 с — ждём
    at(45_000);
    telemetry.tx(report(codec, layer('r0', 720), layer('r1', 540))); // пульс
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('r1 998x624');
    expect(lines[2]).toContain('r1 864x540');
  });

  it('битрейт слоя считается за интервал между тиками', () => {
    const { lines, telemetry, at } = setup();
    telemetry.tx(report(codec, layer('r0', 720, { bytesSent: 0 })));
    at(8_000);
    telemetry.tx(report(codec, layer('r0', 360, { bytesSent: 1_000_000 })));
    expect(lines[1]).toContain('r0 576x360@30 1.0M/6.0M');
  });

  it('слои без rid (Safari) — битрейт у каждого свой, по ssrc', () => {
    const { lines, telemetry, at } = setup();
    const safari = (low: number, high: number) =>
      report(
        codec,
        layer('', 682, { rid: undefined, ssrc: 2, bytesSent: high }),
        layer('', 341, { rid: undefined, ssrc: 1, bytesSent: low }),
      );
    telemetry.tx(safari(0, 0));
    at(31_000); // пульс
    telemetry.tx(safari(300_000, 4_000_000));
    expect(lines[0]).toMatch(/^screen tx: - 546x341@30 \?\/6\.0M \| - 1091x682@30 \?\/6\.0M/);
    expect(lines[1]).toContain('- 546x341@30 77k/6.0M | - 1091x682@30 1.0M/6.0M');
  });

  it('зритель: кадр, битрейт и слой; без кадров — не пишет', () => {
    const { lines, telemetry, at } = setup();
    const inbound = (bytes: number, height: number) =>
      report(codec, {
        type: 'inbound-rtp',
        kind: 'video',
        codecId: 'c1',
        frameWidth: height ? 2304 : undefined,
        frameHeight: height || undefined,
        framesPerSecond: 30,
        bytesReceived: bytes,
        framesDropped: 1,
        freezeCount: 0,
      });
    telemetry.rx('a', inbound(0, 0), 0);
    expect(lines).toHaveLength(0);
    telemetry.rx('a', inbound(0, 1440), 1);
    at(8_000);
    telemetry.rx('a', inbound(8_000_000, 720), 0);
    expect(lines).toEqual([
      'screen rx: a 2304x1440@30 ? layer 1 H264 dropped 1 freezes 0',
      'screen rx: a 2304x720@30 8.0M layer 0 H264 dropped 1 freezes 0',
    ]);
  });
});

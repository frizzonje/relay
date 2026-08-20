import { describe, expect, it } from 'vitest';
import { emptySnapshot, netDelta, readStats, toHistory, worseUplink } from './stats';

/**
 * Отчёт `getStats()` — это `ReadonlyMap` с `forEach` и `get`, ровно то, чем
 * мы им и пользуемся. Поэтому подделка здесь честная: обычный `Map`.
 */
function report(...records: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>();
  records.forEach((r, i) => map.set((r.id as string) ?? `r${i}`, r));
  return map as unknown as RTCStatsReport;
}

describe('readStats', () => {
  it('пустой отчёт — снимок, в котором ничего не известно', () => {
    expect(readStats(report())).toEqual(emptySnapshot());
  });

  it('пар кандидатов нет вовсе — rtt и путь неизвестны, а не нулевые', () => {
    const snap = readStats(report({ type: 'inbound-rtp', kind: 'audio', packetsReceived: 100 }));
    expect(snap.rttMs).toBeNull();
    expect(snap.relay).toBeNull();
    expect(snap.recv).toBe(100);
  });

  it('берёт лучшую пару из успешных и не смотрит на остальные', () => {
    const snap = readStats(
      report(
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.12 },
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.04 },
        { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 0.001 },
        { type: 'candidate-pair', state: 'succeeded' },
      ),
    );
    expect(snap.rttMs).toBe(40);
  });

  it('реле — если релейный хотя бы один конец выбранной пары', () => {
    const pair = {
      type: 'candidate-pair',
      state: 'succeeded',
      currentRoundTripTime: 0.05,
      localCandidateId: 'L',
      remoteCandidateId: 'R',
    };
    const direct = readStats(
      report(pair, { id: 'L', candidateType: 'srflx' }, { id: 'R', candidateType: 'host' }),
    );
    expect(direct.relay).toBe(false);

    const viaTurn = readStats(
      report(pair, { id: 'L', candidateType: 'host' }, { id: 'R', candidateType: 'relay' }),
    );
    expect(viaTurn.relay).toBe(true);
  });

  it('кандидатов пары в отчёте нет — путь неизвестен, но rtt всё равно есть', () => {
    const snap = readStats(
      report({
        type: 'candidate-pair',
        state: 'succeeded',
        currentRoundTripTime: 0.05,
        localCandidateId: 'L',
        remoteCandidateId: 'R',
      }),
    );
    expect(snap.rttMs).toBe(50);
    expect(snap.relay).toBeNull();
  });

  it('входящие дорожки: счётчики складываются, звук считается ещё и отдельно', () => {
    const snap = readStats(
      report(
        {
          type: 'inbound-rtp',
          kind: 'audio',
          packetsLost: 3,
          packetsReceived: 297,
          bytesReceived: 4000,
          jitter: 0.012,
        },
        {
          type: 'inbound-rtp',
          kind: 'video',
          packetsLost: 7,
          packetsReceived: 693,
          bytesReceived: 96_000,
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 29.6,
          codecId: 'C',
        },
        { id: 'C', mimeType: 'video/VP8' },
      ),
    );
    expect(snap).toMatchObject({
      lost: 10,
      recv: 990,
      bytesRecv: 100_000,
      audioBytesRecv: 4000,
      jitterMs: 12,
      videoRes: '1280×720',
      fps: 30,
      codec: 'VP8',
    });
  });

  it('mediaType вместо kind — старые движки зовут поле так', () => {
    const snap = readStats(
      report({ type: 'inbound-rtp', mediaType: 'audio', bytesReceived: 512, jitter: 0.03 }),
    );
    expect(snap.audioBytesRecv).toBe(512);
    expect(snap.jitterMs).toBe(30);
  });

  it('исходящее видео: полоса перебивает процессор', () => {
    const snap = readStats(
      report(
        { type: 'outbound-rtp', kind: 'video', bytesSent: 10, qualityLimitationReason: 'cpu' },
        {
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 20,
          qualityLimitationReason: 'bandwidth',
        },
        { type: 'outbound-rtp', kind: 'audio', bytesSent: 5 },
      ),
    );
    expect(snap.uplink).toBe('bandwidth');
    expect(snap.bytesSent).toBe(35);
  });

  it('несколько отчётов складываются в один снимок собеседника', () => {
    const snap = readStats([
      report({ type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, bytesReceived: 1000 }),
      report({
        type: 'inbound-rtp',
        kind: 'video',
        packetsReceived: 900,
        bytesReceived: 50_000,
        framesPerSecond: 24,
      }),
    ]);
    expect(snap.recv).toBe(1000);
    expect(snap.bytesRecv).toBe(51_000);
    expect(snap.audioBytesRecv).toBe(1000);
    expect(snap.fps).toBe(24);
  });

  it('из нескольких отчётов берётся меньший rtt', () => {
    const snap = readStats([
      report({ type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.09 }),
      report({ type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.03 }),
    ]);
    expect(snap.rttMs).toBe(30);
  });
});

describe('netDelta', () => {
  const snap = { ...emptySnapshot(), lost: 10, recv: 990, bytesSent: 20_000, bytesRecv: 40_000 };

  it('базы ещё нет — потери и битрейт неизвестны, а не нулевые', () => {
    expect(netDelta(undefined, snap, 1000)).toEqual({
      lossPct: null,
      sendKbps: null,
      recvKbps: null,
    });
  });

  it('считает за интервал, а не с начала звонка', () => {
    const prev = toHistory(
      { ...snap, lost: 8, recv: 890, bytesSent: 15_000, bytesRecv: 30_000 },
      0,
    );
    const delta = netDelta(prev, snap, 1000);
    expect(delta.lossPct).toBe(2); // 2 потери на 100 доехавших
    expect(delta.sendKbps).toBe(40); // 5000 байт за секунду
    expect(delta.recvKbps).toBe(80);
  });

  it('счётчики сбросились на пересборке — не уходим в минус', () => {
    const prev = toHistory(
      { ...snap, lost: 99, recv: 9999, bytesSent: 99_999, bytesRecv: 99_999 },
      0,
    );
    const delta = netDelta(prev, snap, 1000);
    expect(delta.lossPct).toBe(0);
    expect(delta.sendKbps).toBe(0);
  });
});

describe('worseUplink', () => {
  it('полоса важнее процессора, процессор важнее «всё в порядке»', () => {
    expect(worseUplink('ok', 'cpu')).toBe('cpu');
    expect(worseUplink('cpu', 'bandwidth')).toBe('bandwidth');
    expect(worseUplink('ok', 'ok')).toBe('ok');
  });
});

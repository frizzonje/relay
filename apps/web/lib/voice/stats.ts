'use client';

import type { UplinkStatus } from '@/stores/voice';
import { kbps, limitReason } from './quality';

/**
 * Разбор отчёта `getStats()` — один на оба транспорта.
 *
 * Снимают статистику они с разных соединений (mesh — с соединения до
 * собеседника, SFU — с соединения до медиасервера), и это остаётся их делом.
 * А вот что означают строчки отчёта, различаться не может: `inbound-rtp` — это
 * `inbound-rtp` в обоих режимах. Раньше разбор был написан дважды, и копии
 * успели разойтись — в сторону вранья (см. docs/plans/refactor.md, Б1).
 *
 * Функция чистая: ни состояния, ни `host`, ни транспорта — только отчёт на
 * входе и снимок на выходе. Историю тиков и дельты держит вызывающий.
 */

/** Всё, что мы читаем из отчёта. Счётчики — накопленным итогом, не за интервал. */
export interface StatsSnapshot {
  /** RTT лучшей успешной пары кандидатов, мс (null — пар в отчёте нет). */
  rttMs: number | null;
  /** Путь через TURN-реле; null — определять не по чему. */
  relay: boolean | null;
  /** Потеряно/принято пакетов и байт по всем входящим дорожкам. */
  lost: number;
  recv: number;
  bytesRecv: number;
  bytesSent: number;
  /**
   * Байты входящего ЗВУКА отдельно: по ним сторож ловит одностороннюю тишину.
   * В общей сумме их не видно — видео перебивает молчащий микрофон.
   */
  audioBytesRecv: number;
  /** Джиттер входящего аудио, мс. */
  jitterMs: number | null;
  /** Входящее видео: «1280×720», кадры/с и кодек («VP8», «H264»). */
  videoRes: string | null;
  fps: number | null;
  codec: string | null;
  /** Худшее ограничение своего исходящего видео в этом отчёте. */
  uplink: UplinkStatus;
}

/** Снимок, в котором нет ничего: с него начинается сложение и им же кончается пустой отчёт. */
export function emptySnapshot(): StatsSnapshot {
  return {
    rttMs: null,
    relay: null,
    lost: 0,
    recv: 0,
    bytesRecv: 0,
    bytesSent: 0,
    audioBytesRecv: 0,
    jitterMs: null,
    videoRes: null,
    fps: null,
    codec: null,
    uplink: 'ok',
  };
}

/** Полоса важнее процессора: она рвёт картинку у всех, он — только у нас. */
export function worseUplink(a: UplinkStatus, b: UplinkStatus): UplinkStatus {
  if (a === 'bandwidth' || b === 'bandwidth') return 'bandwidth';
  if (a === 'cpu' || b === 'cpu') return 'cpu';
  return 'ok';
}

/** Поля отчёта, которые нам интересны. В типах браузера их нет — они опциональны везде. */
interface StatsRecord {
  type?: string;
  kind?: string;
  mediaType?: string;
  state?: string;
  currentRoundTripTime?: number;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  bytesSent?: number;
  jitter?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  codecId?: string;
  mimeType?: string;
  qualityLimitationReason?: string;
}

/**
 * Сложить два снимка в один.
 *
 * Нужно там, где источников больше одного, а показать надо одно: у
 * собеседника на медиасервере своя дорожка на каждую роль, каждая отвечает
 * своим отчётом, а плитка у него одна. Счётчики складываются, RTT берётся
 * лучший (вместе с путём, который его дал), остальное — последнее известное.
 */
export function mergeStats(a: StatsSnapshot, b: StatsSnapshot): StatsSnapshot {
  const better = b.rttMs !== null && (a.rttMs === null || b.rttMs < a.rttMs);
  return {
    rttMs: better ? b.rttMs : a.rttMs,
    relay: better ? b.relay : a.relay,
    lost: a.lost + b.lost,
    recv: a.recv + b.recv,
    bytesRecv: a.bytesRecv + b.bytesRecv,
    bytesSent: a.bytesSent + b.bytesSent,
    audioBytesRecv: a.audioBytesRecv + b.audioBytesRecv,
    jitterMs: b.jitterMs ?? a.jitterMs,
    videoRes: b.videoRes ?? a.videoRes,
    fps: b.fps ?? a.fps,
    codec: b.codec ?? a.codec,
    uplink: worseUplink(a.uplink, b.uplink),
  };
}

/** Сложить сколько угодно снимков; из ничего выходит пустой. */
export function sumStats(snaps: StatsSnapshot[]): StatsSnapshot {
  return snaps.reduce(mergeStats, emptySnapshot());
}

/**
 * Разобрать отчёт `getStats()` (или несколько — они складываются).
 */
export function readStats(input: RTCStatsReport | RTCStatsReport[]): StatsSnapshot {
  const snap = emptySnapshot();
  for (const report of Array.isArray(input) ? input : [input]) {
    // Копим в объект, а не в отдельные `let`: ссылки внутри отчёта (кандидаты
    // выбранной пары, кодек дорожки) действительны только внутри своего отчёта,
    // и разрешать их надо там же, где нашли.
    const found = { rtt: Number.POSITIVE_INFINITY, local: '', remote: '', codecId: '' };
    report.forEach((raw) => {
      const r = raw as StatsRecord;
      const kind = r.kind ?? r.mediaType;
      if (r.type === 'candidate-pair') {
        if (r.state !== 'succeeded' || r.currentRoundTripTime == null) return;
        const ms = Math.round(r.currentRoundTripTime * 1000);
        if (ms >= found.rtt) return;
        found.rtt = ms;
        found.local = r.localCandidateId ?? '';
        found.remote = r.remoteCandidateId ?? '';
        return;
      }
      if (kind !== 'audio' && kind !== 'video') return;
      if (r.type === 'inbound-rtp') {
        snap.lost += r.packetsLost ?? 0;
        snap.recv += r.packetsReceived ?? 0;
        snap.bytesRecv += r.bytesReceived ?? 0;
        if (kind === 'audio') {
          snap.audioBytesRecv += r.bytesReceived ?? 0;
          if (r.jitter != null) snap.jitterMs = Math.round(r.jitter * 1000);
          return;
        }
        if (r.frameWidth && r.frameHeight) snap.videoRes = `${r.frameWidth}×${r.frameHeight}`;
        if (r.framesPerSecond != null) snap.fps = Math.round(r.framesPerSecond);
        if (r.codecId) found.codecId = r.codecId;
        return;
      }
      if (r.type === 'outbound-rtp') {
        snap.bytesSent += r.bytesSent ?? 0;
        if (kind === 'video') {
          snap.uplink = worseUplink(snap.uplink, limitReason(r.qualityLimitationReason));
        }
      }
    });

    if (found.rtt !== Number.POSITIVE_INFINITY && (snap.rttMs === null || found.rtt < snap.rttMs)) {
      snap.rttMs = found.rtt;
      // Реле, если релейный хотя бы один конец выбранной пары: задержку добавляет
      // любой из них, и на плитке это объясняет высокий пинг «на ровном месте».
      const local = report.get(found.local) as StatsRecord | undefined;
      const remote = report.get(found.remote) as StatsRecord | undefined;
      snap.relay =
        local || remote
          ? local?.candidateType === 'relay' || remote?.candidateType === 'relay'
          : null;
    }
    if (found.codecId) {
      const mime = (report.get(found.codecId) as StatsRecord | undefined)?.mimeType;
      if (mime) snap.codec = mime.split('/')[1]?.toUpperCase() ?? null;
    }
  }
  return snap;
}

/** Снимок счётчиков с прошлого тика: потери/приём — для % за интервал, байты — для кбит/с. */
export interface NetSnapshot {
  lost: number;
  recv: number;
  bytesSent: number;
  bytesRecv: number;
  ts: number;
}

/** Счётчики этого тика — в историю, чтобы на следующем было с чем сравнить. */
export function toHistory(snap: StatsSnapshot, ts: number): NetSnapshot {
  return {
    lost: snap.lost,
    recv: snap.recv,
    bytesSent: snap.bytesSent,
    bytesRecv: snap.bytesRecv,
    ts,
  };
}

/** Потери и битрейт ЗА ИНТЕРВАЛ, а не накопленным итогом с начала звонка. */
export interface NetDelta {
  lossPct: number | null;
  sendKbps: number | null;
  recvKbps: number | null;
}

/**
 * Разница с прошлым тиком. Базы ещё нет (первый тик после входа или после
 * пересборки) — потери и битрейт неизвестны, а не нулевые.
 */
export function netDelta(
  prev: NetSnapshot | undefined,
  snap: StatsSnapshot,
  now: number,
): NetDelta {
  if (!prev) return { lossPct: null, sendKbps: null, recvKbps: null };
  const dLost = Math.max(0, snap.lost - prev.lost);
  const dRecv = Math.max(0, snap.recv - prev.recv);
  const total = dLost + dRecv;
  const dt = now - prev.ts;
  return {
    lossPct: total > 0 ? Math.round((dLost / total) * 1000) / 10 : 0,
    sendKbps: kbps(snap.bytesSent, prev.bytesSent, dt),
    recvKbps: kbps(snap.bytesRecv, prev.bytesRecv, dt),
  };
}

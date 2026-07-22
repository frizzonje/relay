'use client';

import type { TileNet, UplinkStatus } from '@/stores/voice';

/**
 * Арифметика «палочек качества», общая для обоих транспортов.
 *
 * Сами цифры транспорты снимают по-разному — mesh с соединения до собеседника,
 * SFU с соединения до сервера, — но пороги, проценты потерь и битрейт считаются
 * одинаково, и расходиться им незачем: иначе одни и те же четыре палочки
 * означали бы в двух режимах разное.
 */

/** Снимок счётчиков с прошлого тика: потери/приём — для % за интервал, байты — для кбит/с. */
export interface NetSnapshot {
  lost: number;
  recv: number;
  bytesSent: number;
  bytesRecv: number;
  ts: number;
}

/**
 * Класс качества по потерям (главный враг звука) и RTT. Пороги в духе Discord:
 * сперва смотрим на потери — они рвут голос сильнее задержки.
 */
export function gradeQuality(rtt: number | null, lossPct: number): TileNet['grade'] {
  if (lossPct >= 8 || (rtt != null && rtt >= 400)) return 'bad';
  if (lossPct >= 3 || (rtt != null && rtt >= 250)) return 'weak';
  if (lossPct >= 0.8 || (rtt != null && rtt >= 130)) return 'good';
  return 'strong';
}

/** qualityLimitationReason → наш UplinkStatus. 'none'/'other'/пусто = всё ок. */
export function limitReason(r: string | undefined): UplinkStatus {
  if (r === 'bandwidth') return 'bandwidth';
  if (r === 'cpu') return 'cpu';
  return 'ok';
}

/**
 * Байты→кбит/с за интервал ts_prev→ts_now (мс). Отрицательную дельту (сброс
 * счётчика при ренеготиации) гасим в 0.
 */
export function kbps(bytesNow: number, bytesPrev: number, dtMs: number): number | null {
  if (dtMs <= 0) return null;
  return Math.max(0, Math.round(((bytesNow - bytesPrev) * 8) / dtMs)); // *8/1000/(ms/1000)=*8/ms
}

/** Минимальный RTT по успешной candidate-pair в отчёте getStats (мс, null — нет данных). */
export function rttFromStats(stats: RTCStatsReport): number | null {
  let best: number | null = null;
  stats.forEach((report) => {
    const r = report as { type?: string; state?: string; currentRoundTripTime?: number };
    if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
    if (r.currentRoundTripTime == null) return;
    const ms = Math.round(r.currentRoundTripTime * 1000);
    if (best === null || ms < best) best = ms;
  });
  return best;
}

/** Пороги окраски пинга в панели голоса — общие для панели и тултипа. */
export function pingGrade(rttMs: number): 'good' | 'mid' | 'bad' {
  return rttMs < 80 ? 'good' : rttMs < 200 ? 'mid' : 'bad';
}

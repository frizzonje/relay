'use client';

/**
 * Телеметрия трансляции: что реально снимается, кодируется и доходит до
 * зрителя — строкой в серверный лог (`voice-diag`).
 *
 * Плашка показывает человеку одну цифру — верхний идущий слой. А жалоба «у
 * зрителя 620p, что ни выбирай» (2026-10-04) по одной цифре не разбирается:
 * захват снял меньше? кодировщик урезал кадр — и почему, канал или
 * процессор? выключил верхний слой? или до зрителя доехал нижний? Строчка в
 * логе отвечает на всё сразу, по каждому слою, и переживает закрытую вкладку.
 *
 * Пишет не на каждый тик, а когда картина поменялась (кадр, кадры, причина,
 * слой), — и раз в полминуты как пульс: часовая трансляция не должна
 * превращаться в тысячу одинаковых строк.
 */

/** Поля отчёта `getStats`, которые читает телеметрия. */
interface Rec {
  type?: string;
  kind?: string;
  mediaType?: string;
  rid?: string;
  ssrc?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesSent?: number;
  bytesReceived?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  encoderImplementation?: string;
  decoderImplementation?: string;
  active?: boolean;
  state?: string;
  nominated?: boolean;
  availableOutgoingBitrate?: number;
  framesDropped?: number;
  freezeCount?: number;
  codecId?: string;
  mimeType?: string;
}

const isVideo = (r: Rec) => (r.kind ?? r.mediaType) === 'video';

/** Сколько ждать между строками, когда картина меняется, и пульс без перемен. */
const MIN_GAP_MS = 6_000;
const PULSE_MS = 30_000;

export interface TxLayer {
  rid: string;
  /** Чем различать слои между тиками: rid, а где его нет (Safari) — ssrc. */
  key: string;
  width: number;
  height: number;
  fps: number | null;
  bytes: number;
  /** Сколько кодировщик сейчас хочет на этот слой, кбит/с (`targetBitrate`). */
  targetKbps: number | null;
  /** `qualityLimitationReason`: none / bandwidth / cpu / other. */
  limit: string;
  /** Слой идёт: движок выключает верхний, когда канала на него не хватает. */
  sending: boolean;
}

export interface TxSample {
  layers: TxLayer[];
  /** Оценка канала до сервера у отправителя, кбит/с. */
  bweKbps: number | null;
  codec: string | null;
  impl: string | null;
}

function codecOf(report: RTCStatsReport, rec: Rec): string | null {
  const mime = rec.codecId ? (report.get(rec.codecId) as Rec | undefined)?.mimeType : undefined;
  return mime ? (mime.split('/')[1]?.toUpperCase() ?? null) : null;
}

function bweOf(report: RTCStatsReport): number | null {
  let bwe: number | null = null;
  report.forEach((raw) => {
    const r = raw as Rec;
    if (r.type !== 'candidate-pair' || r.state !== 'succeeded') return;
    if (r.availableOutgoingBitrate == null) return;
    // Выбранная пара — та, по которой идёт трафик; её же движок помечает.
    if (bwe == null || r.nominated) bwe = Math.round(r.availableOutgoingBitrate / 1000);
  });
  return bwe;
}

/** Исходящие слои трансляции из отчёта её producer'а (sender'а). */
export function readTx(report: RTCStatsReport): TxSample {
  const layers: TxLayer[] = [];
  let codec: string | null = null;
  let impl: string | null = null;
  report.forEach((raw) => {
    const r = raw as Rec;
    if (r.type !== 'outbound-rtp' || !isVideo(r)) return;
    const height = r.frameHeight ?? 0;
    layers.push({
      rid: r.rid ?? '-',
      key: r.rid ?? `ssrc${r.ssrc ?? layers.length}`,
      width: r.frameWidth ?? 0,
      height,
      fps: r.framesPerSecond != null ? Math.round(r.framesPerSecond) : null,
      bytes: r.bytesSent ?? 0,
      targetKbps: r.targetBitrate != null ? Math.round(r.targetBitrate / 1000) : null,
      limit: r.qualityLimitationReason ?? 'none',
      sending: r.active !== false && height > 0,
    });
    codec ??= codecOf(report, r);
    if (r.encoderImplementation) impl = r.encoderImplementation;
  });
  // Снизу вверх — как слои и задуманы, сколько бы их ни отдал движок. Safari
  // имён слоям не даёт — тогда по высоте кадра.
  layers.sort((a, b) =>
    a.rid !== '-' && b.rid !== '-' ? a.rid.localeCompare(b.rid) : a.height - b.height,
  );
  return { layers, bweKbps: bweOf(report), codec, impl };
}

export interface RxSample {
  width: number;
  height: number;
  fps: number | null;
  bytes: number;
  codec: string | null;
  impl: string | null;
  dropped: number;
  freezes: number;
}

/** Входящее видео трансляции из отчёта consumer'а зрителя. */
function readRx(report: RTCStatsReport): RxSample | null {
  let sample: RxSample | null = null;
  report.forEach((raw) => {
    const r = raw as Rec;
    if (r.type !== 'inbound-rtp' || !isVideo(r)) return;
    sample = {
      width: r.frameWidth ?? 0,
      height: r.frameHeight ?? 0,
      fps: r.framesPerSecond != null ? Math.round(r.framesPerSecond) : null,
      bytes: r.bytesReceived ?? 0,
      codec: codecOf(report, r),
      impl: r.decoderImplementation ?? null,
      dropped: r.framesDropped ?? 0,
      freezes: r.freezeCount ?? 0,
    };
  });
  return sample;
}

/** «6.2M» — мегабиты с десятыми; меньше мегабита — килобитами. */
function mbit(kbps: number | null): string {
  if (kbps == null) return '?';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)}M` : `${kbps}k`;
}

const LIMIT_TAG: Record<string, string> = { none: '', bandwidth: ' net', cpu: ' cpu' };

/** Ключ картины: строка пишется, когда он сменился. Битрейт сюда не входит — он дышит всегда. */
function txKey(s: TxSample): string {
  const layers = s.layers.map(
    (l) => `${l.rid}:${l.sending ? l.height : 0}:${Math.round((l.fps ?? 0) / 5)}:${l.limit}`,
  );
  return `${layers.join(',')}|${s.codec}|${s.impl}`;
}

function formatTx(s: TxSample, rates: Map<string, number | null>): string {
  const layers = s.layers.map((l) =>
    l.sending
      ? `${l.rid} ${l.width}x${l.height}@${l.fps ?? '?'} ${mbit(rates.get(l.key) ?? null)}/${mbit(l.targetKbps)}${LIMIT_TAG[l.limit] ?? ` ${l.limit}`}`
      : `${l.rid} off${LIMIT_TAG[l.limit] ?? ` ${l.limit}`}`,
  );
  return `${layers.join(' | ')} | bwe ${mbit(s.bweKbps)} ${s.codec ?? '?'} ${s.impl ?? ''}`.trim();
}

function formatRx(s: RxSample, kbps: number | null, layer: number | null): string {
  return (
    `${s.width}x${s.height}@${s.fps ?? '?'} ${mbit(kbps)} layer ${layer ?? '?'} ` +
    `${s.codec ?? '?'} ${s.impl ?? ''} dropped ${s.dropped} freezes ${s.freezes}`
  ).replace(/\s+/g, ' ');
}

/** Когда писать: картина сменилась (не чаще раза в `MIN_GAP_MS`) или пора пульсу. */
function due(last: { key: string; at: number } | undefined, key: string, now: number): boolean {
  if (!last) return true;
  if (now - last.at >= PULSE_MS) return true;
  return key !== last.key && now - last.at >= MIN_GAP_MS;
}

export interface ScreenTelemetry {
  /** Тик стримера: отчёт sender'а трансляции (null — трансляции нет). */
  tx(report: RTCStatsReport | null): void;
  /** Тик зрителя: отчёт consumer'а трансляции собеседника и слой, который отдаёт сервер. */
  rx(peerId: string, report: RTCStatsReport | null, layer: number | null): void;
  reset(): void;
}

export function createScreenTelemetry(
  diag: (event: string, detail?: string) => void,
  now: () => number = Date.now,
): ScreenTelemetry {
  let txLast: { key: string; at: number } | undefined;
  const txBytes = new Map<string, { bytes: number; at: number }>();
  const rxLast = new Map<string, { key: string; at: number; bytes: number; bytesAt: number }>();

  return {
    tx(report) {
      if (!report) {
        txLast = undefined;
        txBytes.clear();
        return;
      }
      const sample = readTx(report);
      if (!sample.layers.length) return;
      const t = now();
      const rates = new Map<string, number | null>();
      for (const l of sample.layers) {
        const before = txBytes.get(l.key);
        rates.set(
          l.key,
          before && l.bytes >= before.bytes && t > before.at
            ? Math.round(((l.bytes - before.bytes) * 8) / (t - before.at))
            : null,
        );
        txBytes.set(l.key, { bytes: l.bytes, at: t });
      }
      const key = txKey(sample);
      if (!due(txLast, key, t)) return;
      txLast = { key, at: t };
      diag('screen tx', formatTx(sample, rates));
    },

    rx(peerId, report, layer) {
      const sample = report ? readRx(report) : null;
      if (!sample) {
        rxLast.delete(peerId);
        return;
      }
      // Подписка есть, кадров ещё нет: момент начала и так отмечает `sfu rtp`.
      if (!sample.height) return;
      const t = now();
      const last = rxLast.get(peerId);
      const kbps =
        last && sample.bytes >= last.bytes && t > last.bytesAt
          ? Math.round(((sample.bytes - last.bytes) * 8) / (t - last.bytesAt))
          : null;
      const key = `${sample.height}:${Math.round((sample.fps ?? 0) / 5)}:${layer}`;
      if (!due(last, key, t)) {
        if (last) Object.assign(last, { bytes: sample.bytes, bytesAt: t });
        return;
      }
      rxLast.set(peerId, { key, at: t, bytes: sample.bytes, bytesAt: t });
      diag('screen rx', `${peerId} ${formatRx(sample, kbps, layer)}`);
    },

    reset() {
      txLast = undefined;
      txBytes.clear();
      rxLast.clear();
    },
  };
}

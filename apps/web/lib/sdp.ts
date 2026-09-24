/**
 * Чистые помощники над SDP — выделены из lib/voice.ts, чтобы тестировать без
 * RTCPeerConnection/DOM.
 */

// Быстрый старт без «разгона с 360p»: впихиваем x-google-*-bitrate в fmtp
// строки видеокодеков, чтобы соединение сразу шло на высоком битрейте.
export const SDP_START_BITRATE_KBPS = 4000;
export const SDP_MIN_BITRATE_KBPS = 1200;
export const SDP_MAX_BITRATE_KBPS = 8000;

// ─────────────────────────────────────────────────────────────────────────
// Качество голоса (Opus). Дефолт WebRTC для голоса — ~32 кбит/с без тюнинга, и
// звонок звучит глухо. Поднимаем: высокий средний битрейт, in-band FEC
// (устойчивость к потерям), без DTX (без «проглатывания» тихих участков).
//
// Каналы — по роли линии. Голос — моно: микрофон моно, а стерео заставляло
// кодек кодировать два одинаковых канала (разведка: 100% кадров голоса шли
// стерео). Звук демонстрации — стерео: там музыка и фильмы. Роль линии — её
// место среди аудиолиний: первая — голос, остальные — демонстрация. То же
// правило, по которому микшер (lib/voice/output.ts) отличает голос от показа:
// микрофон добавляется первым, звук экрана — позже, а m-линии не
// переупорядочиваются никогда.
//
// Это ПОТОЛОК кодека в SDP (maxaveragebitrate). Фактический максимум каждого
// потока задаётся отдельно через sender.encodings.maxBitrate (см.
// lib/voice/mesh/senders.ts) — голос держим скромнее и по числу, которое
// выбирает владелец инсталляции (`voice.audioBitrateKbps`), а звук демонстрации
// пускаем под этот потолок ради музыки/фильмов.
// ─────────────────────────────────────────────────────────────────────────
export const OPUS_MAX_BITRATE = 256_000;

// Параметры fmtp Opus, общие для обеих ролей (перетирают встречные значения).
const OPUS_FMTP_COMMON: Record<string, string> = {
  maxaveragebitrate: String(OPUS_MAX_BITRATE),
  maxplaybackrate: '48000',
  useinbandfec: '1',
  usedtx: '0',
  minptime: '10',
};

const VOICE_CHANNELS: Record<string, string> = { stereo: '0', 'sprop-stereo': '0' };
const SCREEN_CHANNELS: Record<string, string> = { stereo: '1', 'sprop-stereo': '1' };

/**
 * Прокачивает Opus в SDP по ролям линий: первая аудиолиния — голос (моно),
 * остальные — звук демонстрации (стерео); битрейт, FEC и DTX — общие. Кодеку
 * без строки a=fmtp дописывает её сразу после a=rtpmap. Не-Opus строки (RED,
 * видео) не трогает. Идемпотентна. undefined → undefined.
 */
export function boostAudioBitrate(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  const out: string[] = [];
  let section: string[] = [];
  let audioSeen = 0;
  const flush = () => {
    if (section[0]?.startsWith('m=audio')) {
      const channels = audioSeen === 0 ? VOICE_CHANNELS : SCREEN_CHANNELS;
      out.push(...tuneOpus(section, { ...OPUS_FMTP_COMMON, ...channels }));
      audioSeen++;
    } else {
      out.push(...section);
    }
    section = [];
  };
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) flush();
    section.push(line);
  }
  flush();
  return out.join('\r\n');
}

/** Opus одной m-линии: fmtp обновить на месте, недостающий — дописать. */
function tuneOpus(lines: string[], params: Record<string, string>): string[] {
  // Payload-типы opus и индекс их rtpmap-строки (чтобы вставить fmtp при нужде)
  const opusPts = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = l.match(/^a=rtpmap:(\d+) opus\/\d+/i);
    if (m) opusPts.set(m[1], i);
  });
  if (!opusPts.size) return lines;

  const seen = new Set<string>();
  const out = lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m || !opusPts.has(m[1])) return l;
    seen.add(m[1]);
    return `a=fmtp:${m[1]} ${mergeFmtp(m[2], params)}`;
  });

  // Кодекам без fmtp дописываем строку сразу после rtpmap (с конца, чтобы
  // индексы не съезжали)
  const missing = [...opusPts.entries()].filter(([pt]) => !seen.has(pt));
  missing.sort((a, b) => b[1] - a[1]);
  const fresh = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  for (const [pt, idx] of missing) out.splice(idx + 1, 0, `a=fmtp:${pt} ${fresh}`);
  return out;
}

// Сливает существующие параметры fmtp с нашими (наши перетирают встречные).
function mergeFmtp(existing: string, ours: Record<string, string>): string {
  const params = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k.trim()) params.set(k.trim(), rest.join('='));
  }
  for (const [k, v] of Object.entries(ours)) params.set(k, v);
  return [...params.entries()].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}

/**
 * Дописывает x-google-start/min/max-bitrate в fmtp видеокодеков (VP8/VP9/H264/
 * H265/AV1). Аудио и уже размеченные строки не трогаются. undefined → undefined.
 */
export function boostVideoBitrate(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  const lines = sdp.split('\r\n');
  const videoPts = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|H265|AV1)\b/i);
    if (m) videoPts.add(m[1]);
  }
  if (!videoPts.size) return sdp;
  const extra =
    ';x-google-start-bitrate=' +
    SDP_START_BITRATE_KBPS +
    ';x-google-min-bitrate=' +
    SDP_MIN_BITRATE_KBPS +
    ';x-google-max-bitrate=' +
    SDP_MAX_BITRATE_KBPS;
  return lines
    .map((l) => {
      const m = l.match(/^a=fmtp:(\d+) /);
      if (m && videoPts.has(m[1]) && !l.includes('x-google-start-bitrate')) {
        return l + extra;
      }
      return l;
    })
    .join('\r\n');
}

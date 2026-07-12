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
// Качество голоса (Opus). Дефолт WebRTC для голоса — ~32 кбит/с моно без тюнинга,
// и звонок звучит глухо. Поднимаем до «discord-уровня»: стерео, высокий средний
// битрейт, in-band FEC (устойчивость к потерям) и без DTX (без «проглатывания»
// тихих участков). Касается и микрофона, и звука демонстрации экрана.
//
// Это ПОТОЛОК кодека в SDP (maxaveragebitrate). Фактический максимум каждого
// потока задаётся отдельно через sender.encodings.maxBitrate (см. voice.ts:
// MIC_AUDIO_MAX_BITRATE / SCREEN_AUDIO_MAX_BITRATE) — голос держим скромнее,
// звук демонстрации пускаем под этот потолок ради музыки/фильмов.
// ─────────────────────────────────────────────────────────────────────────
export const OPUS_MAX_BITRATE = 256_000;

// Параметры fmtp Opus, которые мы навязываем (перетирая встречные значения).
const OPUS_FMTP_PARAMS: Record<string, string> = {
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: String(OPUS_MAX_BITRATE),
  maxplaybackrate: '48000',
  useinbandfec: '1',
  usedtx: '0',
  minptime: '10',
};

/**
 * Прокачивает качество Opus в SDP: для каждого opus-кодека выставляет stereo,
 * высокий maxaveragebitrate, FEC и т.д. Если у кодека ещё нет строки a=fmtp —
 * добавляет её сразу после a=rtpmap. Не-аудио строки не трогаются. Идемпотентна.
 * undefined → undefined.
 */
export function boostAudioBitrate(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  const lines = sdp.split('\r\n');

  // Payload-типы opus и индекс их rtpmap-строки (чтобы вставить fmtp при нужде)
  const opusPts = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = l.match(/^a=rtpmap:(\d+) opus\/\d+/i);
    if (m) opusPts.set(m[1], i);
  });
  if (!opusPts.size) return sdp;

  // Существующие fmtp opus-кодеков обновляем на месте
  const seen = new Set<string>();
  const out = lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m || !opusPts.has(m[1])) return l;
    seen.add(m[1]);
    return `a=fmtp:${m[1]} ${mergeFmtp(m[2])}`;
  });

  // Кодекам без fmtp дописываем строку сразу после rtpmap (с конца, чтобы
  // индексы не съезжали)
  const missing = [...opusPts.entries()].filter(([pt]) => !seen.has(pt));
  missing.sort((a, b) => b[1] - a[1]);
  const params = Object.entries(OPUS_FMTP_PARAMS)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  for (const [pt, idx] of missing) out.splice(idx + 1, 0, `a=fmtp:${pt} ${params}`);

  return out.join('\r\n');
}

// Сливает существующие параметры fmtp с нашими (наши перетирают встречные).
function mergeFmtp(existing: string): string {
  const params = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [k, ...rest] = part.split('=');
    if (k.trim()) params.set(k.trim(), rest.join('='));
  }
  for (const [k, v] of Object.entries(OPUS_FMTP_PARAMS)) params.set(k, v);
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

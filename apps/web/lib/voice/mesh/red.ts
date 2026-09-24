'use client';

import { cmpMid } from '@/lib/voice/mid';

/**
 * RED (RFC 2198) для голоса в прямых звонках: каждый пакет несёт новый кадр
 * Opus и копию прошлого. Потерянный пакет восстанавливается из следующего —
 * голос перестаёт «булькать» на плохом Wi-Fi и мобильной сети.
 *
 * Кодек отправки каждая сторона берёт первым из списка СОБЕСЕДНИКА. Поэтому
 * ставим RED первым в своём списке — тогда RED шлют нам. Chrome и WebKit RED
 * объявляют и сами, но вторым, после Opus, и договариваются на Opus.
 *
 * Только голос: звук демонстрации (музыка до 256 кбит/с) с копией стоил бы
 * вдвое больше на каждого собеседника. RED идёт поверх потолка Opus, а не
 * делит его: `maxBitrate` ограничивает Opus, копия добавляется сверху
 * (разведка: 259 кбит/с при потолке 128).
 *
 * Всё необязательно: нет RED у браузера (Firefox), нет setCodecPreferences,
 * браузер отказал — переговоры идут как без этого модуля, на Opus.
 */

type Codec = NonNullable<ReturnType<typeof RTCRtpReceiver.getCapabilities>>['codecs'][number];

const isRed = (c: Codec) => c.mimeType.toLowerCase() === 'audio/red';

/** RED первым, остальные в прежнем порядке; null — RED у браузера нет. */
export function redFirst(codecs: Codec[]): Codec[] | null {
  const red = codecs.filter(isRed);
  return red.length ? [...red, ...codecs.filter((c) => !isRed(c))] : null;
}

/**
 * Голосовой трансивер — аудио с наименьшим mid (см. lib/voice/mid.ts). До
 * первых переговоров mid нет ни у кого — тогда первый аудио: микрофон
 * добавляется в createPeer раньше всего остального.
 */
function voiceTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
  const audio = pc
    .getTransceivers()
    .filter(
      (t) =>
        t.direction !== 'stopped' &&
        t.currentDirection !== 'stopped' &&
        t.receiver.track.kind === 'audio',
    );
  const withMid = audio.filter((t) => t.mid !== null);
  if (withMid.length) return withMid.sort((a, b) => cmpMid(a.mid!, b.mid!))[0];
  return audio[0] ?? null;
}

/** Поставить RED первым голосу. Звать перед каждым createOffer и createAnswer. */
export function preferRedForVoice(pc: RTCPeerConnection): void {
  const voice = voiceTransceiver(pc);
  if (!voice || typeof voice.setCodecPreferences !== 'function') return;
  if (
    typeof RTCRtpReceiver === 'undefined' ||
    typeof RTCRtpReceiver.getCapabilities !== 'function'
  ) {
    return;
  }
  const codecs = RTCRtpReceiver.getCapabilities('audio')?.codecs;
  const ordered = codecs ? redFirst(codecs) : null;
  if (!ordered) return;
  try {
    voice.setCodecPreferences(ordered);
  } catch (err) {
    console.warn('RED preference rejected:', err);
  }
}

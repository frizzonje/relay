'use client';

import type { Device, RtpCodecCapability } from 'mediasoup-client/types';
import type { ScreenProfile } from '../screen-profile';

/**
 * Чем кодировать трансляцию экрана.
 *
 * Умолчание mediasoup-client — первый кодек роутера, VP8, — почти везде
 * программный. На 1440p это заметная доля процессора, а у человека, который
 * показывает игру, процессор занят игрой: движок упирается в
 * `qualityLimitationReason: cpu` и сам режет кадр и кадры. Отсюда «лагает».
 * Видеокарта кодирует почти даром — если ей дать кодек, который она умеет.
 *
 * Кандидат один — H264: simulcast на медиасервере умеют только VP8 и H264 (см.
 * `IsValidTypeForCodec` в mediasoup), а без двух слоёв не будет ни плитки за
 * копейки, ни 1440p для развернувших. VP9 и AV1 там живут как SVC — отдельная
 * разведка (docs/plans/screen-share.md).
 *
 * Аппаратный ли кодировщик — говорит `mediaCapabilities.encodingInfo`
 * (`powerEfficient`). WebKit на этот вопрос для `webrtc` не отвечает, но H264
 * у него всегда VideoToolbox, а VP8 — программный libvpx: там H264 берём и без
 * ответа.
 */

const CANDIDATE = 'video/h264';

function isWebKit(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
}

/**
 * Кодек для трансляции или `undefined` — тогда mediasoup-client берёт свой
 * первый (VP8), как и раньше.
 */
export async function pickScreenCodec(
  device: Device,
  profile: ScreenProfile,
): Promise<RtpCodecCapability | undefined> {
  const codec = device.rtpCapabilities.codecs?.find(
    (c) => c.kind === 'video' && c.mimeType.toLowerCase() === CANDIDATE,
  );
  if (!codec) return undefined;
  const caps = typeof navigator === 'undefined' ? undefined : navigator.mediaCapabilities;
  try {
    const info = await caps?.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: codec.mimeType,
        width: Math.round((profile.height * 16) / 9),
        height: profile.height,
        bitrate: profile.bitrate,
        framerate: profile.fps,
      },
    });
    if (info) return info.supported && info.powerEfficient ? codec : undefined;
  } catch {
    /* `webrtc` движок не знает — решаем по движку ниже */
  }
  return isWebKit() ? codec : undefined;
}

/** H264 — кодек без временных слоёв в нашем simulcast: просить их у него нельзя. */
export function isH264(codec: RtpCodecCapability | undefined): boolean {
  return codec?.mimeType.toLowerCase() === CANDIDATE;
}

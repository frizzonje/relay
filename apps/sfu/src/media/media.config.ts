import type { types } from 'mediasoup';

/**
 * Медиа-настройки роутера и транспортов. Всё, что зависит от env, читается
 * функциями (а не константами), чтобы тест мог подменить окружение.
 */

/**
 * Кодеки роутера. Роутер не транскодит: этот список — пересечение, по которому
 * договариваются участники, поэтому держим и VP8 (основной, умеет simulcast
 * везде), и H264 (Safari и часть железных энкодеров), и VP9 как запас.
 */
export const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      // Стерео нужно демонстрации экрана (звук игры/видео), голос всё равно моно.
      'sprop-stereo': 1,
      useinbandfec: 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      // Constrained Baseline 3.1 — единственный H264-профиль, который в WebRTC
      // предлагают ВСЕ (Chrome, Firefox, Safari/WKWebView, WebView2). Прежний
      // Main 5.0 (`4d0032`) браузеры для WebRTC не отдают, поэтому H264 с ним не
      // матчился ни с кем: WebKit (десктоп-оболочка на macOS) шлёт видео почти
      // только H264 — с несовместимым профилем `canProduce('video')` у него
      // становился false, и видео молча не уходило, а звук (Opus) шёл. Ровно
      // «собеседник слышит, но не видит». Держим и `level-asymmetry-allowed`,
      // чтобы стороны могли объявлять разные уровни.
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

function num(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function workerSettings(): types.WorkerSettings {
  return {
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    // Диапазон должен быть открыт на фаерволе (UDP+TCP) и проброшен в compose.
    rtcMinPort: num(process.env.SFU_RTC_MIN_PORT, 40000),
    rtcMaxPort: num(process.env.SFU_RTC_MAX_PORT, 40100),
  };
}

/**
 * Адрес, который сервер называет в ICE-кандидатах. В докере/на облачной VM за
 * 1:1 NAT слушаем 0.0.0.0, а анонсировать обязаны публичный IP — иначе клиент
 * получит адрес контейнера и медиа не пойдёт. Те же грабли, что у coturn с
 * --external-ip, поэтому и переменная переиспользуется.
 */
export function announcedIp(): string | undefined {
  const explicit = (process.env.SFU_ANNOUNCED_IP ?? process.env.TURN_EXTERNAL_IP ?? '').trim();
  if (explicit) return explicit;
  const host = (process.env.SERVER_HOST ?? '').trim();
  // Имя хоста в announcedIp не годится — сюда идёт только IP-литерал.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : undefined;
}

export function webRtcTransportOptions(): types.WebRtcTransportOptions {
  return {
    listenInfos: [
      { protocol: 'udp', ip: '0.0.0.0', announcedAddress: announcedIp() },
      { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: announcedIp() },
    ],
    enableUdp: true,
    // ICE-TCP — единственный путь наружу из сетей, где UDP режут. Своим TURN
    // mediasoup ходить не умеет, так что это его единственная страховка.
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  };
}

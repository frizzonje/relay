import { tx } from '@/lib/i18n';

/**
 * Умеет ли движок вообще звонить — проверка ДО входа в голосовой канал.
 *
 * Появилось из-за Linux: системный WebKitGTK (Arch, Debian/Ubuntu — все, кто
 * берёт пакет из репозитория) собран БЕЗ WebRTC, потому что upstream держит
 * `-DENABLE_WEB_RTC=OFF` по умолчанию и не включает его в тарболы. В таком
 * движке `navigator.mediaDevices.getUserMedia` на месте (микрофон спросится и
 * выдастся), а `RTCPeerConnection` попросту НЕТ. Из-за этого нативный клиент
 * вёл себя худшим образом: заходил в канал, показывал плитки, зажигал микрофон
 * — и молчал, потому что `new RTCPeerConnection` падал ReferenceError'ом внутри
 * socket-колбэка, где его никто не ловил. Пользователь видел «нет голоса» без
 * единого сообщения об ошибке.
 *
 * Поэтому проверяем возможности заранее и говорим прямо, что не так.
 */

export type VoiceSupport =
  | { ok: true }
  | { ok: false; reason: 'insecure' | 'no-webrtc'; message: string };

/** Есть ли в движке рабочий RTCPeerConnection (а не только имя в window). */
function hasPeerConnection(): boolean {
  const PC =
    typeof RTCPeerConnection === 'function'
      ? RTCPeerConnection
      : (globalThis as { webkitRTCPeerConnection?: typeof RTCPeerConnection })
          .webkitRTCPeerConnection;
  // Мало наличия конструктора: в урезанных сборках класс бывает объявлен, но без
  // методов согласования — тогда звонок развалится уже после входа в канал.
  return typeof PC === 'function' && typeof PC.prototype?.createOffer === 'function';
}

/**
 * Диагноз для сборки WebKitGTK без WebRTC. Отличаем нативную оболочку relay от
 * обычного браузера: в оболочке чинить нечего — там системный движок, и совет
 * «обновите браузер» бесполезен, нужен другой клиент.
 */
function noWebrtcMessage(): string {
  const isDesktopShell =
    typeof window !== 'undefined' && Boolean((window as { __TAURI__?: unknown }).__TAURI__);
  const isLinux = typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent ?? '');

  if (isDesktopShell && isLinux) {
    return (
      tx('support.webkitgtk.noWebrtc')
    );
  }
  if (isLinux) {
    return (
      tx('support.noWebrtc.gnome')
    );
  }
  return tx('support.noWebrtc');
}

/**
 * Можно ли выходить на связь. Зовётся из joinVoice ДО запроса микрофона, чтобы
 * не выпрашивать доступ к устройству ради заведомо немого звонка.
 */
export function voiceSupport(): VoiceSupport {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: 'insecure',
      message: tx('support.insecure'),
    };
  }
  if (!hasPeerConnection()) {
    return { ok: false, reason: 'no-webrtc', message: noWebrtcMessage() };
  }
  return { ok: true };
}

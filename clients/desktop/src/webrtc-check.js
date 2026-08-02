// Проверка поддержки WebRTC движком — независимый модуль, загружается после
// main.js. В десктоп-клиенте Tauri Rust обеспечивает WebRTC-стек (настройки
// WebKitGTK enable-webrtc + нативный захват микрофона через cpal/PulseAudio),
// поэтому проверка пропускается. В обычном браузере ищет RTCPeerConnection с
// рабочим createOffer — нет → баннер «звонков не будет».

(function () {
  if (typeof window === 'undefined') return;

  var box = document.getElementById('no-webrtc');
  if (!box) return;

  // ── Десктоп-клиент Tauri ────────────────────────────────────────────────
  // Rust включает enable-webrtc/media-stream в WebKitGTK, обрабатывает
  // permission-request и подменяет getUserMedia нативной реализацией.
  // WebRTC в такой сборке полностью рабочий — баннер не нужен.
  if (window.__TAURI__) return;

  // ── Обычный браузер ────────────────────────────────────────────────────
  var PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (typeof PC === 'function' && typeof PC.prototype && typeof PC.prototype.createOffer === 'function') {
    return;
  }

  // Движок без WebRTC (системный WebKitGTK с -DENABLE_WEB_RTC=OFF).
  box.hidden = false;
  box.replaceChildren(
    (function () { var b = document.createElement('b'); b.textContent = 'Calls will not work in this build'; return b; })(),
    (function () { var s = document.createElement('span'); s.textContent = 'The system WebKitGTK engine is built without WebRTC support \u2014 that is a limit of the engine, not of relay. Chat and everything else work. For voice, open relay in Chromium, Firefox or Chrome.'; return s; })()
  );
})();

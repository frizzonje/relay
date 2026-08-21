import { describe, it, expect, afterEach } from 'vitest';
import { voiceSupport } from './voice-support';

/**
 * Регрессия на «Linux: запускается, но голоса нет».
 *
 * Системный WebKitGTK (Arch, Debian/Ubuntu) собран без WebRTC: getUserMedia на
 * месте, RTCPeerConnection отсутствует. Раньше joinVoice проверял только
 * getUserMedia, проходил дальше, брал микрофон — и падал ReferenceError'ом уже
 * внутри socket-колбэка, где ошибку никто не ловил. Клиент выглядел живым и
 * молчал. Проверяем, что такой движок отсеивается ДО запроса микрофона.
 */

const g = globalThis as Record<string, unknown>;
const saved = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  RTCPeerConnection: g.RTCPeerConnection,
  webkitRTCPeerConnection: g.webkitRTCPeerConnection,
  window: g.window,
};

function setEngine(opts: {
  getUserMedia?: boolean;
  peerConnection?: 'full' | 'nameOnly' | 'none';
  ua?: string;
  tauri?: boolean;
}) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15',
      mediaDevices: opts.getUserMedia === false ? undefined : { getUserMedia: () => {} },
    },
    configurable: true,
    writable: true,
  });
  g.window = opts.tauri ? { __TAURI__: { event: {} } } : {};

  delete g.RTCPeerConnection;
  delete g.webkitRTCPeerConnection;
  if (opts.peerConnection === 'full') {
    g.RTCPeerConnection = class {
      createOffer() {}
    };
  } else if (opts.peerConnection === 'nameOnly') {
    // Класс объявлен, но без согласования — звонок развалился бы после входа.
    g.RTCPeerConnection = class {};
  }
}

afterEach(() => {
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  g.RTCPeerConnection = saved.RTCPeerConnection;
  g.webkitRTCPeerConnection = saved.webkitRTCPeerConnection;
  g.window = saved.window;
});

describe('voiceSupport', () => {
  it('нормальный браузер — связь разрешена', () => {
    setEngine({ peerConnection: 'full' });
    expect(voiceSupport()).toEqual({ ok: true });
  });

  it('WebKitGTK без WebRTC: getUserMedia есть, RTCPeerConnection нет — отказ', () => {
    setEngine({ peerConnection: 'none' });
    const res = voiceSupport();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('no-webrtc');
  });

  it('класс без createOffer считается нерабочим (урезанная сборка)', () => {
    setEngine({ peerConnection: 'nameOnly' });
    expect(voiceSupport().ok).toBe(false);
  });

  it('в нативной оболочке на Linux советуем браузер, а не «обновите браузер»', () => {
    setEngine({ peerConnection: 'none', tauri: true });
    const res = voiceSupport();
    expect(res.ok === false && res.message).toMatch(/WebKitGTK/);
    expect(res.ok === false && res.message).toMatch(/Chromium/);
  });

  it('нет getUserMedia — это про HTTPS, а не про WebRTC', () => {
    setEngine({ getUserMedia: false, peerConnection: 'full' });
    const res = voiceSupport();
    expect(res.ok === false && res.reason).toBe('insecure');
  });
});

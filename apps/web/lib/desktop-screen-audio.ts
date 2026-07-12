// Мост «нативный звук демонстрации → MediaStreamTrack» для оболочки Tauri.
//
// В десктоп-оболочке на Windows звук экрана снимается НАТИВНО (WASAPI
// process-loopback с исключением процесса relay — clients/desktop/src-tauri/
// src/screen_audio.rs), поэтому в него не попадают голоса собеседников,
// которые проигрывает сам relay. Это лечит «кенты слышат сами себя»: можно, не
// думая, шарить весь экран со звуком — relay в захвате будет молчать.
//
// Rust ↔ web общаются только событиями Tauri (права remote-UI — core:event):
//   • web → Rust: `screen-audio-start` / `screen-audio-stop`;
//   • Rust → web: `screen-audio-format` ({ sampleRate }) один раз при старте,
//     затем `screen-audio-frame` (base64 от i16 LE, моно) ~50 раз/с (кадры 20 мс).
//
// PCM попадает в AudioWorklet (public/screen-audio-worklet.js), а тот играет его
// в MediaStreamAudioDestinationNode — его дорожку и отдаём в WebRTC-микс.

type TauriEvent<T> = { payload: T };
type UnlistenFn = () => void;
interface TauriGlobal {
  event: {
    listen: <T>(event: string, handler: (e: TauriEvent<T>) => void) => Promise<UnlistenFn>;
    emit: (event: string, payload?: unknown) => Promise<void>;
  };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/** Оболочка Tauri именно на Windows: только там есть нативный process-loopback. */
export function isDesktopWindows(): boolean {
  if (!tauri()) return false;
  const ua =
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.userAgent ||
    '';
  return /win/i.test(ua);
}

// Живой сеанс захвата — чтобы корректно всё разобрать в stopNativeScreenAudio.
let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let dest: MediaStreamAudioDestinationNode | null = null;
let unlisten: UnlistenFn[] = [];
let startTimer: ReturnType<typeof setTimeout> | null = null;

/** base64(i16 LE) → Float32Array в диапазоне [-1, 1]. */
function decodeFrame(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = bin.length;
  const out = new Float32Array(bytes >> 1);
  for (let i = 0, j = 0; i + 1 < bytes; i += 2, j++) {
    // little-endian int16
    const lo = bin.charCodeAt(i);
    const hi = bin.charCodeAt(i + 1);
    let s = (hi << 8) | lo;
    if (s >= 0x8000) s -= 0x10000;
    out[j] = s / 32768;
  }
  return out;
}

/**
 * Запустить нативный захват звука экрана и вернуть его дорожку. Возвращает null,
 * если это не Tauri/Windows, либо Rust не прислал формат за отведённое время
 * (тогда демонстрация идёт без звука — это лучше, чем эхо-петля). Идемпотентно:
 * повторный вызов сперва глушит предыдущий сеанс.
 */
export async function startNativeScreenAudio(): Promise<MediaStreamTrack | null> {
  const t = tauri();
  if (!t) return null;
  await stopNativeScreenAudio(); // не копим два сеанса

  return new Promise<MediaStreamTrack | null>((resolve) => {
    let settled = false;
    const finish = (track: MediaStreamTrack | null) => {
      if (settled) return;
      settled = true;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      resolve(track);
    };

    // Формат приходит один раз — по нему строим граф под точную частоту дискретизации.
    const onFormat = async (e: TauriEvent<{ sampleRate: number }>) => {
      if (ctx) return; // граф уже собран
      const sampleRate = e.payload?.sampleRate || 48000;
      try {
        ctx = new AudioContext({ sampleRate });
        await ctx.audioWorklet.addModule('/screen-audio-worklet.js');
        node = new AudioWorkletNode(ctx, 'screen-audio-processor');
        dest = ctx.createMediaStreamDestination();
        node.connect(dest);
        if (ctx.state === 'suspended') await ctx.resume();
        finish(dest.stream.getAudioTracks()[0] ?? null);
      } catch (err) {
        console.warn('native screen-audio graph failed:', err);
        void stopNativeScreenAudio();
        finish(null);
      }
    };

    const onFrame = (e: TauriEvent<string>) => {
      if (!node || typeof e.payload !== 'string') return;
      const pcm = decodeFrame(e.payload);
      // Транзитом отдаём буфер воркеру (transferable — без копии).
      node.port.postMessage(pcm, [pcm.buffer]);
    };

    void t.event.listen<{ sampleRate: number }>('screen-audio-format', onFormat).then((u) =>
      unlisten.push(u),
    );
    void t.event.listen<string>('screen-audio-frame', onFrame).then((u) => unlisten.push(u));

    // Просим Rust начать захват.
    void t.event.emit('screen-audio-start');

    // Нет формата за 4 с — считаем, что нативный путь недоступен, идём без звука.
    startTimer = setTimeout(() => {
      if (!ctx) {
        console.warn('native screen-audio: no format within timeout');
        void stopNativeScreenAudio();
      }
      finish(dest?.stream.getAudioTracks()[0] ?? null);
    }, 4000);
  });
}

/** Остановить нативный захват и разобрать граф. Безопасно звать повторно. */
export async function stopNativeScreenAudio(): Promise<void> {
  const t = tauri();
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  for (const u of unlisten) {
    try {
      u();
    } catch {
      /* игнор */
    }
  }
  unlisten = [];
  if (t) void t.event.emit('screen-audio-stop');
  try {
    node?.disconnect();
    dest?.disconnect();
    if (ctx && ctx.state !== 'closed') await ctx.close();
  } catch {
    /* игнор */
  }
  node = null;
  dest = null;
  ctx = null;
}

// Мост «нативный звук демонстрации → MediaStreamTrack» для оболочки на Windows.
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

// Мост — общий (lib/shell-bridge.ts). Linux-оболочка этих событий не знает
// вовсе, и не должна: там нативного звука экрана нет (портал Wayland отдаёт
// только видео, а loopback-захват Chromium умеет на Windows и macOS). Путь
// гейтится проверкой «Windows + оболочка» ниже, так что до эмита дело не дойдёт.

import { shellBridge } from '@/lib/shell-bridge';

/** Форма события оболочки: payload и больше ничего. */
type ShellEvent<T> = { payload: T };
/** Что возвращает `listen`: функция, снимающая подписку. */
type UnlistenFn = () => void;

/**
 * Сообщить оболочке, что открылся (`true`) или закрылся (`false`) нативный
 * выбор источника демонстрации. Вне Tauri — no-op.
 *
 * Пикер рисует движок, а не мы: на Windows это модальное окно WebView2 поверх
 * нашего. Оболочке эта пара событий нужна, чтобы (1) в логе было видно, дожил
 * ли клиент до закрытия пикера — есть жалоба на зависание ровно на «Отмене», и
 * (2) после закрытия разбудить цикл событий окна и вернуть ему фокус. Подробнее
 * — в обработчике `screen-picker` (clients/desktop/src-tauri/src/main.rs).
 */
export function notifyScreenPicker(open: boolean): void {
  const t = shellBridge();
  if (!t) return;
  void t.emit('screen-picker', open).catch(() => {
    /* оболочка старая или прав нет — на демонстрацию это не влияет */
  });
}

/** Оболочка Tauri именно на Windows: только там есть нативный process-loopback. */
export function isDesktopWindows(): boolean {
  if (!shellBridge()) return false;
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

/**
 * Номер сеанса. Остановка асинхронна (`AudioContext.close`), и следующий старт
 * начинается, пока она идёт, — а граф собирается тоже через `await`. Всё, что
 * доезжает после смены сеанса (граф, подписка на события), в текущий не
 * ложится, а разбирается на месте: иначе запоздавшая остановка стёрла бы
 * свежий граф, а запоздавшая сборка — легла бы поверх остановленного.
 */
let session = 0;

/** Отпустить ещё не ответивший старт: его остановили, звука не будет. */
let abandonStart: (() => void) | null = null;

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
  const t = shellBridge();
  if (!t) return null;
  await stopNativeScreenAudio(); // не копим два сеанса
  const mine = session;

  return new Promise<MediaStreamTrack | null>((resolve) => {
    let settled = false;
    let building = false;
    const finish = (track: MediaStreamTrack | null) => {
      if (settled) return;
      settled = true;
      if (abandonStart === abandon) abandonStart = null;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      resolve(track);
    };
    const abandon = () => finish(null);
    abandonStart = abandon;

    // Формат приходит один раз — по нему строим граф под точную частоту
    // дискретизации. Строим в свои переменные и отдаём модулю, только если
    // сеанс всё ещё наш: пока шла сборка, его могли остановить.
    const onFormat = async (e: ShellEvent<{ sampleRate: number }>) => {
      if (building || mine !== session) return; // граф уже собирается
      building = true;
      const sampleRate = e.payload?.sampleRate || 48000;
      let built: AudioContext | null = null;
      try {
        built = new AudioContext({ sampleRate });
        await built.audioWorklet.addModule('/screen-audio-worklet.js');
        const worklet = new AudioWorkletNode(built, 'screen-audio-processor');
        const out = built.createMediaStreamDestination();
        worklet.connect(out);
        if (built.state === 'suspended') await built.resume();
        if (mine !== session) {
          void built.close().catch(() => {});
          finish(null);
          return;
        }
        ctx = built;
        node = worklet;
        dest = out;
        finish(out.stream.getAudioTracks()[0] ?? null);
      } catch (err) {
        console.warn('native screen-audio graph failed:', err);
        if (built) void built.close().catch(() => {});
        if (mine === session) void stopNativeScreenAudio();
        finish(null);
      }
    };

    const onFrame = (e: ShellEvent<string>) => {
      if (!node || typeof e.payload !== 'string') return;
      const pcm = decodeFrame(e.payload);
      // Транзитом отдаём буфер воркеру (transferable — без копии).
      node.port.postMessage(pcm, [pcm.buffer]);
    };

    // Подписка доезжает асинхронно: остановленному сеансу она уже не нужна.
    const keep = (u: UnlistenFn) => {
      if (mine === session) unlisten.push(u);
      else u();
    };
    void t
      .listen<{ sampleRate: number }>('screen-audio-format', (e) => void onFormat(e))
      .then(keep);
    void t.listen<string>('screen-audio-frame', onFrame).then(keep);

    // Просим Rust начать захват.
    void t.emit('screen-audio-start');

    // Нет формата за 4 с — считаем, что нативный путь недоступен, идём без звука.
    startTimer = setTimeout(() => {
      if (!ctx && mine === session) {
        console.warn('native screen-audio: no format within timeout');
        void stopNativeScreenAudio();
      }
      finish(dest?.stream.getAudioTracks()[0] ?? null);
    }, 4000);
  });
}

/** Остановить нативный захват и разобрать граф. Безопасно звать повторно. */
export async function stopNativeScreenAudio(): Promise<void> {
  const t = shellBridge();
  session += 1;
  abandonStart?.();
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
  if (t) void t.emit('screen-audio-stop');
  // Ссылки снимаем ДО ожидания закрытия: за это время начинается следующий
  // сеанс, и обнулять потом значило бы стереть уже его граф.
  const [oldCtx, oldNode, oldDest] = [ctx, node, dest];
  ctx = null;
  node = null;
  dest = null;
  try {
    oldNode?.disconnect();
    oldDest?.disconnect();
    if (oldCtx && oldCtx.state !== 'closed') await oldCtx.close();
  } catch {
    /* игнор */
  }
}

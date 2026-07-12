'use client';

/**
 * Звуковой API эфира (join/leave/peer/error/reconnect/connLost). Тонкий пул
 * поверх HTMLAudioElement: короткие MP3 из public/sfx (оригинальные, CC0 —
 * см. tools/gen-sfx.py). На сервере (SSR) — безопасный no-op.
 */

export type SfxName =
  | 'join'
  | 'leave'
  | 'peerJoin'
  | 'peerLeave'
  | 'error'
  | 'connLost'
  | 'reconnect';

export interface SfxHandle {
  onended: (() => void) | null;
}

interface SfxApi {
  play: (name: SfxName) => SfxHandle | null;
  stop: (name: SfxName) => void;
  fadeOut: (name: SfxName, seconds?: number) => void;
  isMuted: () => boolean;
  toggle: () => boolean;
  setMuted: (v: boolean) => void;
  /** Глобальное отключение ВСЕХ звуков (напр. когда выключены динамики). */
  setAllMuted: (v: boolean) => void;
  /** Переключает вывод sfx на другое устройство (Audio Output Devices API). */
  setSinkId: (deviceId: string) => void;
}

const FILES: Record<SfxName, string> = {
  join: '/sfx/join.mp3',
  leave: '/sfx/leave.mp3',
  peerJoin: '/sfx/peer-join.mp3',
  peerLeave: '/sfx/peer-leave.mp3',
  error: '/sfx/error.mp3',
  connLost: '/sfx/conn-lost.mp3',
  reconnect: '/sfx/reconnect.mp3',
};

/** Общая громкость sfx (звуки эфира должны быть ненавязчивыми). */
const MASTER_VOLUME = 0.7;

/** Элемент с расширением Audio Output Devices API (не во всех lib.dom). */
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

function createNoop(): SfxApi {
  let muted = false;
  return {
    play: () => null,
    stop: () => {},
    fadeOut: () => {},
    isMuted: () => muted,
    toggle: () => {
      muted = !muted;
      return muted;
    },
    setMuted: (v) => {
      muted = v;
    },
    setAllMuted: () => {},
    setSinkId: () => {},
  };
}

function createBrowser(): SfxApi {
  let muted = false; // ручной мут sfx
  let allMuted = false; // общий мут (динамики выключены)
  let sinkId = '';
  // Проигрываемые сейчас элементы по имени — для stop/fadeOut.
  const active = new Map<SfxName, Set<HTMLAudioElement>>();

  // Прогреваем кэш: браузер подтянет файлы заранее, первый play без задержки.
  for (const src of Object.values(FILES)) {
    const warm = new Audio();
    warm.preload = 'auto';
    warm.src = src;
  }

  const applySink = (el: SinkAudio) => {
    if (sinkId && typeof el.setSinkId === 'function') el.setSinkId(sinkId).catch(() => {});
  };

  const forget = (name: SfxName, el: HTMLAudioElement) => {
    active.get(name)?.delete(el);
  };

  return {
    play(name) {
      if (muted || allMuted) return null;
      const el: SinkAudio = new Audio(FILES[name]);
      el.volume = MASTER_VOLUME;
      applySink(el);

      const handle: SfxHandle = { onended: null };
      const done = () => {
        forget(name, el);
        handle.onended?.();
      };
      el.addEventListener('ended', done, { once: true });

      let set = active.get(name);
      if (!set) active.set(name, (set = new Set()));
      set.add(el);

      // Политика автоплея / файл ещё не готов — не роняем звонок из-за звука.
      el.play().catch(() => forget(name, el));
      return handle;
    },

    stop(name) {
      const set = active.get(name);
      if (!set) return;
      for (const el of set) {
        el.pause();
        el.currentTime = 0;
      }
      set.clear();
    },

    fadeOut(name, seconds = 0.3) {
      const set = active.get(name);
      if (!set) return;
      for (const el of set) {
        const start = el.volume;
        const steps = Math.max(1, Math.round(seconds / 0.05));
        let i = 0;
        const timer = setInterval(() => {
          i += 1;
          el.volume = Math.max(0, start * (1 - i / steps));
          if (i >= steps) {
            clearInterval(timer);
            el.pause();
            el.currentTime = 0;
            forget(name, el);
          }
        }, 50);
      }
    },

    isMuted: () => muted,
    toggle() {
      muted = !muted;
      return muted;
    },
    setMuted(v) {
      muted = v;
    },
    setAllMuted(v) {
      allMuted = v;
    },
    setSinkId(deviceId) {
      sinkId = deviceId;
      for (const set of active.values()) {
        for (const el of set) applySink(el as SinkAudio);
      }
    },
  };
}

let instance: SfxApi | null = null;

/** Синглтон звукового пула. */
export function getSfx(): SfxApi {
  if (instance) return instance;
  instance = typeof window !== 'undefined' && typeof Audio !== 'undefined' ? createBrowser() : createNoop();
  return instance;
}

'use client';

import { toast } from 'sonner';
import { tx as msg } from '@/lib/i18n';
import { mediaErrorText } from '@/lib/voice/device-error';
import {
  isDesktopWindows,
  notifyScreenPicker,
  startNativeScreenAudio,
  stopNativeScreenAudio,
} from '@/lib/desktop-screen-audio';
import { useVoiceStore, type ScreenMode } from '@/stores/voice';
import { setting } from '@/stores/config';
import { setTileScreen } from '@/lib/voice/tiles';
import {
  DEFAULT_SETUP,
  captureConstraints,
  formatSetup,
  parseSetup,
  resolveProfile,
  screenContentHint,
  screenDegradation as degradationFor,
  type ScreenProfile,
  type ScreenSetup,
} from '@/lib/voice/screen-profile';

/**
 * Камера и демонстрация экрана — два источника, делящих один видео-слот.
 *
 * Вместе они здесь не потому, что оба «видео», а потому, что взаимно
 * исключают друг друга: включив экран, гасим камеру, и наоборот. Слот у
 * собеседников один, и решать, кто в нём сейчас, надо в одном месте — иначе
 * получается кадр, который никто не заказывал.
 *
 * Разного у них при этом больше, чем общего, и оно всё про звук: у камеры его
 * нет вовсе, а у демонстрации есть, и с ним отдельная история про эхо и про
 * нативный захват в десктоп-оболочке.
 */

/** Что камере и экрану нужно от того, чем они не владеют. */
export interface CameraSurroundings {
  /** Исходящий набор дорожек — общий с микрофоном, владеет им дирижёр. */
  stream(): MediaStream | null;
  /** Слушатель своего медиа не отдаёт: у него нет ни камеры, ни кнопки. */
  maySend(): boolean;
  /** Транспорту: в слоте появилось/пропало видео, либо сменились его настройки. */
  publish(what: 'camera' | 'screen'): void;
  unpublish(what: 'camera' | 'screen'): void;
  retune(): void;
  /**
   * Каким транспортом идёт звонок. От него зависит потолок трансляции: прямые
   * соединения шлют каждому свой поток, и 1440p там не по карману.
   */
  transport(): 'mesh' | 'sfu';
  /** Витрина и собеседники: у нас включилось/выключилось видео. */
  syncStore(): void;
  announce(): void;
}

let around: CameraSurroundings = {
  stream: () => null,
  maySend: () => false,
  publish: () => {},
  unpublish: () => {},
  retune: () => {},
  transport: () => 'mesh',
  syncStore: () => {},
  announce: () => {},
};

export function initCamera(surroundings: CameraSurroundings): void {
  around = surroundings;
}

// localStorage-ключ выбранной камеры — применяется при следующем включении.
const CAM_KEY = 'relay-cam-id';

let camOn = false;
let screenOn = false;
let camTrack: MediaStreamTrack | null = null;
let screenTrack: MediaStreamTrack | null = null;
let screenAudioTrack: MediaStreamTrack | null = null;
let screenMode: ScreenMode = 'quality';
let screenSetups: Record<ScreenMode, ScreenSetup> = { ...DEFAULT_SETUP };

/** Идёт ли с нас камера. */
export function isCamOn(): boolean {
  return camOn;
}

/** Идёт ли с нас демонстрация экрана. */
export function isScreenOn(): boolean {
  return screenOn;
}

/** Режим демонстрации: качество или ФПС. Едет в витрину настроек. */
export function currentScreenMode(): ScreenMode {
  return screenMode;
}

/**
 * Звук демонстрации. Он лежит в общем исходящем потоке, но мут микрофона его
 * не касается — микрофону надо уметь его отличить.
 */
export function screenAudio(): MediaStreamTrack | null {
  return screenAudioTrack;
}

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { max: 30 },
};

// echoCancellation: true — лекарство от «кенты слышат сами себя». При захвате
// системного/вкладочного звука в микс попадают голоса собеседников, которые
// играют из ДИНАМИКОВ ведущего; без AEC мы шлём их обратно — и каждый слышит
// собственное эхо. Chrome прогоняет захват демонстрации через свой эхоканцеллер,
// опираясь на то, что сам же воспроизводит (входящий WebRTC-звук), и вычитает его.
// Полностью петля уходит только в наушниках — об этом ведущему стоит напомнить,
// но AEC убирает основную часть и на колонках. noiseSuppression/autoGainControl
// держим выключенными, чтобы не «жевать» музыку/фильм при показе.
const SCREEN_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * `restrictOwnAudio` (свежий Chrome) вырезает из захвата звук, который играет
 * сама страница, — то есть ровно голоса собеседников. Там, где движок его
 * знает, просим и его: если он реально включился (см. `startScreen`),
 * эхоподавление со звука трансляции снимаем — оно мнёт музыку и звук игры.
 */
function screenAudioConstraints(): MediaTrackConstraints {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() as
    | Record<string, boolean>
    | undefined;
  return supported?.restrictOwnAudio
    ? ({ ...SCREEN_AUDIO_CONSTRAINTS, restrictOwnAudio: true } as MediaTrackConstraints)
    : SCREEN_AUDIO_CONSTRAINTS;
}

/**
 * Пожелания к окну выбора источника. Движок, который их не знает, молча
 * пропускает: `selfBrowserSurface` прячет из списка нашу же вкладку (показ
 * себя самого — бесконечный коридор зеркал), `surfaceSwitching` даёт сменить
 * окно, не останавливая трансляцию, `systemAudio` — предложить звук всего
 * экрана, а не только вкладки.
 */
const DISPLAY_OPTIONS = {
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  systemAudio: 'include',
} as const;
// ─── Камера: список устройств и выбор (модалка настроек) ───────────────────
/** Обновляет список камер (videoinput) и активную камеру в сторе. */
async function refreshCameraInfo() {
  const store = useVoiceStore.getState();
  const settings = camTrack?.getSettings?.();
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(CAM_KEY) : null;
  store.setCurrentCamera(settings?.deviceId ?? saved, camTrack?.label ?? '');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.setCameras(devices.filter((d) => d.kind === 'videoinput'));
  } catch {
    /* enumerateDevices недоступен — список останется пустым */
  }
}

/** Перечитать список камер (для UI). */
export function refreshCameras() {
  void refreshCameraInfo();
}

/**
 * Переключить камеру. Выбор запоминаем; если камера включена — перезапускаем её
 * с новым устройством (startCamera читает сохранённый deviceId).
 */
export async function setCamera(deviceId: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(CAM_KEY, deviceId);
  if (camOn) {
    stopCamera();
    await startCamera();
    around.announce();
    around.syncStore();
  } else {
    void refreshCameraInfo();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Демонстрация экрана: режим качество/ФПС
// ─────────────────────────────────────────────────────────────────────────

// Выбор живёт в браузере, как и остальные медиа-предпочтения: режим — тот, с
// которым человек начинал прошлую трансляцию, разрешение и кадры каждого
// режима — из вкладки «Трансляция» в настройках (строкой `1440p30`).
const SCREEN_MODE_KEY = 'relay-screen-mode';
const SCREEN_SETUP_KEYS: Record<ScreenMode, string> = {
  quality: 'relay-screen-quality',
  fps: 'relay-screen-motion',
};

function readPref(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

function writePref(key: string, value: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

/** Поднять выбор из браузера в модуль и в стор (при старте приложения). */
export function loadScreenPrefs() {
  const mode = readPref(SCREEN_MODE_KEY);
  if (mode === 'quality' || mode === 'fps') screenMode = mode;
  screenSetups = {
    quality: parseSetup(readPref(SCREEN_SETUP_KEYS.quality)) ?? DEFAULT_SETUP.quality,
    fps: parseSetup(readPref(SCREEN_SETUP_KEYS.fps)) ?? DEFAULT_SETUP.fps,
  };
  useVoiceStore.getState().setMedia({ screenMode, screenSetups });
}

/**
 * Профиль трансляции прямо сейчас: режим и его настройка, прижатые к
 * потолкам владельца и к транспорту. Его читают и захват, и оба транспорта.
 */
export function currentScreenProfile(): ScreenProfile {
  return resolveProfile({
    mode: screenMode,
    setups: screenSetups,
    transport: around.transport(),
    maxHeight: Number(setting<string>('voice.screenMaxHeight')),
    maxBitrate: setting<number>('voice.screenBitrateKbps') * 1000,
  });
}

export function screenDegradation(): RTCDegradationPreference {
  return degradationFor(screenMode);
}

/**
 * Привести идущую трансляцию к текущему профилю: захват (размер, кадры),
 * подсказку кодировщику и — через транспорт — кодировки. Без перезапуска
 * показа и без пересогласования SDP.
 */
async function retuneScreen() {
  const track = screenTrack;
  if (!screenOn || !track) return;
  track.contentHint = screenContentHint(screenMode);
  try {
    await track.applyConstraints(captureConstraints(currentScreenProfile()));
  } catch (err) {
    // Движок не умеет пересобрать захват на лету — кодировки всё равно
    // поменяем: битрейт и кадры решают больше, чем размер исходника.
    console.warn('[screen] applyConstraints failed:', err);
  }
  if (screenTrack !== track) return; // пока ждали, показ остановили
  around.retune();
}

export function setScreenMode(mode: ScreenMode) {
  if (mode === screenMode) return;
  screenMode = mode;
  writePref(SCREEN_MODE_KEY, mode);
  useVoiceStore.getState().setMedia({ screenMode });
  void retuneScreen();
}

/** Разрешение и/или кадры режима — из вкладки «Трансляция». */
export function setScreenSetup(mode: ScreenMode, change: Partial<ScreenSetup>) {
  const next = { ...screenSetups[mode], ...change };
  if (next.height === screenSetups[mode].height && next.fps === screenSetups[mode].fps) return;
  screenSetups = { ...screenSetups, [mode]: next };
  writePref(SCREEN_SETUP_KEYS[mode], formatSetup(next));
  useVoiceStore.getState().setMedia({ screenSetups });
  if (screenMode === mode) void retuneScreen();
}

/**
 * Транспорт сменился посреди трансляции (вошли в канал другого режима) —
 * потолок у него свой.
 */
export function transportChanged() {
  void retuneScreen();
}

// Что сейчас уходит собеседникам в общий видео-sender
export function currentVideoTrack(): MediaStreamTrack | null {
  return screenOn ? screenTrack : camOn ? camTrack : null;
}

export async function toggleCamera() {
  if (!around.stream() || !around.maySend()) return; // слушатель своего медиа не отдаёт
  if (camOn) stopCamera();
  else await startCamera();
  around.announce();
  around.syncStore();
}

async function startCamera() {
  if (screenOn) stopScreen(); // экран и камера занимают один слот — взаимоисключают
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(CAM_KEY) : null;
  try {
    let cam: MediaStream;
    try {
      cam = await navigator.mediaDevices.getUserMedia({
        video: saved ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: saved } } : VIDEO_CONSTRAINTS,
      });
    } catch (err) {
      // Сохранённая камера пропала/занята — откатываемся на устройство по умолчанию
      if ((err as { name?: string } | null)?.name !== 'OverconstrainedError') throw err;
      cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    }
    camTrack = cam.getVideoTracks()[0];
  } catch (err) {
    toast.error(msg('voice.toast.camUnavailable', { reason: mediaErrorText(err) }));
    return;
  }

  camTrack.contentHint = 'motion';
  // Камеру отняла система или выдернули устройство — корректно гасим у всех
  camTrack.onended = () => {
    stopCamera();
    around.announce();
    around.syncStore();
    toast(msg('voice.toast.camStopped'));
  };

  around.stream()!.addTrack(camTrack);
  camOn = true;
  around.publish('camera');
  void refreshCameraInfo();
}

function stopCamera() {
  if (camTrack) {
    camTrack.onended = null;
    camTrack.stop();
    around.stream()?.removeTrack(camTrack);
    camTrack = null;
  }
  around.unpublish('camera');
  camOn = false;
}

export async function toggleScreen() {
  if (!around.stream() || !around.maySend()) return; // слушатель своего медиа не отдаёт
  if (screenOn) stopScreen();
  else await startScreen();
  around.announce();
  around.syncStore();
}

async function startScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast.error(msg('voice.toast.screenUnsupported'));
    return;
  }

  // На десктоп-оболочке (Windows) звук экрана снимаем НАТИВНО, исключая процесс
  // relay из захвата, — иначе getDisplayMedia тащит системный микс с голосами
  // собеседников из динамиков, и они слышат сами себя. Тогда у getDisplayMedia
  // просим только видео. См. lib/desktop-screen-audio.ts.
  const nativeAudio = isDesktopWindows();

  let display: MediaStream;
  // Пока открыт нативный выбор источника, оболочка знает об этом: пикер рисует
  // движок своим модальным окном, и после его закрытия окну нужна побудка
  // (см. notifyScreenPicker). Закрытие отбиваем в finally — «Отмена» здесь
  // такой же выход, как и удачный выбор.
  notifyScreenPicker(true);
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(currentScreenProfile()),
      audio: nativeAudio ? false : screenAudioConstraints(),
      ...DISPLAY_OPTIONS,
    } as DisplayMediaStreamOptions);
  } catch (err) {
    const e = err as { name?: string } | null;
    // Пользователь просто закрыл выбор источника — это не ошибка, молчим
    if (!(e && (e.name === 'NotAllowedError' || e.name === 'AbortError'))) {
      toast.error(msg('voice.toast.screenFailed', { reason: mediaErrorText(err) }));
    }
    return;
  } finally {
    notifyScreenPicker(false);
  }

  // Экран реально получен — только теперь освобождаем видео-слот от камеры
  if (camOn) stopCamera();

  screenTrack = display.getVideoTracks()[0];
  screenTrack.contentHint = screenContentHint(screenMode);

  if (nativeAudio) {
    // Нативный захват без голосов relay. Может вернуть null (нативный путь
    // недоступен) — тогда демонстрация просто без звука, это лучше эхо-петли.
    screenAudioTrack = await startNativeScreenAudio();
    if (screenAudioTrack) screenAudioTrack.contentHint = 'music';
  } else {
    screenAudioTrack = display.getAudioTracks()[0] || null;
    // Звук демонстрации — это музыка/фильм: кодеку выгоднее музыкальный режим Opus
    if (screenAudioTrack) {
      screenAudioTrack.contentHint = 'music';
      // EC по типу источника. Шеринг ВКЛАДКИ ('browser') захватывает звук только
      // этой вкладки — голосов собеседников там нет (звонок в другой вкладке),
      // эхо невозможно, поэтому снимаем AEC ради чистой музыки/фильма. Шеринг
      // всего экрана/окна ('monitor'/'window') тащит системный микс с голосами из
      // динамиков — там EC оставляем включённым (из SCREEN_AUDIO_CONSTRAINTS) как
      // защиту от «кенты слышат сами себя». Неизвестный источник → не трогаем.
      // Исключение — движок, который сам вырезал из захвата звук нашей страницы
      // (`restrictOwnAudio` вступил в силу): голосов собеседников в миксе нет,
      // и эхоподавлению там нечего делать, кроме как портить звук.
      const surface = (screenTrack.getSettings() as MediaTrackSettings).displaySurface;
      const ownAudioCut =
        (screenAudioTrack.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio ===
        true;
      if (surface === 'browser' || ownAudioCut) {
        void screenAudioTrack
          .applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          })
          .catch(() => {});
      }
    }
  }

  // «Прекратить доступ» в нативной плашке браузера — корректно завершаем
  screenTrack.onended = () => {
    stopScreen();
    around.announce();
    around.syncStore();
    toast(msg('voice.toast.screenEnded'));
  };

  around.stream()!.addTrack(screenTrack);
  if (screenAudioTrack) around.stream()!.addTrack(screenAudioTrack);
  screenOn = true;
  around.publish('screen');

  // местную плитку не зеркалим и показываем целиком (см. .tile.local.screen)
  setTileScreen('local', true);
}

function stopScreen() {
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
    around.stream()?.removeTrack(screenTrack);
    screenTrack = null;
  }
  if (screenAudioTrack) {
    screenAudioTrack.stop();
    around.stream()?.removeTrack(screenAudioTrack);
    screenAudioTrack = null;
  }
  // Нативный захват (Windows) остановить отдельно: track.stop() глушит только
  // web-часть графа, а не WASAPI-поток в оболочке. Вне Tauri — no-op.
  void stopNativeScreenAudio();
  around.unpublish('screen');
  screenOn = false;
  setTileScreen('local', false);
}

/**
 * Полный выход из эфира: отпускаем видео-слот.
 *
 * Сами дорожки уже остановлены вместе с потоком (их гасит дирижёр), здесь —
 * снять обработчики `onended` и забыть, что мы что-то показывали. Обработчик,
 * переживший выход, дёрнул бы `stopScreen` в уже разобранном звонке.
 */
export function teardownVideo(): void {
  if (camTrack) {
    camTrack.onended = null;
    camTrack = null;
  }
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack = null;
  }
  screenAudioTrack = null;
  screenOn = false;
  camOn = false;
}

/**
 * Профили трансляции экрана: что снимать, сколько слать и какими слоями.
 *
 * Лист без состояния и зависимостей — всё, что зависит от человека (режим,
 * разрешение и кадры каждого режима), от владельца (потолки инсталляции) и от транспорта,
 * приходит аргументами. Поэтому одна и та же таблица кормит и захват
 * (`camera.ts`), и оба транспорта, и тесты.
 *
 * Два режима — две разные задачи, а не два положения одной ручки:
 * «Картинка» — текст, код, документы: разрешение важнее кадров, и при
 * нехватке канала кодировщик бросает кадры, а не резкость. «Плавность» — игры
 * и видео: наоборот. Разрешение и кадры у каждого режима свои и выбираются
 * порознь; режим же решает, чем жертвовать, когда канала или процессора мало.
 *
 * См. docs/plans/screen-share.md.
 */

export type ScreenMode = 'quality' | 'fps';

/** Что человек выбрал для режима: разрешение и кадры — порознь, любые сочетания. */
export interface ScreenSetup {
  height: number;
  fps: number;
}

export const SCREEN_HEIGHTS = [720, 1080, 1440] as const;
export const SCREEN_FPS = [30, 45, 60] as const;

/** Картинка — резкость для текста и кода; плавность — кадры для игр и видео. */
export const DEFAULT_SETUP: Readonly<Record<ScreenMode, ScreenSetup>> = {
  quality: { height: 1440, fps: 30 },
  fps: { height: 1080, fps: 60 },
};

/** Потолки высоты, которые владелец может выставить в панели (`voice.screenMaxHeight`). */
export const INSTALL_HEIGHTS = SCREEN_HEIGHTS;

/**
 * Mesh — прямые соединения: каждый собеседник получает свой поток прямо с
 * аплинка стримера, и на троих это уже три потока. Поэтому выбор человека там
 * прижимается к своему потолку по высоте и битрейту.
 */
const MESH_MAX_HEIGHT = 720;
const MESH_MAX_BITRATE = 4_000_000;

/** Нижний слой SFU — то, что зритель получает в плитке, а не на весь экран. */
const LOW_LAYER_HEIGHT = 720;
const LOW_LAYER_MAX_FPS = 30;
const LOW_LAYER_BITRATE = 1_500_000; // 720p30 экрана
const LOW_LAYER_MIN_BITRATE = 300_000;

export interface ScreenProfile {
  height: number;
  fps: number;
  /** Верхний слой (в mesh — единственный), бит/с. */
  bitrate: number;
}

export interface ProfileInput {
  mode: ScreenMode;
  /** Выбор человека под каждый режим (вкладка «Трансляция»). */
  setups: Readonly<Record<ScreenMode, ScreenSetup>>;
  transport: 'mesh' | 'sfu';
  /** Потолки инсталляции: `voice.screenMaxHeight` и `voice.screenBitrateKbps`. */
  maxHeight: number;
  maxBitrate: number;
}

/** `1440p30` — так выбор хранится в браузере (и так его писали прежние версии). */
export function formatSetup(setup: ScreenSetup): string {
  return `${setup.height}p${setup.fps}`;
}

export function parseSetup(raw: string | null): ScreenSetup | null {
  const m = raw?.match(/^(\d+)p(\d+)$/);
  if (!m) return null;
  const height = Number(m[1]);
  const fps = Number(m[2]);
  const known =
    (SCREEN_HEIGHTS as readonly number[]).includes(height) &&
    (SCREEN_FPS as readonly number[]).includes(fps);
  return known ? { height, fps } : null;
}

/**
 * Битрейт верхнего слоя под кадр и кадры. Опорная точка — 1440p30 за 8 Мбит/с
 * (под VP8, самый прожорливый из наших кодеков: H264 на той же картинке
 * укладывается в меньшее, так что запас ему не вредит). Растёт медленнее
 * площади и кадров: мелкому кадру на точку нужно больше, а соседние кадры
 * экрана похожи друг на друга. Округление — до полумегабита.
 */
export function setupBitrate(height: number, fps: number): number {
  const area = (height / 1440) ** 2;
  const raw = 8_000_000 * area ** 0.75 * (fps / 30) ** 0.7;
  return Math.round(raw / 500_000) * 500_000;
}

/**
 * Итоговый профиль: выбор человека для режима, прижатый к потолкам
 * инсталляции и транспорта. Урезанная высота тянет за собой и битрейт: 1440p,
 * урезанный владельцем до 1080p, не должен жечь битрейт 1440p.
 */
export function resolveProfile(input: ProfileInput): ScreenProfile {
  const setup = input.setups[input.mode];
  const caps = [setup.height];
  if (Number.isFinite(input.maxHeight) && input.maxHeight > 0) caps.push(input.maxHeight);
  if (input.transport === 'mesh') caps.push(MESH_MAX_HEIGHT);
  const height = Math.min(...caps);
  let bitrate = setupBitrate(height, setup.fps);
  if (input.maxBitrate > 0) bitrate = Math.min(bitrate, input.maxBitrate);
  if (input.transport === 'mesh') bitrate = Math.min(bitrate, MESH_MAX_BITRATE);
  return { height, fps: setup.fps, bitrate };
}

/**
 * Ограничения захвата. `max`, а не `ideal`: с `ideal` движок волен отдать и
 * больше, и меньше, а здесь нужно ровно «не больше профиля» — экран 4K
 * ужимается до него, экран 1080p так и остаётся 1080p, а не растягивается.
 * Ширина — под 16:9 той же высоты: сверхширокий монитор впишется в ту же
 * площадь кадра, а не раздует её на треть.
 */
export function captureConstraints(profile: ScreenProfile): MediaTrackConstraints {
  return {
    width: { max: Math.round((profile.height * 16) / 9) },
    height: { max: profile.height },
    frameRate: { ideal: profile.fps, max: profile.fps },
  };
}

export interface ScreenEncoding {
  rid?: string;
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  scalabilityMode?: string;
}

/**
 * Во сколько раз ужать кадр, чтобы он влез в профиль. Захват обычно уже
 * прижат ограничениями (`captureConstraints`), но не везде: WebKit и Firefox
 * умеют проигнорировать `max` у экрана, а `applyConstraints` на лету может и
 * отказать. Потолок владельца не должен зависеть от того, послушался ли
 * захват, — поэтому он же стоит и в кодировщике.
 */
function fitScale(trackHeight: number, height: number): number {
  return trackHeight > height ? trackHeight / height : 1;
}

/**
 * Кодировки SFU: два слоя simulcast — нижний для плитки, верхний для того,
 * кто развернул трансляцию. Слоёв всегда два: их число задаётся при создании
 * producer'а и потом не меняется, а смена режима на лету меняет высоту кадра.
 *
 * `trackHeight` — что реально снимается сейчас (`getSettings().height`): экран
 * бывает и ниже профиля, и тогда нижний слой — половина кадра, а не 720p.
 */
export function sfuScreenEncodings(profile: ScreenProfile, trackHeight: number): ScreenEncoding[] {
  const source = trackHeight > 0 ? trackHeight : profile.height;
  const full = Math.min(source, profile.height);
  const lowHeight = full > LOW_LAYER_HEIGHT ? LOW_LAYER_HEIGHT : Math.max(1, Math.round(full / 2));
  const lowFps = Math.min(profile.fps, LOW_LAYER_MAX_FPS);
  const lowBitrate = Math.max(
    LOW_LAYER_MIN_BITRATE,
    Math.round(LOW_LAYER_BITRATE * (lowHeight / LOW_LAYER_HEIGHT) ** 2),
  );
  return [
    {
      rid: 'l',
      maxBitrate: Math.min(lowBitrate, profile.bitrate),
      maxFramerate: lowFps,
      scaleResolutionDownBy: source / lowHeight,
      scalabilityMode: 'L1T3',
    },
    {
      rid: 'f',
      maxBitrate: profile.bitrate,
      maxFramerate: profile.fps,
      scaleResolutionDownBy: fitScale(source, profile.height),
      scalabilityMode: 'L1T3',
    },
  ];
}

/** Кодировка mesh: один слой — у каждого собеседника свой поток и так. */
export function meshScreenEncoding(profile: ScreenProfile, trackHeight: number): ScreenEncoding {
  return {
    maxBitrate: profile.bitrate,
    maxFramerate: profile.fps,
    scaleResolutionDownBy: fitScale(trackHeight, profile.height),
  };
}

/** Что кодировщику беречь при нехватке канала или процессора. */
export function screenDegradation(mode: ScreenMode): RTCDegradationPreference {
  return mode === 'fps' ? 'maintain-framerate' : 'maintain-resolution';
}

/** Подсказка кодировщику о содержимом: текст — резкость, движение — плавность. */
export function screenContentHint(mode: ScreenMode): string {
  return mode === 'fps' ? 'motion' : 'detail';
}

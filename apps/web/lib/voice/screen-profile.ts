/**
 * Профили трансляции экрана: что снимать, сколько слать и какими слоями.
 *
 * Лист без состояния и зависимостей — всё, что зависит от человека (режим,
 * выбранные пресеты), от владельца (потолки инсталляции) и от транспорта,
 * приходит аргументами. Поэтому одна и та же таблица кормит и захват
 * (`camera.ts`), и оба транспорта, и тесты.
 *
 * Два режима — две разные задачи, а не два положения одной ручки:
 * «Картинка» — текст, код, документы: разрешение важнее кадров, и при
 * нехватке канала кодировщик бросает кадры, а не резкость. «Плавность» — игры
 * и видео: наоборот. Поэтому у каждого режима свой набор пресетов.
 *
 * См. docs/plans/screen-share.md.
 */

export type ScreenMode = 'quality' | 'fps';
export type QualityPreset = '1440p30' | '1440p45' | '1080p30';
export type MotionPreset = '1080p60' | '720p60';
export type ScreenPreset = QualityPreset | MotionPreset;

export const QUALITY_PRESETS: readonly QualityPreset[] = ['1440p30', '1440p45', '1080p30'];
export const MOTION_PRESETS: readonly MotionPreset[] = ['1080p60', '720p60'];
export const DEFAULT_QUALITY_PRESET: QualityPreset = '1440p30';
export const DEFAULT_MOTION_PRESET: MotionPreset = '1080p60';

/** Потолки высоты, которые владелец может выставить в панели (`voice.screenMaxHeight`). */
export const INSTALL_HEIGHTS = [720, 1080, 1440] as const;

interface PresetSpec {
  height: number;
  fps: number;
  /** Верхний слой, бит/с. Потолок: статичный экран кодировщик и сам шлёт скромнее. */
  bitrate: number;
}

// Битрейт — под VP8, самый прожорливый из наших кодеков: H264 и VP9 на той же
// картинке укладываются в меньшее, так что запас им не вредит. 45 кадров на
// мониторе 60 Гц ложатся неровно (кадр держится то один такт, то два), поэтому
// это опция, а не умолчание: для текста и кода 30 хватает с запасом.
const PRESETS: Record<ScreenPreset, PresetSpec> = {
  '1440p30': { height: 1440, fps: 30, bitrate: 8_000_000 },
  '1440p45': { height: 1440, fps: 45, bitrate: 10_000_000 },
  '1080p30': { height: 1080, fps: 30, bitrate: 5_000_000 },
  '1080p60': { height: 1080, fps: 60, bitrate: 8_000_000 },
  '720p60': { height: 720, fps: 60, bitrate: 4_500_000 },
};

/**
 * Mesh — прямые соединения: каждый собеседник получает свой поток прямо с
 * аплинка стримера, и на троих это уже три потока. Поэтому потолок здесь свой и
 * один на оба режима; режим решает только, чем жертвовать при нехватке канала.
 */
const MESH: PresetSpec = { height: 800, fps: 60, bitrate: 4_000_000 };

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
  quality: QualityPreset;
  motion: MotionPreset;
  transport: 'mesh' | 'sfu';
  /** Потолки инсталляции: `voice.screenMaxHeight` и `voice.screenBitrateKbps`. */
  maxHeight: number;
  maxBitrate: number;
}

export function isQualityPreset(v: unknown): v is QualityPreset {
  return QUALITY_PRESETS.includes(v as QualityPreset);
}

export function isMotionPreset(v: unknown): v is MotionPreset {
  return MOTION_PRESETS.includes(v as MotionPreset);
}

export function presetSpec(preset: ScreenPreset): Readonly<PresetSpec> {
  return PRESETS[preset];
}

/**
 * Итоговый профиль: пресет режима, прижатый к потолкам инсталляции.
 *
 * Прижатая высота тянет за собой и битрейт — пропорционально площади кадра:
 * 1440p, урезанный владельцем до 1080p, не должен жечь битрейт 1440p на
 * картинку, в которой почти вдвое меньше точек.
 */
export function resolveProfile(input: ProfileInput): ScreenProfile {
  const base =
    input.transport === 'mesh'
      ? MESH
      : PRESETS[input.mode === 'fps' ? input.motion : input.quality];
  const cap =
    Number.isFinite(input.maxHeight) && input.maxHeight > 0 ? input.maxHeight : base.height;
  const height = Math.min(base.height, cap);
  const area = (height / base.height) ** 2;
  const ceiling = input.maxBitrate > 0 ? input.maxBitrate : Infinity;
  return {
    height,
    fps: base.fps,
    bitrate: Math.round(Math.min(base.bitrate * area, ceiling)),
  };
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

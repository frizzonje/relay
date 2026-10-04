import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETUP,
  captureConstraints,
  meshScreenEncoding,
  parseSetup,
  resolveProfile,
  setupBitrate,
  sfuScreenEncodings,
  type ProfileInput,
} from './screen-profile';

const base: ProfileInput = {
  mode: 'quality',
  setups: DEFAULT_SETUP,
  transport: 'sfu',
  maxHeight: 1440,
  maxBitrate: 20_000_000,
};

const withSetup = (mode: 'quality' | 'fps', height: number, fps: number): ProfileInput => ({
  ...base,
  mode,
  setups: { ...DEFAULT_SETUP, [mode]: { height, fps } },
});

describe('профиль трансляции', () => {
  it('по умолчанию: картинка — 1440p30, плавность — 1080p60', () => {
    expect(resolveProfile(base)).toEqual({ height: 1440, fps: 30, bitrate: 8_000_000 });
    expect(resolveProfile({ ...base, mode: 'fps' })).toMatchObject({ height: 1080, fps: 60 });
  });

  it('разрешение и кадры — любым сочетанием, в любом режиме', () => {
    expect(resolveProfile(withSetup('quality', 1080, 45))).toMatchObject({ height: 1080, fps: 45 });
    expect(resolveProfile(withSetup('fps', 1440, 60))).toMatchObject({ height: 1440, fps: 60 });
    expect(resolveProfile(withSetup('fps', 720, 30))).toMatchObject({ height: 720, fps: 30 });
  });

  /**
   * Битрейт растёт с кадром и кадрами, но медленнее их: опорные точки —
   * те, что проверены на стенде и в прежней таблице пресетов.
   */
  it('битрейт — от кадра и кадров', () => {
    expect(setupBitrate(1440, 30)).toBe(8_000_000);
    expect(setupBitrate(1440, 45)).toBe(10_500_000);
    expect(setupBitrate(1440, 60)).toBe(13_000_000);
    expect(setupBitrate(1080, 60)).toBe(8_500_000);
    expect(setupBitrate(1080, 30)).toBe(5_000_000);
    expect(setupBitrate(720, 60)).toBe(4_500_000);
  });

  /** Потолок высоты — деньги владельца: урезанный кадр не жжёт битрейт исходного. */
  it('потолок инсталляции режет высоту, а битрейт считается от урезанной', () => {
    const p = resolveProfile({ ...base, maxHeight: 1080 });
    expect(p).toEqual({ height: 1080, fps: 30, bitrate: setupBitrate(1080, 30) });
  });

  it('потолок битрейта инсталляции главнее выбора', () => {
    expect(resolveProfile({ ...withSetup('fps', 1440, 60), maxBitrate: 10_000_000 }).bitrate).toBe(
      10_000_000,
    );
  });

  it('mesh — выбор человека, прижатый к 800p и 4 Мбит/с', () => {
    const mesh = { ...base, transport: 'mesh' as const };
    expect(resolveProfile(mesh)).toEqual({ height: 800, fps: 30, bitrate: 3_500_000 });
    expect(resolveProfile({ ...mesh, mode: 'fps' })).toEqual({
      height: 800,
      fps: 60,
      bitrate: 4_000_000,
    });
    expect(resolveProfile({ ...mesh, maxHeight: 720 }).height).toBe(720);
  });

  it('мусор в потолках не ломает профиль: берётся выбор как есть', () => {
    expect(resolveProfile({ ...base, maxHeight: NaN, maxBitrate: 0 })).toEqual({
      height: 1440,
      fps: 30,
      bitrate: 8_000_000,
    });
  });
});

describe('выбор в браузере', () => {
  it('читается из строки `1440p30` — в том числе записанной прежними версиями', () => {
    expect(parseSetup('1440p45')).toEqual({ height: 1440, fps: 45 });
    expect(parseSetup('720p60')).toEqual({ height: 720, fps: 60 });
  });

  it('неизвестное и мусор — null, тогда берётся умолчание', () => {
    expect(parseSetup('2160p60')).toBeNull();
    expect(parseSetup('1080p25')).toBeNull();
    expect(parseSetup('много')).toBeNull();
    expect(parseSetup(null)).toBeNull();
  });
});

describe('захват', () => {
  it('ограничения — потолок, а не пожелание: max по высоте, ширине и кадрам', () => {
    expect(captureConstraints({ height: 1440, fps: 30, bitrate: 1 })).toEqual({
      width: { max: 2560 },
      height: { max: 1440 },
      frameRate: { ideal: 30, max: 30 },
    });
  });
});

describe('кодировки', () => {
  const p1440 = { height: 1440, fps: 45, bitrate: 10_000_000 };

  it('SFU: два слоя — 720p30 для плитки и полный кадр для развернувших', () => {
    const [low, full] = sfuScreenEncodings(p1440, 1440);
    expect(low).toMatchObject({ rid: 'l', scaleResolutionDownBy: 2, maxFramerate: 30 });
    expect(low.maxBitrate).toBe(1_500_000);
    expect(full).toMatchObject({
      rid: 'f',
      scaleResolutionDownBy: 1,
      maxFramerate: 45,
      maxBitrate: 10_000_000,
    });
  });

  it('нижний слой считается от реального кадра, а не от профиля', () => {
    // Экран 1080p при профиле 1440p: снимается 1080, нижний слой всё равно 720.
    expect(sfuScreenEncodings(p1440, 1080)[0].scaleResolutionDownBy).toBe(1.5);
    // Кадр ниже 720 — нижний слой его половина, и битрейт под неё.
    const [low] = sfuScreenEncodings({ height: 720, fps: 60, bitrate: 4_500_000 }, 720);
    expect(low.scaleResolutionDownBy).toBe(2);
    expect(low.maxBitrate).toBe(375_000);
  });

  it('высота кадра ещё неизвестна — считаем от профиля', () => {
    expect(sfuScreenEncodings(p1440, 0)[0].scaleResolutionDownBy).toBe(2);
  });

  it('нижний слой не жирнее верхнего при скупом потолке владельца', () => {
    const [low] = sfuScreenEncodings({ height: 1440, fps: 30, bitrate: 1_000_000 }, 1440);
    expect(low.maxBitrate).toBe(1_000_000);
  });

  it('mesh: один слой с потолком профиля', () => {
    expect(meshScreenEncoding({ height: 800, fps: 60, bitrate: 4_000_000 }, 800)).toEqual({
      maxBitrate: 4_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
    });
  });

  /**
   * Захват не послушался `max` (WebKit, Firefox, отказ applyConstraints) и
   * отдаёт родные 1440p. Потолок владельца держит кодировщик.
   */
  it('захват выше профиля — кодировщик сам ужимает его до потолка', () => {
    const [low, full] = sfuScreenEncodings({ height: 1080, fps: 60, bitrate: 8_000_000 }, 1440);
    expect(full.scaleResolutionDownBy).toBeCloseTo(1440 / 1080);
    expect(low.scaleResolutionDownBy).toBe(2);
    expect(
      meshScreenEncoding({ height: 800, fps: 60, bitrate: 4_000_000 }, 1440).scaleResolutionDownBy,
    ).toBe(1.8);
  });
});

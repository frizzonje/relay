import { describe, expect, it } from 'vitest';
import {
  captureConstraints,
  meshScreenEncoding,
  resolveProfile,
  sfuScreenEncodings,
  type ProfileInput,
} from './screen-profile';

const base: ProfileInput = {
  mode: 'quality',
  quality: '1440p30',
  motion: '1080p60',
  transport: 'sfu',
  maxHeight: 1440,
  maxBitrate: 10_000_000,
};

describe('профиль трансляции', () => {
  it('режим выбирает свой пресет: картинка — 1440p30, плавность — 1080p60', () => {
    expect(resolveProfile(base)).toEqual({ height: 1440, fps: 30, bitrate: 8_000_000 });
    expect(resolveProfile({ ...base, mode: 'fps' })).toEqual({
      height: 1080,
      fps: 60,
      bitrate: 8_000_000,
    });
  });

  it('1440p45 — опция для тех, кому мало 30', () => {
    expect(resolveProfile({ ...base, quality: '1440p45' })).toMatchObject({
      height: 1440,
      fps: 45,
    });
  });

  /**
   * Потолок высоты — деньги владельца. Урезанный кадр не должен жечь битрейт
   * исходного пресета: точек в нём меньше пропорционально площади.
   */
  it('потолок инсталляции режет высоту, а битрейт — по площади кадра', () => {
    const p = resolveProfile({ ...base, maxHeight: 1080 });
    expect(p.height).toBe(1080);
    expect(p.fps).toBe(30);
    expect(p.bitrate).toBe(Math.round(8_000_000 * (1080 / 1440) ** 2));
  });

  it('потолок битрейта инсталляции главнее пресета', () => {
    expect(resolveProfile({ ...base, quality: '1440p45', maxBitrate: 6_000_000 }).bitrate).toBe(
      6_000_000,
    );
  });

  it('mesh — свой потолок 800p60 в обоих режимах', () => {
    const mesh = { ...base, transport: 'mesh' as const };
    expect(resolveProfile(mesh)).toMatchObject({ height: 800, fps: 60 });
    expect(resolveProfile({ ...mesh, mode: 'fps' })).toMatchObject({ height: 800, fps: 60 });
    // Владелец урезал до 720 — mesh тоже ниже.
    expect(resolveProfile({ ...mesh, maxHeight: 720 }).height).toBe(720);
  });

  it('мусор в потолках не ломает профиль: берётся пресет как есть', () => {
    expect(resolveProfile({ ...base, maxHeight: NaN, maxBitrate: 0 })).toEqual({
      height: 1440,
      fps: 30,
      bitrate: 8_000_000,
    });
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
    expect(meshScreenEncoding({ height: 800, fps: 60, bitrate: 4_000_000 })).toEqual({
      maxBitrate: 4_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
    });
  });
});

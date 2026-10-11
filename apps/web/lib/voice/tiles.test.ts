import { beforeEach, describe, expect, it, vi } from 'vitest';

let stored: unknown = {};
vi.mock('@/lib/prefs', () => ({
  readPref: () => stored,
  setPref: (_key: string, value: unknown) => (stored = value),
}));

import { useVoiceStore } from '@/stores/voice';
import { addTile, initTiles, removeTile } from './tiles';

/**
 * Громкость собеседника — настройка человека, она едет с ним с сервера на все
 * его устройства. Значит, это данные снаружи: запись прежней версии, чужого
 * клиента или руки. Ползунок ходит 0–3, и всё, что не число в этих пределах,
 * в микшер попасть не должно — 50 означало бы 5000 % в наушники, а строка
 * роняла бы присваивание `gain.value`.
 */
describe('saved peer volume', () => {
  const gains: Array<[string, number]> = [];

  beforeEach(() => {
    gains.length = 0;
    initTiles({
      dropAudio: () => {},
      setGain: (_id, kind, value) => gains.push([kind, value]),
      focusChanged: () => {},
      viewChanged: () => {},
    });
    removeTile('p');
  });

  it('clamps a stored level above the slider range', () => {
    stored = { Аня: { voice: 50, screen: -2 } };
    addTile('p', 'Аня', null, false);
    const tile = useVoiceStore.getState().tiles.find((t) => t.id === 'p')!;
    expect(tile.volume).toBe(3);
    expect(tile.screenVolume).toBe(0);
  });

  it('ignores a stored level that is not a finite number', () => {
    stored = { Аня: { voice: 'loud', screen: Number.NaN } };
    addTile('p', 'Аня', null, false);
    const tile = useVoiceStore.getState().tiles.find((t) => t.id === 'p')!;
    expect(tile.volume).toBe(1);
    expect(tile.screenVolume).toBe(1);
  });
});

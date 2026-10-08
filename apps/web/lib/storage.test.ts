import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetStored,
  readStored,
  readStoredJson,
  storedKeys,
  writeStored,
  writeStoredJson,
} from './storage';
import { setTheme } from './theme';

/**
 * Хранилище браузера бросает чаще, чем кажется: Safari в приватном режиме и
 * переполненная квота — на `setItem`, Firefox с запретом хранилища — на самом
 * обращении к `localStorage`. Каждый такой бросок, не пойманный на месте,
 * ронял то действие, ради которого человек нажал кнопку.
 */

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

const throwing = {
  get length(): number {
    throw new DOMException('нельзя', 'SecurityError');
  },
  key() {
    throw new DOMException('нельзя', 'SecurityError');
  },
  getItem() {
    throw new DOMException('нельзя', 'SecurityError');
  },
  setItem() {
    throw new DOMException('квота', 'QuotaExceededError');
  },
  removeItem() {
    throw new DOMException('нельзя', 'SecurityError');
  },
  clear() {},
} as unknown as Storage;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('хранилище, которое не бросает', () => {
  it('пишет, читает и забывает строки и JSON', () => {
    vi.stubGlobal('localStorage', memory());
    writeStored('a', '1');
    writeStoredJson('b', { x: [1] });
    expect(readStored('a')).toBe('1');
    expect(readStoredJson('b')).toEqual({ x: [1] });
    expect(storedKeys().sort()).toEqual(['a', 'b']);
    forgetStored('a');
    expect(readStored('a')).toBeNull();
  });

  it('битый JSON — «ничего не лежит», а не исключение', () => {
    vi.stubGlobal('localStorage', memory());
    writeStored('b', '{не json');
    expect(readStoredJson('b')).toBeUndefined();
  });

  it('хранилище бросает на всём — ответы пустые, действия не падают', () => {
    vi.stubGlobal('localStorage', throwing);
    expect(() => writeStored('a', '1')).not.toThrow();
    expect(() => writeStoredJson('a', 1)).not.toThrow();
    expect(() => forgetStored('a')).not.toThrow();
    expect(readStored('a')).toBeNull();
    expect(readStoredJson('a')).toBeUndefined();
    expect(storedKeys()).toEqual([]);
  });

  it('хранилища нет вовсе (серверный рендер) — то же самое', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readStored('a')).toBeNull();
    expect(() => writeStored('a', '1')).not.toThrow();
  });

  it('смена темы не падает оттого, что выбор негде запомнить', () => {
    vi.stubGlobal('localStorage', throwing);
    expect(() => setTheme('light')).not.toThrow();
  });
});

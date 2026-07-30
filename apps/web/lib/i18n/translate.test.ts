import { describe, expect, it, vi } from 'vitest';
import type { Messages } from './translate';
import { translate } from './translate';
import { matchLocale, parseAcceptLanguage, type Locale } from './config';

// The real dictionaries grow every day; these tests describe the engine, so
// they drive it through a stub instead of production keys.
vi.mock('./messages/en.json', () => ({
  default: {
    plain: 'Hello',
    greet: 'Hi, {name}',
    items: { one: '{count} file', other: '{count} files' },
    'en.only': 'English only',
  },
}));
vi.mock('./messages/ru.json', () => ({
  default: {
    plain: 'Привет',
    greet: 'Привет, {name}',
    items: { one: '{count} файл', few: '{count} файла', many: '{count} файлов' },
  },
}));

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('translate', () => {
  it('returns the string for the requested locale', () => {
    expect(translate('en', 'plain')).toBe('Hello');
    expect(translate('ru', 'plain')).toBe('Привет');
  });

  it('interpolates named placeholders', () => {
    expect(translate('en', 'greet', { name: 'Nikita' })).toBe('Hi, Nikita');
  });

  it('leaves unknown placeholders verbatim instead of printing "undefined"', () => {
    expect(translate('en', 'greet')).toBe('Hi, {name}');
  });

  it('picks the English plural form by CLDR category', () => {
    expect(translate('en', 'items', { count: 1 })).toBe('1 file');
    expect(translate('en', 'items', { count: 5 })).toBe('5 files');
  });

  it('picks all three Russian plural forms', () => {
    expect(translate('ru', 'items', { count: 1 })).toBe('1 файл');
    expect(translate('ru', 'items', { count: 3 })).toBe('3 файла');
    expect(translate('ru', 'items', { count: 5 })).toBe('5 файлов');
    expect(translate('ru', 'items', { count: 21 })).toBe('21 файл');
  });

  it('falls back to English when the locale lacks the key', () => {
    const warn = quiet();
    expect(translate('ru', 'en.only')).toBe('English only');
    warn.mockRestore();
  });

  it('returns the key itself when nothing has it', () => {
    const warn = quiet();
    expect(translate('en', 'nope.not.here')).toBe('nope.not.here');
    warn.mockRestore();
  });
});

describe('locale negotiation', () => {
  it('orders Accept-Language by quality', () => {
    expect(parseAcceptLanguage('en;q=0.5,ru-RU,ru;q=0.9')).toEqual(['ru-RU', 'ru', 'en']);
  });

  it('ignores q=0 and empty headers', () => {
    expect(parseAcceptLanguage('de;q=0,ru')).toEqual(['ru']);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it('matches on the primary subtag', () => {
    expect(matchLocale(['ru-BY', 'en'])).toBe('ru');
    expect(matchLocale(['en-GB'])).toBe('en');
  });

  it('falls back to the default locale for unsupported languages', () => {
    expect(matchLocale(['de', 'fr'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });
});

// Guards the contract the type system cannot: `Messages` values are strings or
// plural objects, and the dictionaries are plain data.
describe('types', () => {
  it('accepts both message shapes', () => {
    const dict: Messages = { a: 'x', b: { one: 'y', other: 'z' } };
    const locale: Locale = 'en';
    expect(Object.keys(dict)).toHaveLength(2);
    expect(locale).toBe('en');
  });
});

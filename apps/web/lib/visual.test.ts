// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { avatarGradient, avatarStyle, randomCallsign } from './avatar';
import { DEFAULT_CHANNELS, DEFAULT_SERVERS, MAIN_SERVER_ID } from './constants';
import { fmtBytes, fmtClock } from './format';
import { seedGradient } from './gradient';
import { serverGradient, serverInitials } from './server-visual';
import { THEME_INIT_SCRIPT, applyTheme, getTheme, setTheme } from './theme';
import { cn } from './utils';

/**
 * Оформление и мелкие утилиты. Требование ко всему разделу одно: цвет человека
 * и сервера обязан быть стабильным. Плавающий градиент — это не «мелочь
 * оформления», а невозможность узнать собеседника в списке.
 */

describe('градиенты', () => {
  it('один seed — всегда один цвет', () => {
    expect(seedGradient('Аня')).toBe(seedGradient('Аня'));
    expect(serverGradient('srv-1')).toBe(seedGradient('srv-1'));
  });

  it('палитра холодная и узкая: разные seed попадают в те же восемь пар', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(seedGradient(`seed-${i}`));
    expect(seen.size).toBe(8);
    for (const g of seen)
      expect(g).toMatch(/^linear-gradient\(140deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  });

  it('пустой seed не роняет — берём заглушку', () => {
    expect(seedGradient('')).toBe(seedGradient('?'));
  });
});

describe('аватар', () => {
  it('свой хвост «(вы)» цвет не меняет — на любом языке', () => {
    const base = avatarGradient('Аня');
    expect(avatarGradient('Аня (вы)')).toBe(base);
    expect(avatarGradient('Аня (you)')).toBe(base);
    expect(avatarGradient('Аня  (вы) ')).toBe(base);
  });

  it('срезается только хвост: скобки в середине имени — часть seed', () => {
    expect(avatarGradient('Аня (вы) Б')).toBe(seedGradient('Аня (вы) Б'));
    expect(avatarGradient('(вы) Аня')).toBe(seedGradient('(вы) Аня'));
  });

  it('имя из одних скобок не оставляет пустой seed', () => {
    expect(avatarGradient('(вы)')).toBe(seedGradient('?'));
  });

  it('стиль — это тот же градиент фоном', () => {
    expect(avatarStyle('Аня')).toEqual({ background: avatarGradient('Аня') });
  });

  it('подсказка имени — слово из словаря и двузначное число', () => {
    for (let i = 0; i < 20; i++) expect(randomCallsign()).toMatch(/^.+-\d{2}$/);
  });
});

describe('инициалы сервера', () => {
  it('одно слово — две буквы, два слова — по первой', () => {
    expect(serverInitials('relay')).toBe('RE');
    expect(serverInitials('Мой сервер')).toBe('МС');
    expect(serverInitials('a b c')).toBe('AB');
  });

  it('кавычки не попадают в инициалы', () => {
    expect(serverInitials('«Мой сервер»')).toBe('МС');
    expect(serverInitials('"relay"')).toBe('RE');
  });

  it('пустое имя — вопрос, а не пустая плашка', () => {
    expect(serverInitials('')).toBe('?');
    expect(serverInitials('   ')).toBe('?');
  });
});

describe('форматирование', () => {
  it('размер файла растёт по единицам, а не в голых байтах', () => {
    expect(fmtBytes(512)).toMatch(/512/);
    expect(fmtBytes(2048)).toMatch(/2/);
    expect(fmtBytes(5 * 1024 * 1024)).toMatch(/5/);
  });

  it('ноль — это ноль, а не пусто; отсутствие — пусто', () => {
    expect(fmtBytes(0)).not.toBe('');
    expect(fmtBytes(undefined)).toBe('');
  });

  it('время сообщения — часы и минуты', () => {
    expect(fmtClock(Date.UTC(2026, 0, 2, 3, 4))).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(fmtClock()).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});

describe('cn', () => {
  it('схлопывает конфликтующие утилиты Tailwind — побеждает последняя', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('пропускает пустое и условное', () => {
    expect(cn('a', undefined, null, false, 'b')).toBe('a b');
  });
});

describe('тема', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('по умолчанию тёмная — историческая тема relay', () => {
    expect(getTheme()).toBe('dark');
  });

  it('выбор сохраняется и применяется сразу', () => {
    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('мусор в хранилище читается как тёмная, а не как «нет темы»', () => {
    localStorage.setItem('relay-theme', 'неоновая');
    expect(getTheme()).toBe('dark');
  });

  it('применение темы ничего не пишет в хранилище', () => {
    applyTheme('light');
    expect(localStorage.getItem('relay-theme')).toBeNull();
  });

  it('инлайн-скрипт ставит атрибут до первой отрисовки и переживает отказ хранилища', () => {
    localStorage.setItem('relay-theme', 'light');
    // Тот самый код, что уезжает в <head>.
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });
    expect(() => new Function(THEME_INIT_SCRIPT)()).not.toThrow();
  });
});

describe('сид реестра', () => {
  it('совпадает с дефолтами сервера — иначе до первого события врём человеку', () => {
    expect(MAIN_SERVER_ID).toBe('relay-main');
    expect(DEFAULT_SERVERS).toEqual([{ id: MAIN_SERVER_ID, name: 'relay', removable: false }]);
    expect(DEFAULT_CHANNELS.map((c) => c.slug)).toEqual([
      'obshchii',
      'voice-obshchii',
      'voice-obshchii-sfu',
    ]);
    // Ни один дефолтный канал не удаляется и не переименовывается.
    expect(DEFAULT_CHANNELS.every((c) => c.removable === false)).toBe(true);
    expect(DEFAULT_CHANNELS.every((c) => c.serverId === MAIN_SERVER_ID)).toBe(true);
    // Один голосовой через медиасервер — чтобы разницу можно было услышать.
    expect(DEFAULT_CHANNELS.filter((c) => c.mode === 'sfu').map((c) => c.slug)).toEqual([
      'voice-obshchii-sfu',
    ]);
  });
});

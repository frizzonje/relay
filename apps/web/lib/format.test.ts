import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtSince } from './format';

/**
 * «Был в сети…» в списке устройств. Проверяется выбор единицы: час, показанный
 * тремя тысячами секунд, формально верен и совершенно нечитаем, а «через
 * 5 минут» вместо «5 минут назад» — это перепутанный знак, который в списке
 * устройств выглядит как чужой вход из будущего.
 */

afterEach(() => {
  vi.useRealTimers();
});

function at(iso: string, now: string): string {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(now));
  return fmtSince(iso);
}

describe('сколько времени прошло', () => {
  it('берёт самую крупную подходящую единицу', () => {
    expect(at('2026-08-14T09:00:00Z', '2026-08-14T09:00:30Z')).toMatch(/second|секунд/);
    expect(at('2026-08-14T09:00:00Z', '2026-08-14T09:05:00Z')).toMatch(/minute|минут/);
    expect(at('2026-08-14T09:00:00Z', '2026-08-14T12:00:00Z')).toMatch(/hour|час/);
    expect(at('2026-08-01T09:00:00Z', '2026-08-14T09:00:00Z')).toMatch(/day|дн|дней/);
  });

  it('прошедшее — в прошлом', () => {
    // Знак наоборот превратил бы «был вчера» в «будет завтра».
    expect(at('2026-08-13T09:00:00Z', '2026-08-14T09:00:00Z')).not.toMatch(/in |через/);
  });

  it('пустое остаётся пустым, а не «Invalid Date»', () => {
    // Устройство, ни разу не входившее, приходит с `null` — и подпись ему даёт
    // экран, а не эта функция.
    expect(fmtSince(null)).toBe('');
    expect(fmtSince(undefined)).toBe('');
    expect(fmtSince('позавчера')).toBe('');
  });
});

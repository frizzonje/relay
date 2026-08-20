import { describe, expect, it } from 'vitest';
import { gradeQuality, kbps, limitReason, pingGrade } from './quality';

/**
 * Арифметика «палочек качества». Она общая для обоих транспортов нарочно:
 * расходись пороги — одни и те же четыре палочки означали бы в mesh и в SFU
 * разное, и человек не смог бы сравнить режимы, ради чего оба и держатся.
 */

describe('gradeQuality', () => {
  it('потери решают раньше задержки — они рвут голос сильнее', () => {
    expect(gradeQuality(10, 10)).toBe('bad');
    expect(gradeQuality(10, 4)).toBe('weak');
    expect(gradeQuality(10, 1)).toBe('good');
    expect(gradeQuality(10, 0)).toBe('strong');
  });

  it('высокий RTT опускает класс и без потерь', () => {
    expect(gradeQuality(400, 0)).toBe('bad');
    expect(gradeQuality(250, 0)).toBe('weak');
    expect(gradeQuality(130, 0)).toBe('good');
    expect(gradeQuality(129, 0)).toBe('strong');
  });

  it('нет данных о RTT — судим по одним потерям, а не выдаём «плохо»', () => {
    expect(gradeQuality(null, 0)).toBe('strong');
    expect(gradeQuality(null, 9)).toBe('bad');
  });
});

describe('limitReason', () => {
  it('нехватку канала и нехватку процессора различаем — лечатся они разным', () => {
    expect(limitReason('bandwidth')).toBe('bandwidth');
    expect(limitReason('cpu')).toBe('cpu');
  });

  it('всё прочее — «всё в порядке»', () => {
    for (const r of ['none', 'other', '', undefined]) expect(limitReason(r), String(r)).toBe('ok');
  });
});

describe('kbps', () => {
  it('переводит байты за интервал в килобиты в секунду', () => {
    // 125000 байт за секунду = 1000 кбит/с
    expect(kbps(125_000, 0, 1000)).toBe(1000);
  });

  it('сброс счётчика при ренеготиации даёт 0, а не отрицательный битрейт', () => {
    expect(kbps(100, 5000, 1000)).toBe(0);
  });

  it('нулевой интервал — нет данных, а не деление на ноль', () => {
    expect(kbps(1000, 0, 0)).toBeNull();
    expect(kbps(1000, 0, -5)).toBeNull();
  });
});

describe('pingGrade', () => {
  it('три ступени окраски пинга', () => {
    expect(pingGrade(50)).toBe('good');
    expect(pingGrade(80)).toBe('mid');
    expect(pingGrade(199)).toBe('mid');
    expect(pingGrade(200)).toBe('bad');
  });
});

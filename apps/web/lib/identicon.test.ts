import { describe, expect, it } from 'vitest';
import { GRID, identiconOf } from './identicon';

/**
 * Identicon существует ради одного: чтобы подмена человека была заметна
 * боковым зрением. Значит проверять надо не «рисуется ли что-то», а что
 * рисунок стабилен во времени и разъезжается от чужого ключа.
 */

const A = '6668-7aad-f862-bd77';
const B = '16cc-cc1a-be5a-3301';

describe('стабильность', () => {
  it('один отпечаток — один рисунок', () => {
    expect(identiconOf(A)).toEqual(identiconOf(A));
  });

  it('разделители в отпечатке ничего не меняют', () => {
    // Один и тот же ключ может приехать и с дефисами, и без — рисунок обязан
    // остаться тем же, иначе человек «сменится» на ровном месте.
    expect(identiconOf(A)).toEqual(identiconOf(A.replace(/-/g, '')));
    expect(identiconOf(A)).toEqual(identiconOf(A.toUpperCase()));
  });

  it('сетка всегда полная', () => {
    expect(identiconOf(A).cells).toHaveLength(GRID * GRID);
  });
});

describe('различимость', () => {
  it('другой ключ — другой рисунок', () => {
    expect(identiconOf(A).cells).not.toEqual(identiconOf(B).cells);
  });

  it('участвует весь отпечаток, а не первые байты', () => {
    // Так и было в первой версии: клетки читали два байта из восьми, и
    // отпечаток вида `ffff-…` давал сплошной квадрат, одинаковый у всех, чьи
    // ключи начинались одинаково.
    const base = 'aaaa-bbbb-cccc-dddd';
    const tail = 'aaaa-bbbb-cccc-ddde';
    expect(identiconOf(base)).not.toEqual(identiconOf(tail));
    expect(identiconOf('ffff-0000-1234-5678').cells.every(Boolean)).toBe(false);
  });

  it('на тысяче ключей рисунки не схлопываются', () => {
    // Единственная проверка, которая ловит вырождение вообще: если рисунок
    // выводится не из всего, что дали, — здесь это видно как рой повторов.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const print = Array.from({ length: 8 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0'),
      ).join('');
      const { cells, color } = identiconOf(print);
      seen.add(cells.map((c) => (c ? '1' : '0')).join('') + color);
    }
    // Силуэтов 2^15, цветов 256 — на тысяче образцов совпадений почти не бывает.
    expect(seen.size).toBeGreaterThan(950);
  });

  it('закрашено примерно поровну — не пятно и не решето', () => {
    let filled = 0;
    const runs = 200;
    for (let i = 0; i < runs; i += 1) {
      const print = Array.from({ length: 8 }, () =>
        Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0'),
      ).join('');
      filled += identiconOf(print).cells.filter(Boolean).length;
    }
    const share = filled / (runs * GRID * GRID);
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.65);
  });
});

describe('форма', () => {
  it('симметрична по вертикали — силуэт, а не 25 точек', () => {
    const { cells } = identiconOf(A);
    for (let row = 0; row < GRID; row += 1)
      for (let col = 0; col < GRID; col += 1)
        expect(cells[row * GRID + col]).toBe(cells[row * GRID + (GRID - 1 - col)]);
  });

  it('у настоящих ключей — не пустая и не сплошная', () => {
    // Обе крайности читаются как «ошибка загрузки», а не как человек. Ровно
    // одного отпечатка из 2^64 это не гарантирует, и не должно: сплошной
    // квадрат — такой же законный силуэт, как любой другой.
    for (const print of [A, B]) {
      const filled = identiconOf(print).cells.filter(Boolean).length;
      expect(filled).toBeGreaterThan(0);
      expect(filled).toBeLessThan(GRID * GRID);
    }
  });
});

describe('кривой ввод', () => {
  it('пустой отпечаток — пустая сетка, а не падение', () => {
    // Рисуется на каждое сообщение в ленте: уронить её из-за одной строки
    // было бы обменом несоразмерным.
    expect(identiconOf('').cells.every((c) => !c)).toBe(true);
    expect(identiconOf('---').cells).toHaveLength(GRID * GRID);
    expect(identiconOf('зззз').cells.every((c) => !c)).toBe(true);
  });
});

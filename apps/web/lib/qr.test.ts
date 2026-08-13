import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import { qrPath } from './qr';

/**
 * Кодировщик тут чужой и проверять его незачем. Проверяется наше: превращение
 * матрицы в один путь SVG. Ошибка в нём выглядит как «код не читается ни одной
 * камерой», а поймать её глазами нельзя — квадратики выглядят одинаково
 * правдоподобно и правильные, и сдвинутые на модуль.
 *
 * Поэтому путь разбирается обратно в матрицу и сверяется с исходной.
 */

/** `M x yh<n>v1h-<n>z` → назад в клетки. */
function matrixOf(path: string, size: number): boolean[][] {
  const cells = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const [, from, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(run); i += 1) cells[Number(y)][Number(from) + i] = true;
  }
  return cells;
}

const TEXT = 'https://relay.example/#pair=428913';

describe('QR как путь', () => {
  it('описывает ровно ту же матрицу, что и кодировщик', () => {
    const source = encode(TEXT, { border: 4, ecc: 'M' });
    const { size, path } = qrPath(TEXT);

    expect(size).toBe(source.size);
    expect(matrixOf(path, size)).toEqual(source.data);
  });

  it('поля на месте — без них сканер не находит код', () => {
    // Четыре модуля тишины по краю требует стандарт, и это не отступ ради вида.
    const { size, path } = qrPath(TEXT);
    const cells = matrixOf(path, size);
    for (let i = 0; i < 4; i += 1) {
      expect(cells[i].some(Boolean)).toBe(false);
      expect(cells[size - 1 - i].some(Boolean)).toBe(false);
      expect(cells.every((row) => !row[i] && !row[size - 1 - i])).toBe(true);
    }
  });

  it('соседние модули строки слиты в один прямоугольник', () => {
    // Иначе путь распухает в тысячи команд на каждый код.
    const { path } = qrPath(TEXT);
    expect(path).toMatch(/h[2-9]/);
  });

  it('один и тот же текст даёт один и тот же код', () => {
    expect(qrPath(TEXT)).toEqual(qrPath(TEXT));
  });

  it('разный текст — разный код', () => {
    expect(qrPath(TEXT).path).not.toBe(qrPath('https://relay.example/#pair=000000').path);
  });
});

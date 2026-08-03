import { describe, expect, it } from 'vitest';
import { percent, smoothPath, sparkPoints, splitUptime, toBytes, type SparkPoint } from './metrics';

/**
 * Чистая часть панели состояния сервера. Проверяем ровно те места, где панель
 * может соврать: округление процентов, единицы байтов, разбор аптайма и
 * раскладку спарклайна.
 */

describe('percent', () => {
  it('считает долю в целых процентах', () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(3, 4)).toBe(75);
  });

  it('нулевой или отрицательный объём — null, а не деление на ноль', () => {
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, -1)).toBeNull();
  });

  it('не выходит за 0..100 даже на кривых данных', () => {
    expect(percent(10, 4)).toBe(100);
    expect(percent(-10, 4)).toBe(0);
  });
});

describe('toBytes', () => {
  it('шагает по 1024, а не по 1000 — это память, а не диск из магазина', () => {
    expect(toBytes(1024)).toEqual({ value: 1, unit: 'kb' });
    expect(toBytes(1000)).toEqual({ value: 1000, unit: 'b' });
  });

  it('десятая доля только там, где она читается', () => {
    expect(toBytes(3.4 * 1024 ** 3)).toEqual({ value: 3.4, unit: 'gb' });
    expect(toBytes(340 * 1024 ** 2)).toEqual({ value: 340, unit: 'mb' });
  });

  it('не уезжает выше терабайт', () => {
    expect(toBytes(5 * 1024 ** 5).unit).toBe('tb');
  });

  it('мусор на входе — нули, а не NaN на экране', () => {
    expect(toBytes(Number.NaN)).toEqual({ value: 0, unit: 'b' });
    expect(toBytes(-1)).toEqual({ value: 0, unit: 'b' });
  });
});

describe('splitUptime', () => {
  it('раскладывает секунды на дни, часы, минуты и секунды', () => {
    expect(splitUptime(12 * 86400 + 4 * 3600 + 31 * 60 + 7)).toEqual({
      days: 12,
      hours: 4,
      minutes: 31,
      seconds: 7,
    });
  });

  it('дробные секунды отбрасывает вниз — часы не должны прыгать вперёд', () => {
    expect(splitUptime(59.9).seconds).toBe(59);
  });

  it('отрицательное и мусор — нули', () => {
    expect(splitUptime(-5)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(splitUptime(Number.NaN).seconds).toBe(0);
  });
});

describe('sparkPoints', () => {
  it('свежие замеры ставит у правого края', () => {
    expect(sparkPoints([0, 50, 100], 3)).toEqual([
      { x: 0, y: 100 },
      { x: 1, y: 50 },
      { x: 2, y: 0 },
    ]);
  });

  it('неполную историю не дорисовывает нулями — линия начинается правее', () => {
    expect(sparkPoints([25], 4)).toEqual([{ x: 3, y: 75 }]);
  });

  it('один замер сверх окна оставляет за левым краем — линии есть на чём ползти', () => {
    expect(sparkPoints([1, 2, 3, 4, 5], 2)).toEqual([
      { x: -1, y: 97 },
      { x: 0, y: 96 },
      { x: 1, y: 95 },
    ]);
  });

  it('дальше одного запаса влево не тянет', () => {
    expect(sparkPoints([1, 2, 3, 4, 5], 3).map((p) => p.x)).toEqual([-1, 0, 1, 2]);
  });

  it('значения за пределами шкалы прижимает к краям', () => {
    expect(sparkPoints([-20, 140], 2)).toEqual([
      { x: 0, y: 100 },
      { x: 1, y: 0 },
    ]);
  });

  it('пустая история и нулевое окно — пусто, без падения', () => {
    expect(sparkPoints([], 8)).toEqual([]);
    expect(sparkPoints([1, 2], 0)).toEqual([]);
  });
});

/** Разбор `d` на сегменты: начальная точка и кубики `C c1 c2 end`. */
function segments(
  d: string,
): { from: SparkPoint; c1: SparkPoint; c2: SparkPoint; to: SparkPoint }[] {
  const n = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const out = [];
  let from = { x: n[0], y: n[1] };
  for (let i = 2; i + 5 < n.length; i += 6) {
    const to = { x: n[i + 4], y: n[i + 5] };
    out.push({ from, c1: { x: n[i], y: n[i + 1] }, c2: { x: n[i + 2], y: n[i + 3] }, to });
    from = to;
  }
  return out;
}

describe('smoothPath', () => {
  it('проходит ровно через замеры, а не мимо них', () => {
    const points = sparkPoints([10, 40, 25, 90], 4);
    const segs = segments(smoothPath(points));
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.to)).toEqual(points.slice(1));
    expect(segs[0].from).toEqual(points[0]);
  });

  it('на всплеске не перелетает за соседние замеры — иначе рисовали бы выдуманную загрузку', () => {
    for (const s of segments(smoothPath(sparkPoints([10, 10, 90, 10, 10], 5)))) {
      const lo = Math.min(s.from.y, s.to.y);
      const hi = Math.max(s.from.y, s.to.y);
      for (const c of [s.c1, s.c2]) {
        expect(c.y).toBeGreaterThanOrEqual(lo);
        expect(c.y).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('ровная загрузка — ровная линия, без волн', () => {
    const d = smoothPath(sparkPoints([30, 30, 30], 3));
    for (const s of segments(d)) {
      expect([s.c1.y, s.c2.y, s.to.y]).toEqual([70, 70, 70]);
    }
  });

  it('пусто и один замер — не падает и не рисует лишнего', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 2, y: 30 }])).toBe('M 2 30');
  });
});

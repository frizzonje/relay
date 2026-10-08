import { describe, expect, it } from 'vitest';
import { WindowCounter } from './window-counter';

describe('WindowCounter', () => {
  it('считает события в окне и начинает заново после него', () => {
    const c = new WindowCounter(1000);
    expect(c.hit('ip', 0)).toBe(1);
    expect(c.hit('ip', 500)).toBe(2);
    expect(c.count('ip', 1000)).toBe(2); // граница окна ещё внутри
    expect(c.count('ip', 1001)).toBe(0);
    expect(c.hit('ip', 1001)).toBe(1);
  });

  it('ключи считаются порознь, clear снимает счёт', () => {
    const c = new WindowCounter(1000);
    c.hit('a', 0);
    c.hit('a', 0);
    c.hit('b', 0);
    c.clear('a');
    expect(c.count('a', 0)).toBe(0);
    expect(c.count('b', 0)).toBe(1);
  });

  it('разросшаяся карта забывает протухшее сама', () => {
    const c = new WindowCounter(10, 2);
    c.hit('old-1', 0);
    c.hit('old-2', 0);
    c.hit('fresh', 100); // третий ключ сверх потолка — уборка
    expect(c.count('old-1', 5)).toBe(0); // протух и убран, а не просто «закрыт»
    expect(c.count('fresh', 100)).toBe(1);
  });
});

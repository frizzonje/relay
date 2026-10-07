import { describe, expect, it } from 'vitest';
import { refill } from './token-bucket';

describe('refill', () => {
  it('первое ведро — полное', () => {
    expect(refill(undefined, 5, 1, 1000)).toEqual({ tokens: 5, ts: 1000 });
  });

  it('доливает за прошедшее время, не выше ёмкости', () => {
    const b = { tokens: 1, ts: 0 };
    expect(refill(b, 5, 2, 1000).tokens).toBe(3);
    expect(refill(b, 5, 2, 10_000).tokens).toBe(5);
  });

  it('меняет ведро на месте — владелец держит то же самое', () => {
    const b = { tokens: 0, ts: 0 };
    expect(refill(b, 5, 1, 2000)).toBe(b);
    expect(b).toEqual({ tokens: 2, ts: 2000 });
  });

  it('из минуса выходит тем же темпом', () => {
    expect(refill({ tokens: -4, ts: 0 }, 10, 2, 1000).tokens).toBe(-2);
  });
});

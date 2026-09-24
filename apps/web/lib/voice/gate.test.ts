import { describe, expect, it } from 'vitest';
import { nextGate } from './gate';

const HOLD = 250;
const at = (now: number, level: number, openUntil = 0, threshold = 0.5) =>
  nextGate({ level, threshold, now, openUntil, holdMs: HOLD });

describe('nextGate', () => {
  it('порог 0 — затвор открыт всегда, что бы ни было с уровнем', () => {
    expect(at(1000, 0, 0, 0)).toEqual({ open: true, openUntil: 0 });
  });

  it('тише порога — закрыт', () => {
    expect(at(1000, 0.1).open).toBe(false);
  });

  it('громче порога — открыт и держится ещё HOLD', () => {
    expect(at(1000, 0.8)).toEqual({ open: true, openUntil: 1000 + HOLD });
  });

  it('ровно на пороге — открыт: порог — это «с этого уровня слышно»', () => {
    expect(at(1000, 0.5).open).toBe(true);
  });

  it('после спада держится до openUntil и закрывается ровно на нём', () => {
    expect(at(1200, 0.1, 1250)).toEqual({ open: true, openUntil: 1250 });
    expect(at(1250, 0.1, 1250)).toEqual({ open: false, openUntil: 1250 });
  });
});

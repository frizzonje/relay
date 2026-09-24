/**
 * Затвор порога микрофона — одно решение без побочных эффектов: открыт ли он
 * сейчас и до какого момента держится. Всё, что затвор делает с дорожкой, живёт
 * в mic.ts; здесь только арифметика, поэтому её и можно проверить без браузера.
 *
 * Уровень и порог — в шкале метра (0..1). Порог 0 — затвора нет. Громче порога
 * — открыт и держится ещё `holdMs` после спада, чтобы хвосты слов не рубило.
 */
export interface GateState {
  open: boolean;
  /** До какого момента (performance.now) затвор держится открытым. */
  openUntil: number;
}

export function nextGate(input: {
  level: number;
  threshold: number;
  now: number;
  openUntil: number;
  holdMs: number;
}): GateState {
  if (input.threshold <= 0) return { open: true, openUntil: 0 };
  const openUntil = input.level >= input.threshold ? input.now + input.holdMs : input.openUntil;
  return { open: input.now < openUntil, openUntil };
}

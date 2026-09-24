/**
 * Порядок mid — то, по чему relay отличает голос от звука демонстрации: микрофон
 * добавляется первым, звук экрана — позже, значит у голоса mid меньше. Правилом
 * пользуются двое — микшер (output.ts) и RED (mesh/red.ts), — и разойтись им
 * нельзя: иначе избыточность достанется музыке, а громкость голоса — показу.
 *
 * Числовые mid («0», «1», …) — по значению, иначе лексикографически.
 */
export function cmpMid(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

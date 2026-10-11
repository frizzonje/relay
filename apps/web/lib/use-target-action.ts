'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Действие диалога над целью, которое ждёт ответа сервера: удалить канал или
 * сервер, переименовать. Пока оно летит, окно закрывают (Esc, клик мимо — их
 * «занято» не держит) и открывают на другой цели. Ответ про прежнюю цель не
 * закрывает новое окно и не снимает его «занято»: решение принято о том, что
 * человек уже не видит.
 */
export function useTargetAction<T>(target: T | null) {
  const [busy, setBusy] = useState(false);
  const current = useRef(target);
  current.current = target;

  // Каждая новая цель начинается не занятой.
  useEffect(() => setBusy(false), [target]);

  const run = useCallback(async (act: (target: T) => Promise<boolean>, done: () => void) => {
    const mine = current.current;
    if (mine === null) return;
    setBusy(true);
    const ok = await act(mine);
    if (current.current !== mine) return;
    setBusy(false);
    if (ok) done();
  }, []);

  return { busy, run };
}

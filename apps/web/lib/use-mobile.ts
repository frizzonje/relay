'use client';

import { useEffect, useState } from 'react';

/** Брейкпоинт `md` Tailwind: ниже него каркас показывает по одной панели. */
const NARROW = '(max-width: 767px)';

/**
 * Узкий экран — та же граница, что у `max-md:` в разметке. Нужен там, где одной
 * вёрстки мало: анимации панелей ставятся из JS и на десктопе, где все колонки
 * видны разом, их включать нельзя.
 *
 * До гидрации отвечает `false`: сервер про ширину окна не знает, а лишний кадр
 * без анимации незаметнее, чем прыжок раскладки.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return mobile;
}

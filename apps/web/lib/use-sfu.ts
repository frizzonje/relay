'use client';

import { useEffect, useState } from 'react';
import { isSfuAvailable } from '@/lib/config';

/**
 * Поднят ли медиасервер (профиль `sfu`). Пока ответ не пришёл — `false`:
 * недоступный режим лучше показать выключенным и включить, когда выяснится,
 * чем предложить и тут же отобрать. Запрос к `/api/config` кэширован на
 * сессию, так что хук можно звать из скольких угодно мест.
 */
export function useSfuAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void isSfuAvailable().then((v) => {
      if (alive) setAvailable(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

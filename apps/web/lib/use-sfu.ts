'use client';

import { useEffect, useState } from 'react';
import { getRetentionDays, isSfuAvailable } from '@/lib/config';

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

/**
 * Срок хранения переписки в днях (0 — не показывать). Тот же кэшированный
 * запрос, что и у медиасервера: конфиг тянется один раз на сессию.
 */
export function useRetentionDays(): number {
  const [days, setDays] = useState(0);
  useEffect(() => {
    let alive = true;
    void getRetentionDays().then((v) => {
      if (alive) setDays(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return days;
}

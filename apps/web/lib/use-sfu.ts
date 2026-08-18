'use client';

import { useEffect, useState } from 'react';
import type { RetentionMode } from '@relay/shared';
import { getRetention, isSfuAvailable } from '@/lib/config';

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
 * Что инсталляция делает с историей — срок в днях и сам режим. Тот же
 * кэшированный запрос, что и у медиасервера: конфиг тянется раз на сессию.
 */
export function useRetention(): { days: number; mode: RetentionMode } {
  const [state, setState] = useState<{ days: number; mode: RetentionMode }>({
    // До ответа сервера — «без срока»: это единственный вариант, при котором
    // интерфейс не обещает ничего. Ошибись мы в другую сторону, край ленты на
    // мгновение объявил бы удалённым то, что цело.
    days: 0,
    mode: 'forever',
  });
  useEffect(() => {
    let alive = true;
    void getRetention().then((v) => {
      if (alive) setState(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

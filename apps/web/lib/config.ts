import type { ConfigResponse, IceServer, RetentionMode } from '@relay/shared';
import { guestTokenFromLocation } from './socket';

/**
 * Конфиг с бэка (`GET /api/config`): ICE-серверы (туда подставляются STUN/TURN
 * из окружения) и признак поднятого медиасервера. Тянем один раз и кэшируем на
 * сессию — обе половины нужны разным местам, но запрос один.
 */
const FALLBACK: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

let cache: Promise<ConfigResponse> | null = null;

function fetchConfig(): Promise<ConfigResponse> {
  const base = process.env.NEXT_PUBLIC_API_URL || '';
  // У гостя куки нет — он предъявляет инвайт-токен. Без этого конфиг отвечал
  // 401, гость оставался на публичном STUN и за строгим NAT сидел без звука.
  const guest = guestTokenFromLocation();
  return fetch(`${base}/api/config`, {
    credentials: 'include',
    ...(guest ? { headers: { authorization: `Bearer ${guest}` } } : {}),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`config ${res.status}`);
      return res.json() as Promise<ConfigResponse>;
    })
    .catch((err) => {
      // Бэк недоступен — звонок всё равно должен собраться на публичном STUN,
      // а медиасервер считаем отсутствующим (фолбэк на p2p — рабочий путь).
      console.error('config fetch failed, using fallback STUN', err);
      // Неудачу не кэшируем: первый запрос случается и до входа, когда гейт
      // честно отвечает 401. Запомнить этот ответ на сессию значило бы навсегда
      // остаться без TURN и без срока хранения — уже после успешного входа.
      cache = null;
      return { iceServers: FALLBACK, sfu: { available: false } };
    });
}

function getConfig(): Promise<ConfigResponse> {
  if (!cache) cache = fetchConfig();
  return cache;
}

export async function getIceServers(): Promise<IceServer[]> {
  const data = await getConfig();
  return data.iceServers?.length ? data.iceServers : FALLBACK;
}

/** Поднят ли медиасервер (профиль `sfu`) — от этого зависит доступность режима. */
export async function isSfuAvailable(): Promise<boolean> {
  return (await getConfig()).sfu?.available === true;
}

/**
 * Что инсталляция делает с историей: сколько дней хранит, хранит ли без срока
 * или не хранит вовсе. Сервер прошлой версии режима не пришлёт — тогда судим
 * по дням, как раньше, а при полном молчании молчим и мы: не показать ничего
 * честнее, чем назвать выдуманный срок.
 */
export async function getRetention(): Promise<{ days: number; mode: RetentionMode }> {
  const data = await getConfig();
  const days =
    typeof data.retentionDays === 'number' && data.retentionDays > 0 ? data.retentionDays : 0;
  const mode = data.retentionMode ?? (days > 0 ? 'days' : 'forever');
  return { days, mode };
}

/**
 * Версия сервера. Пустая строка — инсталляция собрана из исходников, номера у
 * неё нет; сервер прошлой версии поля не пришлёт вовсе, и это тот же случай.
 */
export async function getServerVersion(): Promise<string> {
  const v = (await getConfig()).version;
  return typeof v === 'string' ? v.trim() : '';
}

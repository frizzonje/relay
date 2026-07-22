import type { ConfigResponse, IceServer } from '@relay/shared';
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

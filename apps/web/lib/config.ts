import type { ConfigResponse, IceServer, RetentionMode } from '@relay/shared';
import { guestTokenFromLocation } from './socket';

/**
 * Конфиг с бэка (`GET /api/config`): ICE-серверы (туда подставляются STUN/TURN
 * из окружения) и признак поднятого медиасервера. Кэшируем — обе половины
 * нужны разным местам, но запрос один. Кэш не вечный: у ответа два срока
 * годности, и оба ниже.
 */
const FALLBACK: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

let cache: Promise<ConfigResponse> | null = null;

/**
 * Когда протухнут выданные нам учётки TURN (unix-секунды). `Infinity` — либо
 * TURN статический, либо его нет: тогда конфиг не портится со временем и
 * перечитывать его незачем.
 */
let iceValidUntil = Number.POSITIVE_INFINITY;

/**
 * За сколько до конца срока идём за новой парой. Час-другой запаса нужен не
 * ради точности, а ради разговора: coturn проверяет срок и при продлении
 * аренды, поэтому пара, взятая на последней минуте, оборвала бы звонок посреди
 * фразы. Сутки жизни минус этот запас — всё ещё сутки.
 */
const ICE_REFRESH_MARGIN_SEC = 2 * 60 * 60;

/**
 * Верхний срок жизни кэша — на случай, когда в ответе поменялось не про TURN.
 * Медиасервер, поднятый после того как вкладку открыли, оставался выключенным
 * в интерфейсе до перезагрузки страницы (ревизия, «Мелкое, но чинить»): выдача
 * пропусков живость проверяла, а переключатель врал. Запроса это не стоит
 * почти никогда — конфиг перечитывается лениво, когда его спросят, а спрашивают
 * его при входе в канал и в About.
 */
const CACHE_MAX_AGE_SEC = 10 * 60;

/** Когда ответ приехал (unix-секунды). */
let fetchedAt = 0;

function fetchConfig(): Promise<ConfigResponse> {
  const base = process.env.NEXT_PUBLIC_API_URL || '';
  // У гостя куки нет — он предъявляет инвайт-токен. Без этого конфиг отвечал
  // 401, гость оставался на публичном STUN и за строгим NAT сидел без звука.
  const guest = guestTokenFromLocation();
  return fetch(`${base}/api/config`, {
    credentials: 'include',
    ...(guest ? { headers: { authorization: `Bearer ${guest}` } } : {}),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`config ${res.status}`);
      const data = (await res.json()) as ConfigResponse;
      iceValidUntil = typeof data.iceExpiresAt === 'number' ? data.iceExpiresAt : Infinity;
      fetchedAt = Date.now() / 1000;
      return data;
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
  // Кэш на сессию — но у сессии теперь есть срок годности: учётки для TURN
  // выдаются на сутки и на каждого свои. Вкладка, открытая со вчера, иначе
  // звонила бы с просроченной парой — и не «с ошибкой», а молча мимо
  // ретранслятора, то есть без звука ровно там, где TURN и нужен.
  const now = Date.now() / 1000;
  if (
    cache &&
    (now >= iceValidUntil - ICE_REFRESH_MARGIN_SEC || now >= fetchedAt + CACHE_MAX_AGE_SEC)
  )
    cache = null;
  if (!cache) {
    iceValidUntil = Infinity;
    fetchedAt = now;
    cache = fetchConfig();
  }
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

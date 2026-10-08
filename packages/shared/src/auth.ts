import { fromBase64Url, toBase64Url } from './identity';

/**
 * Пропуск-кука relay — единый формат токена для Next и Nest.
 *
 * Токен: `${exp}.${base64url(HMAC-SHA256(key, exp))}`, где
 * key = 'relay-auth-v1:' + SITE_PASSWORD. Подпись завязана на пароль: смена
 * SITE_PASSWORD мгновенно делает все ранее выданные куки невалидными.
 *
 * Здесь же — гостевой инвайт и пропуск в медиасервер: все три токена relay
 * подписаны одинаково, HMAC-SHA256 в base64url на ключе «контекст + секрет».
 *
 * Формат живёт здесь один раз: сборка подписываемой части (`*Signed`) и разбор
 * предъявленного (`read*`) — чистые функции без криптографии. Подпись у сред
 * своя: Edge-runtime Next умеет только Web Crypto, и он асинхронный (функции
 * `issue*`/`verify*` ниже), а дверь сокета и http-гейт api, как и медиасервер,
 * подписывают синхронным `node:crypto` — лишний `await` у двери открыл бы окно
 * между проверкой и решением. Так у близнецов общий формат, а разный только
 * HMAC в одну строку.
 */

/** Имя куки-пропуска. */
export const AUTH_COOKIE = 'relay_pass';

/** Срок жизни пропуска — 30 дней. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Срок жизни гостевой инвайт-ссылки — 24 часа. */
export const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Контексты ключей: токен одного вида никогда не пройдёт как другой. */
export const SITE_KEY_CONTEXT = 'relay-auth-v1:';
export const GUEST_KEY_CONTEXT = 'relay-guest-v1:';
export const SFU_KEY_CONTEXT = 'relay-sfu-v1:';

/**
 * Разобранный токен: что было подписано, какая подпись предъявлена и что
 * токен несёт. Подпись ещё НЕ проверена — это дело среды (`safeEqual` от её
 * HMAC над `signed`); формат и срок — проверены.
 */
export interface ReadToken<T> {
  signed: string;
  sig: string;
  payload: T;
}

const encoder = new TextEncoder();

/** Сравнение строк за постоянное время (без раннего выхода по длине). */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Строка → base64url её utf8-байтов. */
function encodeText(text: string): string {
  return toBase64Url(encoder.encode(text));
}

/** Обратно: base64url → utf8-строка; битый ввод (и битый utf8) → null. */
function decodeText(b64: string): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(b64));
  } catch {
    return null;
  }
}

/** Срок из токена: конечное число и ещё не наступило. */
function alive(exp: number, now: number): boolean {
  return Number.isFinite(exp) && exp >= now;
}

// ── Пропуск сайта ────────────────────────────────────────────────────────
// `${exp}.${sig}`, подписан сам `exp`.

export function siteTokenSigned(exp: number): string {
  return String(exp);
}

export function readSiteToken(
  token: string | undefined,
  now = Date.now(),
): ReadToken<{ exp: number }> | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const exp = Number(token.slice(0, dot));
  if (!alive(exp, now)) return null;
  return { signed: siteTokenSigned(exp), sig: token.slice(dot + 1), payload: { exp } };
}

// ── Гостевой инвайт ──────────────────────────────────────────────────────
// `g2.<b64url(slug)>.<режим>.<exp>.<sig>`, подписан весь префикс. Токен несёт
// scope (какой войс-канал и на каких правах), а не просто «доступ», поэтому
// подпись и срок проверяются ДАЖЕ при пустом SITE_PASSWORD (в отличие от
// пропуска сайта). Смена пароля отзывает все инвайты, как и обычные куки.
//
// Режим — часть ПОДПИСАННОГО тела, и это главное в нём: «только слушать» у
// приглашения в канал закрытого сервера не может быть настройкой клиента,
// иначе оно снимается правкой ссылки. Версия g1 (без режима) продолжает
// проверяться: ссылки, розданные до этого правила, живут свои 24 часа.

/** Полезная нагрузка гостевого токена: слаг войс-канала, срок и права. */
export interface GuestTokenPayload {
  slug: string;
  exp: number;
  /** Гость только слушает: своё медиа отдавать не вправе (канал под паролем). */
  listen: boolean;
}

export function guestTokenSigned(slug: string, listen: boolean, exp: number): string {
  return `g2.${encodeText(slug)}.${listen ? 'listen' : 'talk'}.${exp}`;
}

export function readGuestToken(
  token: string | undefined,
  now = Date.now(),
): ReadToken<GuestTokenPayload> | null {
  if (!token) return null;
  const parts = token.split('.');
  // g2 — с режимом, g1 — ссылки прошлого формата (всегда с правом говорить).
  let listen = false;
  if (parts.length === 5) {
    if (parts[0] !== 'g2') return null;
    if (parts[2] !== 'listen' && parts[2] !== 'talk') return null;
    listen = parts[2] === 'listen';
  } else if (parts.length !== 4 || parts[0] !== 'g1') {
    return null;
  }
  const exp = Number(parts[parts.length - 2]);
  if (!alive(exp, now)) return null;
  const slug = decodeText(parts[1]);
  if (!slug) return null;
  return {
    signed: parts.slice(0, -1).join('.'),
    sig: parts[parts.length - 1],
    payload: { slug, exp, listen },
  };
}

// ── Пропуск в медиасервер ────────────────────────────────────────────────
// `s1.<b64url(JSON claims)>.<sig>`, подписан префикс. Выдаёт api, проверяет
// sfu: медиасервер не знает ни паролей, ни закрытых серверов — он сверяет
// подпись и пускает ровно в комнату из клейма.

export interface SfuClaims {
  /** Слаг голосового канала — единственная комната, куда пустят с этим токеном. */
  room: string;
  /** Id участника; совпадает с socket.id основного сигналинга, чтобы плитки сошлись. */
  peerId: string;
  /** Отображаемое имя (для presence внутри sfu, не для авторизации). */
  name: string;
  /**
   * Слушатель: пропуск даёт право принимать чужие дорожки, но не отдавать свои
   * (гость по инвайту в канал закрытого сервера). Кто именно слушатель, решает
   * api — медиасервер по этому клейму отказывает в `produce`.
   */
  listen: boolean;
  /** Unix-мс, после которых токен мёртв. */
  exp: number;
}

export function sfuTokenSigned({ room, peerId, name, listen, exp }: SfuClaims): string {
  // Клейм пишем только тем, кому он что-то запрещает: поле `listen: false` в
  // каждом токене — это лишний повод гадать, что значит его отсутствие.
  const claims = { room, peerId, name, ...(listen ? { listen: true } : {}), exp };
  return `s1.${encodeText(JSON.stringify(claims))}`;
}

export function readSfuToken(token: unknown, now = Date.now()): ReadToken<SfuClaims> | null {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 's1') return null;
  const json = decodeText(parts[1]);
  if (json === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const { room, peerId, name, listen, exp } = claims as Record<string, unknown>;
  if (typeof room !== 'string' || !room) return null;
  if (typeof peerId !== 'string' || !peerId) return null;
  if (typeof exp !== 'number' || !alive(exp, now)) return null;
  return {
    signed: `${parts[0]}.${parts[1]}`,
    sig: parts[2],
    payload: {
      room,
      peerId,
      name: typeof name === 'string' ? name : '',
      listen: listen === true,
      exp,
    },
  };
}

// ── Web Crypto: подпись для Next (Edge-runtime) ──────────────────────────

async function hmac(keyText: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
  );
}

/** Выдать новый токен (ставится в куку relay_pass при успешном логине). */
export async function issueToken(password: string): Promise<{ value: string; maxAgeMs: number }> {
  const signed = siteTokenSigned(Date.now() + TOKEN_TTL_MS);
  return {
    value: `${signed}.${await hmac(SITE_KEY_CONTEXT + password, signed)}`,
    maxAgeMs: TOKEN_TTL_MS,
  };
}

/**
 * Проверить токен из куки. Пустой пароль = авторизация выключена → пускаем
 * всех (как authEnabled() в Nest). Невалидная/просроченная подпись → false.
 */
export async function verifyToken(token: string | undefined, password: string): Promise<boolean> {
  if (!password) return true; // авторизация выключена
  const read = readSiteToken(token);
  return !!read && safeEqual(await hmac(SITE_KEY_CONTEXT + password, read.signed), read.sig);
}

/** Выдать гостевой токен на конкретный войс-канал (по умолчанию — на 24 часа). */
export async function issueGuestToken(
  slug: string,
  password: string,
  opts: { listen?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const signed = guestTokenSigned(
    slug,
    !!opts.listen,
    Date.now() + (opts.ttlMs ?? GUEST_TOKEN_TTL_MS),
  );
  return `${signed}.${await hmac(GUEST_KEY_CONTEXT + password, signed)}`;
}

/** Проверить гостевой токен: валидная подпись и срок → payload, иначе null. */
export async function verifyGuestToken(
  token: string | undefined,
  password: string,
): Promise<GuestTokenPayload | null> {
  const read = readGuestToken(token);
  if (!read) return null;
  const expected = await hmac(GUEST_KEY_CONTEXT + password, read.signed);
  return safeEqual(expected, read.sig) ? read.payload : null;
}

/** Разбор Cookie-заголовка в map (для middleware/handshake). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    try {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // битое значение куки — пропускаем
    }
  }
  return out;
}

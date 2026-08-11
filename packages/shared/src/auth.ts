/**
 * Пропуск-кука relay — единый формат токена для Next и Nest.
 *
 * Токен: `${exp}.${base64url(HMAC-SHA256(key, exp))}`, где
 * key = 'relay-auth-v1:' + SITE_PASSWORD. Подпись завязана на пароль: смена
 * SITE_PASSWORD мгновенно делает все ранее выданные куки невалидными.
 *
 * Реализация на Web Crypto (`crypto.subtle`) — один и тот же код работает и в
 * Node 20 (Nest), и в Edge-runtime Next (middleware), без модуля 'node:crypto',
 * поэтому функции асинхронные. Синхронный node-crypto близнец (для socket-
 * handshake и express-гейта, где удобнее sync) живёт в
 * apps/api/src/auth/auth.ts — формат обязан совпадать байт-в-байт.
 */

/** Имя куки-пропуска. */
export const AUTH_COOKIE = 'relay_pass';

/** Срок жизни пропуска — 30 дней. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Срок жизни гостевой инвайт-ссылки — 24 часа. */
export const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = 'relay-auth-v1:';
// Гостевой токен подписывается ДРУГИМ ключом (другой контекст поверх того же
// пароля) — гостевой токен никогда не пройдёт как relay_pass и наоборот.
const GUEST_KEY_PREFIX = 'relay-guest-v1:';
const encoder = new TextEncoder();

/** Байты → base64url без паддинга (как у Node `digest('base64url')`). */
function base64url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Строка → base64url её utf8-байтов (слаг канала внутри гостевого токена). */
function base64urlEncodeText(text: string): string {
  return base64url(encoder.encode(text).buffer as ArrayBuffer);
}

/** Обратно: base64url → utf8-строка; битый ввод → null. */
function base64urlDecodeText(b64: string): string | null {
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function hmac(keyText: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64url(sig);
}

function sign(exp: number, password: string): Promise<string> {
  return hmac(KEY_PREFIX + password, String(exp));
}

/** Сравнение строк за постоянное время (без раннего выхода по длине). */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Выдать новый токен (ставится в куку relay_pass при успешном логине). */
export async function issueToken(password: string): Promise<{ value: string; maxAgeMs: number }> {
  const exp = Date.now() + TOKEN_TTL_MS;
  return { value: `${exp}.${await sign(exp, password)}`, maxAgeMs: TOKEN_TTL_MS };
}

/**
 * Проверить токен из куки. Пустой пароль = авторизация выключена → пускаем
 * всех (как authEnabled() в Nest). Невалидная/просроченная подпись → false.
 */
export async function verifyToken(token: string | undefined, password: string): Promise<boolean> {
  if (!password) return true; // авторизация выключена
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await sign(exp, password);
  return timingSafeEqual(expected, token.slice(dot + 1));
}

// ── Гостевой инвайт-токен ────────────────────────────────────────────────
// Формат: `g2.<b64url(slug)>.<режим>.<exp>.<sig>`, sig = HMAC от всего префикса
// (`g2.<b64slug>.<режим>.<exp>`) на ключе GUEST_KEY_PREFIX+пароль. Токен несёт
// scope (какой войс-канал и на каких правах), а не просто «доступ», поэтому
// подпись и срок проверяются ДАЖЕ при пустом SITE_PASSWORD (в отличие от
// verifyToken). Смена пароля отзывает все инвайты, как и обычные куки.
// Синхронный node-crypto близнец — в apps/api/src/auth/auth.ts, формат обязан
// совпадать байт-в-байт.
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

/** Выдать гостевой токен на конкретный войс-канал (по умолчанию — на 24 часа). */
export async function issueGuestToken(
  slug: string,
  password: string,
  opts: { listen?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const exp = Date.now() + (opts.ttlMs ?? GUEST_TOKEN_TTL_MS);
  const prefix = `g2.${base64urlEncodeText(slug)}.${opts.listen ? 'listen' : 'talk'}.${exp}`;
  return `${prefix}.${await hmac(GUEST_KEY_PREFIX + password, prefix)}`;
}

/** Проверить гостевой токен: валидная подпись и срок → payload, иначе null. */
export async function verifyGuestToken(
  token: string | undefined,
  password: string,
): Promise<GuestTokenPayload | null> {
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
  const sig = parts[parts.length - 1];
  const b64slug = parts[1];
  const exp = Number(parts[parts.length - 2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const slug = base64urlDecodeText(b64slug);
  if (!slug) return null;
  const expected = await hmac(GUEST_KEY_PREFIX + password, parts.slice(0, -1).join('.'));
  return timingSafeEqual(expected, sig) ? { slug, exp, listen } : null;
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

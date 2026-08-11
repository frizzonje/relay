import { createHash, createHmac, timingSafeEqual } from 'crypto';

// Срок жизни пропуска. Подпись зависит от пароля: смена пароля
// мгновенно отзывает все выданные куки.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTH_COOKIE = 'relay_pass';

export function sitePassword(): string {
  return process.env.SITE_PASSWORD ?? '';
}

export function authEnabled(): boolean {
  return sitePassword().length > 0;
}

function sign(exp: number): string {
  return createHmac('sha256', 'relay-auth-v1:' + sitePassword())
    .update(String(exp))
    .digest('base64url');
}

export function issueToken(): { value: string; maxAgeMs: number } {
  const exp = Date.now() + TOKEN_TTL_MS;
  return { value: `${exp}.${sign(exp)}`, maxAgeMs: TOKEN_TTL_MS };
}

export function verifyToken(token: string | undefined): boolean {
  if (!authEnabled()) return true;
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const actual = Buffer.from(token.slice(dot + 1));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Гостевой инвайт-токен (sync-близнец packages/shared/src/auth.ts) ──────
// Формат: `g2.<b64url(slug)>.<режим>.<exp>.<sig>`, sig = HMAC всего префикса на
// ключе 'relay-guest-v1:'+пароль — отдельный контекст, гостевой токен не пройдёт
// как relay_pass. Подпись/срок проверяются даже при пустом SITE_PASSWORD: токен
// несёт scope (какой войс-канал и на каких правах), а не просто «доступ».
// Байт-в-байт с shared, включая приём ссылок прошлой версии (g1, без режима).
const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Что разрешает гостевой токен: слаг канала, срок и право говорить. */
export interface GuestClaims {
  slug: string;
  exp: number;
  /** Только слушать: канал под паролем, а пароля гость не вводил. */
  listen: boolean;
}

function guestHmac(message: string): string {
  return createHmac('sha256', 'relay-guest-v1:' + sitePassword())
    .update(message)
    .digest('base64url');
}

export function issueGuestToken(
  slug: string,
  opts: { listen?: boolean; ttlMs?: number } = {},
): {
  token: string;
  exp: number;
} {
  const exp = Date.now() + (opts.ttlMs ?? GUEST_TOKEN_TTL_MS);
  const mode = opts.listen ? 'listen' : 'talk';
  const prefix = `g2.${Buffer.from(slug, 'utf8').toString('base64url')}.${mode}.${exp}`;
  return { token: `${prefix}.${guestHmac(prefix)}`, exp };
}

export function verifyGuestToken(token: string | undefined): GuestClaims | null {
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
  const b64slug = parts[1];
  const sig = parts[parts.length - 1];
  const exp = Number(parts[parts.length - 2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  let slug: string;
  try {
    slug = Buffer.from(b64slug, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!slug || slug.includes('�')) return null;
  const expected = Buffer.from(guestHmac(parts.slice(0, -1).join('.')));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { slug, exp, listen };
}

// Сравнение паролей за постоянное время — через хэши, чтобы не утекала длина
export function passwordMatches(candidate: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(sitePassword()).digest();
  return timingSafeEqual(a, b);
}

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

// Форма, покрывающая и express-запрос, и socket.io handshake. `auth` есть
// только у handshake; у express-запроса — заголовки.
export interface AuthRequest {
  headers: { cookie?: string; authorization?: string };
  auth?: unknown;
}

// `Authorization: Bearer <token>` → сам токен (или undefined).
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

// Пропуск можно предъявить тремя способами (в порядке приоритета): полем
// `auth.token` socket.io-handshake, заголовком `Authorization: Bearer <token>`
// или кукой relay_pass. Нативным клиентам первые два удобнее, чем эмулировать
// cookie-jar; web-фронт и Tauri (грузит web-UI) остаются на куке.
export function extractToken(req: AuthRequest): string | undefined {
  const fromHandshake =
    typeof req.auth === 'object' && req.auth !== null
      ? (req.auth as { token?: unknown }).token
      : undefined;
  if (typeof fromHandshake === 'string' && fromHandshake) return fromHandshake;
  const fromHeader = bearerToken(req.headers.authorization);
  if (fromHeader) return fromHeader;
  return parseCookies(req.headers.cookie)[AUTH_COOKIE];
}

// Работает и для express-запроса, и для socket.io handshake
export function isAuthorized(req: AuthRequest): boolean {
  return verifyToken(extractToken(req));
}

/**
 * Гостевой Bearer: инвайт-токен вместо relay_pass. Полноценным пропуском не
 * является — authGate пускает с ним ровно на то, без чего звонок не собрать
 * (ICE-конфиг). Без этого гость за строгим NAT остаётся без TURN и без звука.
 */
export function hasValidGuestBearer(req: AuthRequest): boolean {
  return verifyGuestToken(bearerToken(req.headers.authorization)) !== null;
}

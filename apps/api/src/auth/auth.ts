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

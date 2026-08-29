import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { verifyServerPassword } from '../gateway/unlock';

// Срок жизни пропуска. Подпись зависит от пароля: смена пароля
// мгновенно отзывает все выданные куки.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const AUTH_COOKIE = 'relay_pass';

/**
 * Чем инсталляция заперта прямо сейчас.
 *
 *   - `none` — воротами не заперта вовсе. Так живёт инсталляция без пароля, и
 *     так же — та, у которой пароль задан, но ворота выключены настройкой;
 *   - `plain` — пароль из `.env`, как было всегда;
 *   - `hash` — пароль, заданный из панели: наружу и в базу уходит только
 *     `salt:hash` (scrypt), самого пароля не знает никто, включая нас.
 *
 * «Ворота включены, а пароля нет» — это ОТСУТСТВИЕ ворот, а не запертая дверь.
 * Инсталляция без `SITE_PASSWORD` сегодня пускает всех, а флажок
 * `access.sitePasswordEnabled` включён по умолчанию: спроси мы один лишь
 * флажок, первое же обновление заперло бы открытую инсталляцию от её
 * собственных людей.
 */
export type SiteSecret =
  | { kind: 'none' }
  | { kind: 'plain'; value: string }
  | { kind: 'hash'; value: string };

/**
 * Кто отвечает на вопрос «чем заперто».
 *
 * Модульная переменная, а не поле сервиса, потому что спрашивают отсюда те, у
 * кого нет и не будет DI: express-миддлвара `authGate`, разбор handshake
 * socket.io, гостевые ссылки. Ровно та же манера, что у ключа подписи сессий
 * (`identity/session.ts`), и по той же причине.
 *
 * По умолчанию отвечает окружение — это и есть поведение relay до панели, и
 * оно же остаётся у процесса, где настроек нет вовсе (тесты самих функций).
 */
let source: () => SiteSecret = envSecret;

/** Настройки поднялись и знают про пароль из таблицы — спрашиваем их. */
export function useSiteSecret(fn: () => SiteSecret): void {
  source = fn;
}

/** Вернуть ответ окружению. Нужно тестам: источник живёт на весь процесс. */
export function resetSiteSecret(): void {
  source = envSecret;
}

function envSecret(): SiteSecret {
  const raw = process.env.SITE_PASSWORD ?? '';
  return raw ? { kind: 'plain', value: raw } : { kind: 'none' };
}

export function siteSecret(): SiteSecret {
  return source();
}

/**
 * Дверь по адресу — для тех, у кого нет DI.
 *
 * Список закрытых адресов (`access.blockedAddresses`) держит контур доступа:
 * там же и настройки, и личности, и владение. Но спрашивает его не только
 * сокет: http-гейт стоит перед загрузками, и закрой мы одну лишь дверь
 * сигналинга, заблокированный по-прежнему тянул бы файлы и жёг диск. Гейт —
 * обычная express-миддлвара, контейнера в ней нет, поэтому связь ставится
 * подстановкой, ровно как у `useSiteSecret` строкой выше.
 *
 * Две функции, а не одна, потому что стоят они по-разному дорого, и порядок
 * между ними — это и есть смысл: `closed` считает маски в памяти и платится за
 * каждый запрос, `owner` идёт в базу и спрашивается ТОЛЬКО о том, кто уже
 * попал под маску. Обычный запрос не платит за владение ничего.
 */
export interface AddressDoor {
  /** Попал ли адрес под одну из масок владельца. */
  closed(ip: string): boolean;
  /** Владелец ли предъявитель этих кук — его не запирает никогда. */
  owner(cookie: string | undefined): Promise<boolean>;
}

const DOOR_OPEN: AddressDoor = { closed: () => false, owner: async () => false };

let addressDoor: AddressDoor = DOOR_OPEN;

/** Гейтвей поднялся — на вопрос «закрыт ли адрес» отвечает контур доступа. */
export function useAddressDoor(door: AddressDoor): void {
  addressDoor = door;
}

/** Вернуть дверь открытой. Нужно тестам: источник живёт на весь процесс. */
export function resetAddressDoor(): void {
  addressDoor = DOOR_OPEN;
}

/** Дешёвая половина: попал ли адрес под маску. */
export function addressClosed(ip: string): boolean {
  return addressDoor.closed(ip);
}

/** Дорогая половина: владелец ли это. Спрашивать только о попавшем под маску. */
export function addressOwner(cookie: string | undefined): Promise<boolean> {
  return addressDoor.owner(cookie);
}

/**
 * Материал ключа подписи. Пустая строка — ворот нет, и подпись в этом случае
 * ни от чего не защищает (её и не спрашивают: `verifyToken` пускает всех).
 *
 * Для пароля из `.env` это сам пароль — байт в байт как до панели, иначе
 * обновление обесценило бы все выданные куки и заодно разошлось бы с
 * Web-Crypto близнецом в `packages/shared/src/auth.ts`, который проверяет ту же
 * куку в middleware фронта. Для пароля из панели — его хэш: другого стабильного
 * материала у нас нет, а хэш меняется вместе с паролем, чего и надо.
 */
function keyMaterial(): string {
  const secret = siteSecret();
  return secret.kind === 'none' ? '' : secret.value;
}

export function authEnabled(): boolean {
  return siteSecret().kind !== 'none';
}

function sign(exp: number): string {
  return createHmac('sha256', 'relay-auth-v1:' + keyMaterial())
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
  return createHmac('sha256', 'relay-guest-v1:' + keyMaterial())
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

/**
 * Тот ли пароль предъявили.
 *
 * Два случая и две проверки, обе за постоянное время. Пароль из `.env`
 * сравнивается через sha256 — так было всегда, и хэши равной длины не дают
 * утечь длине пароля. Пароль из панели проверяется тем же scrypt, что и пароли
 * закрытых серверов (`gateway/unlock.ts`): своей манеры хэширования здесь не
 * заводится, а вместе с кодом достаётся и семафор, который не даёт очереди из
 * дорогих проверок забить пул libuv и остановить сигналинг.
 *
 * `none` — ворот нет; сюда в этом случае не приходят (дверь отвечает «открыто»
 * раньше), а ответ «не сошлось» честнее, чем «сошлось» на пустом месте.
 */
export async function passwordMatches(candidate: string): Promise<boolean> {
  const secret = siteSecret();
  if (secret.kind === 'none') return false;
  if (secret.kind === 'hash') return verifyServerPassword(candidate, secret.value);
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(secret.value).digest();
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

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Пароли закрытых серверов: хэширование, проверка и учёт неудачных попыток.
 *
 * Здесь два узких места, и оба — про то, что scrypt дорог НАМЕРЕННО.
 *
 * 1. Дорогая проверка — оружие обоюдоострое. Одна неудачная попытка стоит
 *    одного scrypt (успехи кэширует гейтвей, неудачи — нет и не должен), а
 *    считается он в пуле libuv, через который ходят и все файловые операции
 *    api. Без ограничения сверху десяток сокетов забивает пул целиком, и
 *    сигналинг встаёт весь: не собирается ни один звонок. Поэтому scrypt'ов
 *    одновременно ровно столько, сколько можно отдать, не уронив остальное.
 *
 * 2. Счётчик неудач обязан переживать реконнект. На сокете он не защищает ни
 *    от чего: переподключиться стоит один round-trip, и после него счётчик
 *    чистый. Ключ — адрес + сервер: адрес переживает реконнект, а вязать к
 *    одному лишь адресу значит запирать человека на всех серверах сразу.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Пропускной пункт на N мест. Слот не освобождается, а ПЕРЕДАЁТСЯ следующему в
 * очереди: если освобождать и будить по отдельности, между этими двумя
 * событиями успевает вклиниться новый вызов, и мест оказывается больше N.
 */
export class Semaphore {
  private busy = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.busy < this.limit) {
      this.busy += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.busy = Math.max(0, this.busy - 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Для тестов и диагностики: сколько сейчас занято и сколько ждёт. */
  get stats(): { busy: number; waiting: number } {
    return { busy: this.busy, waiting: this.waiting.length };
  }
}

// Два из четырёх потоков пула по умолчанию. Оставшихся двух хватает, чтобы
// файловые операции api (реестр, загрузки) продолжали двигаться, что бы ни
// происходило с паролями.
const scryptGate = new Semaphore(2);

// Пароль сервера храним как `salt:hash` hex (scrypt) — не обратимо, соль на
// каждый сервер своя. Проверка за постоянное время (timingSafeEqual).
export async function hashServerPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptGate.run(() => scryptAsync(password, salt, 32));
  return salt.toString('hex') + ':' + hash.toString('hex');
}

export async function verifyServerPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = await scryptGate.run(() => scryptAsync(password, Buffer.from(saltHex, 'hex'), 32));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Пропуск в разблокированный сервер ────────────────────────────────────
//
// Разблокировка обязана переживать реконнект — ровно по той же причине, что и
// счётчик неудач выше: на сокете она не значит ничего. Сокет рвётся сам по
// себе (спящий ноутбук, смена сети, перезапуск api), после чего набор
// разблокировок пуст, а переспросить пароль не у кого — клиент его не хранит.
// Человек остаётся в канале, которого для сервера больше не существует.
//
// Держать пароль в браузере, чтобы слать заново, — худший из выходов: пароль
// закрытого сервера общий на всех, и localStorage у него самое неподходящее
// место. Вместо этого сервер выдаёт подписанный пропуск: он говорит «пароль
// этого сервера предъявляли» и не даёт узнать, какой именно.
//
// Ключ подписи — сам `passwordHash` сервера. Это то же решение, что у куки
// relay_pass (см. auth.ts): смена пароля меняет хэш, а с ним и ключ, и все
// выданные пропуска умирают в тот же миг — отзывать нечего и незачем.
const UNLOCK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function unlockHmac(message: string, passwordHash: string): string {
  return createHmac('sha256', 'relay-unlock-v1:' + passwordHash)
    .update(message)
    .digest('base64url');
}

/** Формат: `u1.<b64url(serverId)>.<exp>.<sig>`. */
export function issueUnlockToken(
  serverId: string,
  passwordHash: string,
): { token: string; exp: number } {
  const exp = Date.now() + UNLOCK_TOKEN_TTL_MS;
  const prefix = `u1.${Buffer.from(serverId, 'utf8').toString('base64url')}.${exp}`;
  return { token: `${prefix}.${unlockHmac(prefix, passwordHash)}`, exp };
}

/**
 * Проверка пропуска. Id сервера читается из самого токена, а хэш под него
 * достаётся вызывающим — оттого и колбэк: подпись без правильного хэша не
 * проверить, а брать хэш «откуда-нибудь» здесь нельзя. Возвращает id сервера,
 * которому пропуск действительно выдан, или null.
 *
 * `hashOf` возвращает undefined и для несуществующего сервера, и для сервера
 * без пароля. Второй случай — не ошибка: сервер открыли для всех, пока пропуск
 * лежал у клиента. Разблокировать там нечего, и пропуск просто ни к чему.
 */
export function verifyUnlockToken(
  token: string,
  hashOf: (serverId: string) => string | undefined,
): string | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'u1') return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  let serverId: string;
  try {
    serverId = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!serverId || serverId.includes('�')) return null;
  const passwordHash = hashOf(serverId);
  if (!passwordHash) return null;
  const expected = Buffer.from(unlockHmac(parts.slice(0, -1).join('.'), passwordHash));
  const actual = Buffer.from(parts[3]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return serverId;
}

/**
 * Адрес клиента. `trust proxy: 1` в main.ts означает: доверяем ровно одному
 * хопу (нашему Caddy), то есть берём ПОСЛЕДНЮЮ запись X-Forwarded-For — ту,
 * которую подставил он. Первая запись — то, что написал клиент, и вязать
 * ограничения к ней значит не иметь ограничений вовсе.
 */
export function clientIp(handshake: {
  headers: Record<string, string | string[] | undefined>;
  address?: string;
}): string {
  const raw = handshake.headers['x-forwarded-for'];
  const line = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof line === 'string') {
    const parts = line.split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return handshake.address || 'unknown';
}

// Порог тот же, что у входа на сайт (MAX_ATTEMPTS в auth.controller): ошибиться
// восемь раз подряд живой человек ещё может, дальше это уже не опечатки.
const FREE_FAILS = 8;
const COOLDOWN_MS = 30_000;
const COOLDOWN_MAX_MS = 5 * 60_000;
// Тишина в течение часа = разговор окончен, запись можно забыть.
const FORGET_MS = 60 * 60_000;
const MAX_TRACKED = 10_000;

interface Attempt {
  count: number;
  until: number;
  ts: number;
}

/** Неудачные попытки разблокировки, по паре «адрес + сервер». */
export class UnlockAttempts {
  private readonly entries = new Map<string, Attempt>();

  constructor(
    private readonly free = FREE_FAILS,
    private readonly cooldownMs = COOLDOWN_MS,
    private readonly maxCooldownMs = COOLDOWN_MAX_MS,
  ) {}

  private static key(ip: string, serverId: string): string {
    return ip + '\0' + serverId;
  }

  /** Идёт простой — считать хэш не нужно даже начинать. */
  blockedUntil(ip: string, serverId: string, now = Date.now()): number {
    const entry = this.entries.get(UnlockAttempts.key(ip, serverId));
    return entry && entry.until > now ? entry.until : 0;
  }

  /** Возвращает число неудач подряд и момент, до которого назначен простой. */
  fail(ip: string, serverId: string, now = Date.now()): { count: number; until: number } {
    const key = UnlockAttempts.key(ip, serverId);
    const entry = this.entries.get(key) ?? { count: 0, until: 0, ts: now };
    entry.count += 1;
    entry.ts = now;
    if (entry.count > this.free) {
      const over = entry.count - this.free;
      entry.until = now + Math.min(this.cooldownMs * 2 ** (over - 1), this.maxCooldownMs);
    }
    this.entries.set(key, entry);
    if (this.entries.size > MAX_TRACKED) this.forgetStale(now);
    return { count: entry.count, until: entry.until };
  }

  succeed(ip: string, serverId: string): void {
    this.entries.delete(UnlockAttempts.key(ip, serverId));
  }

  /** Сервер удалён — его записи больше ни к чему. */
  forgetServer(serverId: string): void {
    const suffix = '\0' + serverId;
    for (const key of this.entries.keys()) {
      if (key.endsWith(suffix)) this.entries.delete(key);
    }
  }

  private forgetStale(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.ts > FORGET_MS && entry.until <= now) this.entries.delete(key);
    }
  }
}

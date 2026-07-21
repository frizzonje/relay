import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Пропуск в медиасервер. Выдаёт api (`GET /api/sfu-token`), проверяет sfu —
 * формат обязан совпадать байт-в-байт с apps/api/src/sfu/sfu-token.ts.
 *
 * Токен: `s1.<base64url(JSON claims)>.<HMAC-SHA256(ключ, префикс)>`,
 * ключ = 'relay-sfu-v1:' + SFU_SECRET.
 *
 * Смысл разделения: пароль сайта, закрытые серверы и гостевые ссылки живут
 * целиком на стороне api. Медиасервер про них не знает ничего — он проверяет
 * подпись и берёт из клейма комнату, дальше пускает только в неё. Утечка
 * SFU_SECRET даёт доступ к медиа, но не к аккаунтам и не к чату.
 */

const KEY_PREFIX = 'relay-sfu-v1:';

export interface SfuClaims {
  /** Слаг голосового канала — единственная комната, куда пустят с этим токеном. */
  room: string;
  /** Id участника; совпадает с socket.id основного сигналинга, чтобы плитки сошлись. */
  peerId: string;
  /** Отображаемое имя (для presence внутри sfu, не для авторизации). */
  name: string;
  /** Unix-мс, после которых токен мёртв. */
  exp: number;
}

function secret(): string {
  return process.env.SFU_SECRET ?? '';
}

function sign(prefix: string): string {
  return createHmac('sha256', KEY_PREFIX + secret())
    .update(prefix)
    .digest('base64url');
}

export function verifySfuToken(token: unknown): SfuClaims | null {
  // Пустой SFU_SECRET — не «всё можно», а «сервис не настроен»: подписать такой
  // токен смог бы кто угодно, поэтому не пускаем никого.
  if (!secret()) return null;
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 's1') return null;
  const [version, body, sig] = parts;
  const expected = Buffer.from(sign(`${version}.${body}`));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const { room, peerId, name, exp } = claims as Record<string, unknown>;
  if (typeof room !== 'string' || !room) return null;
  if (typeof peerId !== 'string' || !peerId) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < Date.now()) return null;
  return { room, peerId, name: typeof name === 'string' ? name : '', exp };
}

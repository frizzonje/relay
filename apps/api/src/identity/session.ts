import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Сессия личности: чем устройство предъявляет себя, уже доказав владение
 * ключом.
 *
 * Формат — `<identity>.<device>.<exp>.<подпись>`, ровно как у пропуска на
 * инсталляцию (`auth.ts`), и по той же причине: сервер ничего не хранит, а
 * проверка стоит одного HMAC.
 *
 * Ключ подписи — случайный, рождается при старте процесса и НИКУДА не
 * записывается. Это осознанный размен, и вот его обе стороны:
 *
 *   - плюс: подделать сессию нельзя даже на инсталляции с пустым
 *     `SITE_PASSWORD` (а такие есть — пароль тут ворота, а не тайна), и нет
 *     ещё одного секрета, который надо родить, положить в `.env`, не потерять
 *     при `relay restore` и не утащить в бэкап;
 *   - минус: рестарт api обесценивает выданные сессии.
 *
 * Минус безболезненный ровно потому, что личность — это ключ: клиент молча
 * проходит челлендж заново, не спрашивая человека ни о чём. Тем и отличается
 * от `relay_pass`, за которым стоит пароль и живой человек, — тот пережить
 * рестарт обязан.
 *
 * Процесс один на инсталляцию (один контейнер api), так что делить ключ не с
 * кем. Появятся реплики — это первое место, которое сломается, и сломается
 * громко: сессия, выданная соседом, просто не сойдётся.
 */

/**
 * Сколько живёт сессия по умолчанию. Ровно столько же, сколько жил пропуск на
 * инсталляцию (`auth.ts`), и столько же обещает каталог настроек: срок
 * задаётся `access.sessionTtlDays`, а это число — то, чем он был всегда.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const IDENTITY_COOKIE = 'relay_id';

let secret = randomBytes(32);

/**
 * Отозвать все выданные сессии разом.
 *
 * Хранилища сессий нет по построению (см. шапку), поэтому «отозвать все» — это
 * сменить ключ подписи: ни одна выданная кука больше не сходится, и разбирать
 * список того, что кому выдавалось, не приходится вовсе.
 *
 * Дешевизна здесь не случайна, а куплена заранее — тем самым разменом, из-за
 * которого сессии не переживают рестарт api. Человеку отзыв ничего не стоит:
 * личность — это ключ, и клиент проходит челлендж заново, ни о чём не
 * спрашивая. Зовёт это владелец из панели; живые сокеты рвёт он же — личность
 * узнаётся один раз, при подключении.
 */
export function revokeAllSessions(): void {
  secret = randomBytes(32);
}

export interface Session {
  identityId: string;
  deviceId: string;
}

function sign(payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Выдать сессию. Срок приходит снаружи: настройки знает контроллер, а этот
 * модуль обязан оставаться чистым — его зовут и тест, и разбор куки, у
 * которого настроек нет и быть не должно.
 */
export function issueSession(
  s: Session,
  ttlMs: number = SESSION_TTL_MS,
): { value: string; maxAgeMs: number } {
  const payload = `${s.identityId}.${s.deviceId}.${Date.now() + ttlMs}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeMs: ttlMs };
}

/** Личность из куки — или `null`. Ни исключений, ни подробностей наружу. */
export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [identityId, deviceId, expText, signature] = parts;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = Buffer.from(sign(`${identityId}.${deviceId}.${expText}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { identityId, deviceId };
}

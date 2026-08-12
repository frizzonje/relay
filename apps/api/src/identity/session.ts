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

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const IDENTITY_COOKIE = 'relay_id';

const secret = randomBytes(32);

export interface Session {
  identityId: string;
  deviceId: string;
}

function sign(payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(s: Session): { value: string; maxAgeMs: number } {
  const payload = `${s.identityId}.${s.deviceId}.${Date.now() + TTL_MS}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeMs: TTL_MS };
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

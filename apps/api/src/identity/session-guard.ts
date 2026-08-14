import type { Request, Response } from 'express';
import { parseCookies } from '../auth/auth';
import type { DeviceRow, IdentityRow } from '../db/entities';
import type { IdentityService } from './identity.service';
import { IDENTITY_COOKIE, readSession } from './session';

/**
 * «Кто спрашивает» — один ответ на все распоряжения личностью.
 *
 * Отдельной функцией, а не приватным методом в каждом контроллере, ровно из-за
 * одной строки: отозванному устройству отвечают 403, а не 401. Различие тонкое
 * (клиент по нему решает, чинить сессию молча или сказать человеку, что ключ
 * отозван) и живёт ровно до первой копии, где о нём забыли.
 *
 * `null` означает, что ответ уже отправлен: вызывающему остаётся выйти.
 */
export async function requireIdentity(
  identity: IdentityService,
  req: Request,
  res: Response,
): Promise<{ identity: IdentityRow; device: DeviceRow } | null> {
  const session = readSession(parseCookies(req.headers.cookie)[IDENTITY_COOKIE]);
  if (!session) {
    res.status(401).json({ error: 'no session' });
    return null;
  }
  const result = await identity.whoIs(session.identityId, session.deviceId);
  if (!result.ok) {
    res.status(result.reason === 'revoked' ? 403 : 401).json({ error: result.reason });
    return null;
  }
  return { identity: result.identity, device: result.device };
}

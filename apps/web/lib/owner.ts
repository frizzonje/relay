import { isOwnerToken } from '@relay/shared';

/**
 * Владелец инсталляции со стороны клиента.
 *
 * Тут почти нечего делать, и это правильно: ключ владельца родился на сервере,
 * приехал в браузер ссылкой и уезжает обратно как есть. Клиент им ничего не
 * подписывает и ничего о нём не решает — вся власть ссылки в том, что человек
 * её открыл, будучи собой.
 */

export type OwnerFailure =
  /** Такого ключа не выдавалось (или ссылка приехала обрезанной). */
  | 'bad-token'
  /** Ссылкой уже воспользовались — второй раз она не работает. */
  | 'used'
  /** Сутки вышли либо ключ перевыпущен: годен всегда только последний. */
  | 'expired'
  /** Сессии нет: сперва надо стать хоть кем-то. */
  | 'no-identity'
  | 'network';

export class OwnerError extends Error {
  constructor(readonly reason: OwnerFailure) {
    super(`owner: ${reason}`);
    this.name = 'OwnerError';
  }
}

function base(): string {
  return process.env.NEXT_PUBLIC_API_URL || '';
}

/** Код ответа → причина. Тела не читаем: отказ здесь однозначно виден по коду. */
function failureOf(status: number): OwnerError {
  if (status === 409) return new OwnerError('used');
  if (status === 410) return new OwnerError('expired');
  if (status === 400) return new OwnerError('bad-token');
  if (status === 401 || status === 403) return new OwnerError('no-identity');
  return new OwnerError('network');
}

/** Владелец ли эта личность. `false` и при отсутствии сессии — вопрос про себя. */
export async function amIOwner(): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/api/identity/owner`, { credentials: 'include' });
    if (!res.ok) return false;
    return ((await res.json()) as { owner: boolean }).owner;
  } catch {
    return false;
  }
}

/**
 * Взять власть по ключу из ссылки. Форму проверяем до запроса: обрезанная при
 * копировании ссылка — самый вероятный исход, и говорить о ней надо сразу, а не
 * гонять сервер ради того же ответа.
 */
export async function claimOwner(token: string): Promise<void> {
  if (!isOwnerToken(token)) throw new OwnerError('bad-token');
  let res: Response;
  try {
    res = await fetch(`${base()}/api/identity/owner/claim`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    throw new OwnerError('network');
  }
  if (!res.ok) throw failureOf(res.status);
}

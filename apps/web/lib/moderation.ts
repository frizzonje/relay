import type { BanEntry, ModerationResult } from '@relay/shared';
import { getSocket } from '@/lib/socket';

/**
 * Модерация со стороны клиента: три события и ни одного решения.
 *
 * Права здесь не вычисляются — их присылает сервер флагом `moderated` на самом
 * сервере реестра. Клиент по нему только рисует кнопки: вычислять право на
 * стороне, которая его же и просит, значит рано или поздно нарисовать кнопку,
 * дающую отказ, — или, что хуже, спрятать ту, которая работала бы.
 *
 * Отказ не глотаем: у бана нет отката, и «нажал, ничего не произошло» —
 * худший из возможных ответов. Поэтому каждая обёртка возвращает ответ сервера
 * целиком, а вызывающий обязан на него посмотреть.
 */

/** Сколько ждём ответа, прежде чем считать, что сервер не ответил. */
const TIMEOUT_MS = 8000;

/** Обрыв связи выглядит как отказ, а не как тишина. */
const OFFLINE: ModerationResult = { ok: false, error: 'not-found' };

function ask<T>(run: (cb: (res: T) => void) => void, offline: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (res: T) => {
      if (done) return;
      done = true;
      resolve(res);
    };
    const timer = setTimeout(() => finish(offline), TIMEOUT_MS);
    run((res) => {
      clearTimeout(timer);
      finish(res);
    });
  });
}

/**
 * Забанить автора реплики. `everywhere` — на всю инсталляцию; такое разрешено
 * только владельцу, и спрашивается оно отдельным пунктом меню, а не молчаливым
 * расширением охвата.
 */
export function banAuthor(id: string, everywhere = false): Promise<ModerationResult> {
  return ask<ModerationResult>(
    (cb) => getSocket().emit('moderation-ban', { id, ...(everywhere ? { everywhere } : {}) }, cb),
    OFFLINE,
  );
}

/** Разбанить по отпечатку — той же ручкой, которой забаненный показан. */
export function unban(fingerprint: string, server?: string): Promise<ModerationResult> {
  return ask<ModerationResult>(
    (cb) =>
      getSocket().emit('moderation-unban', { fingerprint, ...(server ? { server } : {}) }, cb),
    OFFLINE,
  );
}

/** Кто забанен в этом охвате. Отказ и обрыв выглядят одинаково: пустой список. */
export async function listBans(server?: string): Promise<BanEntry[]> {
  const res = await ask(
    (cb: (r: { ok: boolean; bans?: BanEntry[] }) => void) =>
      getSocket().emit('moderation-bans', { ...(server ? { server } : {}) }, cb),
    { ok: false as const },
  );
  return res.ok ? (res.bans ?? []) : [];
}

import type { BanEntry, ModerationResult } from '@relay/shared';
import { request } from '@/lib/request';

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

/** Обрыв связи выглядит как отказ, а не как тишина. */
const OFFLINE: ModerationResult = { ok: false, error: 'not-found' };

/**
 * Забанить автора реплики. `everywhere` — на всю инсталляцию; такое разрешено
 * только владельцу, и спрашивается оно отдельным пунктом меню, а не молчаливым
 * расширением охвата.
 */
export async function banAuthor(id: string, everywhere = false): Promise<ModerationResult> {
  const res = await request('moderation-ban', { id, ...(everywhere ? { everywhere } : {}) });
  return res ?? OFFLINE;
}

/** Разбанить по отпечатку — той же ручкой, которой забаненный показан. */
export async function unban(fingerprint: string, server?: string): Promise<ModerationResult> {
  const res = await request('moderation-unban', { fingerprint, ...(server ? { server } : {}) });
  return res ?? OFFLINE;
}

/**
 * Кто забанен в этом охвате; `null` — список не получили (отказ или обрыв).
 * Пустой список вместо него значил бы «никто не забанен» — и модератор
 * поверил бы этому про человека, которого банил вчера.
 */
export async function listBans(server?: string): Promise<BanEntry[] | null> {
  const res = await request('moderation-bans', { ...(server ? { server } : {}) });
  return res?.ok ? res.bans : null;
}

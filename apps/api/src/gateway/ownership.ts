import type { Channel, ServerEntry } from './registry';

/**
 * Владение реестровыми записями и их публичная форма (audit B2).
 *
 * Правило одно: сервер или канал правит тот, кто его создал, — а поверх него
 * владелец инсталляции, который правит всё. Модерация сервера этим же и
 * исчерпывается: создатель отвечает за своё и только за своё, отдельной роли
 * «модератор» никто не выдаёт.
 *
 * Создатель — это личность. До 1.0 им было устройство, называвшее себя
 * `clientId` из localStorage: заслон от случайного сноса, но не право —
 * подделывается тем, кто захочет, и теряется вместе с чисткой браузера.
 * Унаследованные записи так и остались с `creatorId`, и правило для них
 * прежнее: переписать его в личность нечем (clientId никогда не был связан с
 * ключом), а отобрать сервер у человека в день обновления — худший из исходов.
 *
 * Наружу не уходит ни то, ни другое — только вычисленный под конкретный сокет
 * флаг `mine`. Разница принципиальная: угадать чужой uuid нельзя, а получить его
 * в рассылке и вернуть обратно в следующем запросе — можно.
 */

/** Тот, кто спрашивает: устройство, личность за ним и власть над инсталляцией. */
export interface Claimant {
  /** clientId из handshake. Ключ к унаследованным записям — и только к ним. */
  clientId?: string;
  /** Личность сокета. Пусто у гостя по инвайту и у клиента без ключа. */
  identityId?: string;
  /** Владелец инсталляции. Ему принадлежит всё, что в ней есть. */
  owner?: boolean;
}

/**
 * Вправе ли спрашивающий править запись.
 *
 * Порядок проверок — он же порядок старшинства. Запись, у которой есть личность
 * создателя, устройством больше не открывается: clientId был слабее ключа
 * всегда, и оставить его вторым ключом к той же двери значило бы не переезд на
 * личности, а лишнюю щель. Запись без создателя вообще (такие есть — они старше
 * самого правила владения) остаётся общей: запереть её навсегда было бы хуже,
 * лишённый прав хозяин не восстановит свой сервер никак.
 */
export function ownedBy(
  entry: { creatorId?: string; creatorIdentityId?: string },
  who: Claimant,
): boolean {
  if (who.owner) return true;
  if (entry.creatorIdentityId) return entry.creatorIdentityId === who.identityId;
  return !entry.creatorId || entry.creatorId === who.clientId;
}

/** Нормализованный clientId: обрезаем и режем длину. Пусто → владельца нет. */
export function normalizeClientId(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim().slice(0, 64) || undefined : undefined;
}

/** Публичная форма сервера: без хэша пароля, с флагом `locked` и `mine`. */
export function publicServer(entry: ServerEntry, who: Claimant) {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.emoji ? { emoji: entry.emoji } : {}),
    removable: entry.removable,
    ...(entry.passwordHash ? { locked: true as const } : {}),
    ...(ownedBy(entry, who) ? { mine: true as const } : {}),
  };
}

/**
 * Публичная форма канала. Собираем поимённо, а не отдаём запись реестра как
 * есть: у записи есть поля, которым наружу не место (`creatorId`), и добавится
 * ещё — пусть их утечка требует правки здесь, а не случается сама.
 */
export function publicChannel(channel: Channel, who: Claimant, lastTs?: number) {
  return {
    id: channel.id,
    serverId: channel.serverId,
    type: channel.type,
    name: channel.name,
    slug: channel.slug,
    removable: channel.removable,
    ...(channel.mode ? { mode: channel.mode } : {}),
    ...(lastTs ? { lastTs } : {}),
    ...(ownedBy(channel, who) ? { mine: true as const } : {}),
  };
}

export type PublicServer = ReturnType<typeof publicServer>;
export type PublicChannel = ReturnType<typeof publicChannel>;

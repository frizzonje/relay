import type { Channel, ServerEntry } from './registry';

/**
 * Владение реестровыми записями и их публичная форма (audit B2).
 *
 * Правило одно: сервер или канал правит тот, с чьего устройства он создан.
 * Устройство называет себя `clientId` — тем же стабильным id из localStorage,
 * которым голосовой канал выгоняет «призрака» прошлой вкладки. Он приходит в
 * handshake сокета, а не в каждом сообщении: одна точка входа, одна проверка.
 *
 * Чем это НЕ является: аутентификацией. clientId лежит в localStorage и
 * подделывается тем, кто захочет. Это заслон от случайного и ленивого сноса
 * чужого сервера до слоёв 2–3 плана 1.0, где владельцем станет ключ.
 *
 * Ровно поэтому наружу не уходит сам id владельца — только вычисленный под
 * конкретный сокет флаг `mine`. Разница принципиальная: угадать чужой uuid
 * нельзя, а получить его в рассылке и вернуть обратно в следующем запросе —
 * можно, и тогда «заслон от ленивого» не остановил бы даже ленивого.
 */

/** Нормализованный clientId: обрезаем и режем длину. Пусто → владельца нет. */
export function normalizeClientId(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim().slice(0, 64) || undefined : undefined;
}

/**
 * Вправе ли это устройство править запись. Запись без `creatorId` создана до
 * правила владения: владельца у неё не существует, и права на неё прежние —
 * общие. Запереть их навсегда было бы хуже: лишённый возможности хозяин не
 * восстановит сервер никак.
 */
export function ownedBy(entry: { creatorId?: string }, clientId: string | undefined): boolean {
  return !entry.creatorId || entry.creatorId === clientId;
}

/** Публичная форма сервера: без хэша пароля, с флагом `locked` и `mine`. */
export function publicServer(entry: ServerEntry, clientId: string | undefined) {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.emoji ? { emoji: entry.emoji } : {}),
    removable: entry.removable,
    ...(entry.passwordHash ? { locked: true as const } : {}),
    ...(ownedBy(entry, clientId) ? { mine: true as const } : {}),
  };
}

/**
 * Публичная форма канала. Собираем поимённо, а не отдаём запись реестра как
 * есть: у записи есть поля, которым наружу не место (`creatorId`), и добавится
 * ещё — пусть их утечка требует правки здесь, а не случается сама.
 */
export function publicChannel(channel: Channel, clientId: string | undefined, lastTs?: number) {
  return {
    id: channel.id,
    serverId: channel.serverId,
    type: channel.type,
    name: channel.name,
    slug: channel.slug,
    removable: channel.removable,
    ...(channel.mode ? { mode: channel.mode } : {}),
    ...(lastTs ? { lastTs } : {}),
    ...(ownedBy(channel, clientId) ? { mine: true as const } : {}),
  };
}

export type PublicServer = ReturnType<typeof publicServer>;
export type PublicChannel = ReturnType<typeof publicChannel>;

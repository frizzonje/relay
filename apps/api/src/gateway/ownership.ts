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

/**
 * Строгое «это завёл он»: не право править, а авторство записи.
 *
 * Отличается от `ownedBy` двумя послаблениями, которых здесь нет и быть не
 * должно. Владельцу инсталляции принадлежит всё — но считать его личной квотой
 * все серверы инсталляции значит запереть его первым же подсчётом. Запись без
 * создателя правит кто угодно — но не числится ни за кем, и вешать её на того,
 * кто спросил, было бы враньём в обе стороны: и в квоте, и в списке «мои».
 *
 * Отсюда и единственное применение: личные потолки (audit S2). Право на правку
 * по-прежнему решает `ownedBy`, и путать их нельзя.
 */
export function createdBy(
  entry: { creatorId?: string; creatorIdentityId?: string },
  who: Claimant,
): boolean {
  if (entry.creatorIdentityId) return entry.creatorIdentityId === who.identityId;
  return !!entry.creatorId && !!who.clientId && entry.creatorId === who.clientId;
}

/**
 * Модерирует ли спрашивающий этот сервер: удаляет чужие сообщения, банит,
 * смотрит список забаненных.
 *
 * Это НЕ то же самое, что право править запись (`ownedBy`), и разница
 * существенная. Там «создателя нет» означает «права общие» — иначе сервер,
 * созданный до самого правила владения, никто не смог бы даже переименовать.
 * Здесь такое послабление означало бы, что на главном сервере, у которого
 * создателя нет и быть не может, любой удаляет чужие слова и банит кого хочет.
 *
 * Поэтому нужен названный хозяин: личность создателя либо владелец
 * инсталляции. Унаследованный clientId власти не даёт — он лежит в localStorage
 * и подделывается, а модерация не то, что доверяют строке из чужого браузера.
 */
export function moderatedBy(entry: { creatorIdentityId?: string }, who: Claimant): boolean {
  if (who.owner) return true;
  return !!entry.creatorIdentityId && entry.creatorIdentityId === who.identityId;
}

/** Нормализованный clientId: обрезаем и режем длину. Пусто → владельца нет. */
export function normalizeClientId(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim().slice(0, 64) || undefined : undefined;
}

/**
 * Публичная форма сервера: без хэша пароля, с флагами `locked`, `unlocked` и
 * `mine`.
 *
 * `unlocked` — состояние спрашивающего сокета, а не записи: пароль этого
 * сервера на нём уже предъявляли (сам человек или пропуск из handshake).
 * Наружу он уходит потому, что клиент иначе о нём не знает: после
 * перезагрузки страницы вкладка пуста, а сокет — нет, и замок возвращался бы
 * на открытый сервер вместе с требованием пароля, который серверу не нужен.
 * У сервера без пароля флага нет вовсе — открывать там нечего.
 */
export function publicServer(entry: ServerEntry, who: Claimant, unlocked?: Set<string>) {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.emoji ? { emoji: entry.emoji } : {}),
    removable: entry.removable,
    ...(entry.passwordHash ? { locked: true as const } : {}),
    ...(entry.passwordHash && unlocked?.has(entry.id) ? { unlocked: true as const } : {}),
    ...(ownedBy(entry, who) ? { mine: true as const } : {}),
    ...(moderatedBy(entry, who) ? { moderated: true as const } : {}),
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

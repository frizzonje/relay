import {
  REACTION_EMOJIS,
  type ChatMessage,
  type PersonOrGuest,
  type ReactionMap,
} from '@relay/shared';

/** Реакции: закрытый набор эмодзи и тогл «своей» — по отпечатку, а не по нику. */

/** Разрешённый набор реакций — тот же, что рисует клиент. */
const REACTIONS: ReadonlySet<string> = new Set(REACTION_EMOJIS);

/**
 * Один ли это человек. Отпечаток сильнее ника и не сравнивается с ним никогда:
 * «у меня ключ, а у записи его нет» — это разные люди, даже если имя совпало.
 */
function sameReactor(a: PersonOrGuest, b: PersonOrGuest): boolean {
  if (a.fingerprint || b.fingerprint) return a.fingerprint === b.fingerprint;
  return a.nick === b.nick;
}

/** Знаем ли мы такую реакцию (набор закрытый — произвольные эмодзи не носим). */
export function knownReaction(emoji: string): boolean {
  return REACTIONS.has(emoji);
}

/**
 * Тогл реакции: повторный эмодзи снимает свою. Возвращает новый набор.
 *
 * «Своя» — по отпечатку ключа, а не по нику: ники не уникальны, и до 1.0
 * тёзка снимал чужую реакцию и голосовал от чужого имени (audit S1). У
 * записи без отпечатка — а такие остались от прежних версий — своим считается
 * только тот, у кого ключа нет тоже: иначе достаточно было бы назваться.
 */
export function toggleReaction(msg: ChatMessage, who: PersonOrGuest, emoji: string): ReactionMap {
  const reactions: ReactionMap = { ...(msg.reactions ?? {}) };
  const list = reactions[emoji] ?? [];
  const mine = list.filter((r) => sameReactor(r, who));
  if (mine.length) {
    const next = list.filter((r) => !sameReactor(r, who));
    if (next.length) reactions[emoji] = next;
    else delete reactions[emoji];
  } else {
    reactions[emoji] = [...list, who];
  }
  return reactions;
}

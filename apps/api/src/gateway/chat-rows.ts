import { AttachmentRow, MessageRow } from '../db/entities';
import type { Attachment, ChatMessage } from '@relay/shared';

/** Строки базы → реплики протокола, и проверка id до того, как он попадёт в запрос. */

/**
 * Всё, что приходит от клиента, обязано быть проверено до попадания в запрос:
 * `id` тут — строка из тела сообщения, и «не-uuid» в условии по uuid-колонке
 * это не пустой результат, а ошибка базы (22P02).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function toAttachment(row: AttachmentRow, spoiler: boolean): Attachment {
  return {
    url: '/uploads/' + row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    kind: row.kind as Attachment['kind'],
    ...(spoiler ? { spoiler: true } : {}),
  };
}

/**
 * Строка базы → реплика протокола. Пустые поля не носим: клиент отличает
 * «реакций нет» от «пустой объект реакций» только по наличию ключа, и так было
 * всегда.
 */
export function toMessage(row: MessageRow): ChatMessage {
  const reactions = row.reactions ?? {};
  return {
    id: row.id,
    name: row.authorName,
    // Отпечаток берётся у личности, а не хранится в строке: имя — снимок
    // момента, а лицо у человека одно, и второй его копией мы бы завели место,
    // где оно может разойтись с ключом.
    ...(row.authorIdentity ? { fingerprint: row.authorIdentity.fingerprint } : {}),
    text: row.text,
    ts: row.createdAt.getTime(),
    ...(row.attachment ? { attachment: toAttachment(row.attachment, row.spoiler) } : {}),
    ...(row.system ? { system: true } : {}),
    ...(row.call ? { call: row.call } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    ...(row.editedAt ? { editedTs: row.editedAt.getTime() } : {}),
    ...(row.mentions?.length ? { mentions: row.mentions } : {}),
    ...(row.pins?.length ? { pinned: true as const } : {}),
  };
}

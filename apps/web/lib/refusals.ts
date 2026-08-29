import type { ChatRefusal, VoiceRefusal } from '@relay/shared';
import type { MessageKey } from '@/lib/i18n';

/**
 * Причина отказа — строкой, которую человек может прочитать.
 *
 * Сервер называет причину машинным словом (`banned-word`, `room-full`), и без
 * этой карты она осталась бы в логе. До этапа C всякий отказ в ленте и в голосе
 * выглядел одинаково — «нажал, и ничего не произошло», — и человек шёл чинить
 * не то: выключенную владельцем правку он принимал за поломку.
 *
 * Карта полная по типу (`Record<ChatRefusal, …>`), а не по совести: заведут на
 * сервере новую причину — клиент не соберётся, вместо того чтобы молча показать
 * пустой тост. Ровно так же держится контракт самих причин между половинами.
 *
 * Текст говорит, ЧТО нельзя, а не «операция отклонена»: причины разделены
 * сервером именно для того, чтобы совет был выполнимым.
 */
export const CHAT_REFUSAL_KEYS: Record<ChatRefusal, MessageKey> = {
  'read-only': 'refused.chat.read-only',
  rate: 'refused.chat.rate',
  'banned-word': 'refused.chat.banned-word',
  'links-off': 'refused.chat.links-off',
  'attachments-off': 'refused.chat.attachments-off',
  'edit-off': 'refused.chat.edit-off',
  'edit-window': 'refused.chat.edit-window',
  'delete-off': 'refused.chat.delete-off',
  'reactions-off': 'refused.chat.reactions-off',
  'search-off': 'refused.chat.search-off',
  'too-new': 'refused.chat.too-new',
  'spoiler-off': 'refused.chat.spoiler-off',
};

export const VOICE_REFUSAL_KEYS: Record<VoiceRefusal, MessageKey> = {
  'video-off': 'refused.voice.video-off',
  'screen-share-off': 'refused.voice.screen-share-off',
  'room-full': 'refused.voice.room-full',
  'guests-full': 'refused.voice.guests-full',
};

/**
 * Причина, которой в карте нет, — это сервер новее клиента. Общая строка здесь
 * лучше молчания: «отказано, обновите приложение» человек хотя бы может
 * проверить, а тишину — нет.
 */
export function chatRefusalKey(reason: ChatRefusal): MessageKey {
  return CHAT_REFUSAL_KEYS[reason] ?? 'refused.unknown';
}

export function voiceRefusalKey(reason: VoiceRefusal): MessageKey {
  return VOICE_REFUSAL_KEYS[reason] ?? 'refused.unknown';
}

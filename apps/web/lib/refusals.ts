import type { AdminRefusal, ChatRefusal, VoiceRefusal } from '@relay/shared';
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

/**
 * У `not-in-call` в этой карте один-единственный читатель, и это не общий тост
 * отказов. Отказ во входе в комнату беседы разбирает `lib/call.ts` —
 * единственный, кто в такую комнату стучится, — и разбирает сперва делом
 * (снимает экран звонка и отпускает микрофон), а потом словом: строку отсюда
 * он и показывает, но только той вкладке, которая в комнате беседы сидела. У
 * общего тоста в `SocketProvider` этого знания нет, и говорил бы он поэтому
 * ровно то, что неправда: обвинял бы законную сторону разговора в том, что
 * разговор не её (см. комментарии в обоих файлах).
 *
 * Отсюда и текст этой строки: она называет единственный случай, в котором её
 * теперь читают, — разговор не собрался, садились слишком долго.
 */
export const VOICE_REFUSAL_KEYS: Record<VoiceRefusal, MessageKey> = {
  'video-off': 'refused.voice.video-off',
  'screen-share-off': 'refused.voice.screen-share-off',
  'room-full': 'refused.voice.room-full',
  'guests-full': 'refused.voice.guests-full',
  'not-in-call': 'refused.voice.not-in-call',
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

/**
 * Отказ, который панель показывает подписью под полем.
 *
 * Кроме одиннадцати причин сервера здесь есть двенадцатая, своя: `timeout` —
 * молчание в ответ на правку. Отказом сервера оно не является, но под полем
 * выглядит так же, и человеку нужен тот же текст: сказать, что значение
 * осталось прежним. Без него молчащий сервер оставлял бы поле в «сохраняется»
 * навсегда — ровно то состояние, в котором панель врёт молча.
 */
export type AdminFieldError = AdminRefusal | 'timeout';

/**
 * Причины отказов панели.
 *
 * Та же карта, что у ленты и голоса, и по той же причине: панель — место, где
 * человек двигает поля и обязан узнать, почему поле вернулось на прежнее
 * значение. Полнота по типу (`Record<AdminFieldError, …>`) держит её честной:
 * причина, заведённая на сервере завтра, не соберётся здесь молча.
 */
export const ADMIN_REFUSAL_KEYS: Record<AdminFieldError, MessageKey> = {
  forbidden: 'refused.admin.forbidden',
  'needs-confirm': 'refused.admin.needs-confirm',
  'unknown-key': 'refused.admin.unknown-key',
  'read-only': 'refused.admin.read-only',
  'wrong-type': 'refused.admin.wrong-type',
  'out-of-range': 'refused.admin.out-of-range',
  'not-an-option': 'refused.admin.not-an-option',
  'too-long': 'refused.admin.too-long',
  'bad-item': 'refused.admin.bad-item',
  'secret-path': 'refused.admin.secret-path',
  'not-found': 'refused.admin.not-found',
  unsupported: 'refused.admin.unsupported',
  timeout: 'refused.admin.timeout',
};

export function adminRefusalKey(reason: AdminFieldError): MessageKey {
  return ADMIN_REFUSAL_KEYS[reason] ?? 'refused.unknown';
}

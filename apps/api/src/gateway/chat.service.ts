import { Injectable } from '@nestjs/common';
import type { ChatMessage, ReactionMap } from './protocol';

/**
 * История текстовых каналов.
 *
 * Пока — в памяти процесса: пятьдесят последних реплик на канал, двести
 * каналов, рестарт стирает всё (audit S3). Это и есть причина, по которой
 * хранилище живёт отдельно от гейтвея: слой 1 плана 1.0 меняет здесь всё —
 * Postgres, ретенция, поиск, — и менять он должен один файл, а не полторы
 * тысячи строк правил о том, кому что видно.
 *
 * Гейтвей знает об истории ровно то, что ниже: положить, найти, посчитать,
 * забыть канал. Ни один обработчик не трогает `Map` напрямую.
 */

/** Комнаты чата в socket.io живут с префиксом — чтобы не пересечься с эфиром. */
export const CHAT_PREFIX = 'chat:';

/** Сколько последних реплик держим на канал. */
const HISTORY_LIMIT = 50;

/**
 * Сколько каналов вообще помним. Слаг задаёт клиент, поэтому число каналов с
 * историей надо ограничивать — иначе память растёт по чужому желанию.
 */
const MAX_CHAT_ROOMS = 200;

/**
 * Разрешённый набор реакций — дублирует REACTION_EMOJIS из `@relay/shared`
 * (api намеренно не зависит от пакета фронта, как и прочие константы).
 */
const REACTION_EMOJIS = new Set(['👍', '👎', '❤️', '😂', '🔥', '🫡', '🤡', '😭']);

@Injectable()
export class ChatService {
  private readonly history = new Map<string, ChatMessage[]>();

  /** Имя socket.io-комнаты текстового канала по его слагу. */
  room(slug: string): string {
    return CHAT_PREFIX + slug;
  }

  /** Слаг канала по имени его комнаты. */
  slug(room: string): string {
    return room.slice(CHAT_PREFIX.length);
  }

  /** Лента канала. Пустая, если в нём ещё не писали. */
  messages(room: string): ChatMessage[] {
    return this.history.get(room) ?? [];
  }

  /**
   * Добавляет реплику, срезая ленту до предела и вытесняя самые старые каналы.
   * Текущий канал не вытесняем никогда — иначе только что написанное сообщение
   * исчезло бы вместе со своей лентой.
   */
  add(room: string, msg: ChatMessage): void {
    const list = this.messages(room);
    list.push(msg);
    if (list.length > HISTORY_LIMIT) list.shift();
    this.remember(room, list);
  }

  /** Несистемная реплика канала по id (системные не правятся и не удаляются). */
  find(room: string, id: string): ChatMessage | undefined {
    return this.history.get(room)?.find((m) => m.id === id && !m.system);
  }

  /** Реплика по id, включая системные — реакции можно ставить на любую. */
  findAny(room: string, id: string): ChatMessage | undefined {
    return this.history.get(room)?.find((m) => m.id === id);
  }

  /** Убирает реплику из ленты. `false` — такой в канале нет. */
  remove(room: string, msg: ChatMessage): boolean {
    const list = this.history.get(room);
    const idx = list?.indexOf(msg) ?? -1;
    if (!list || idx === -1) return false;
    list.splice(idx, 1);
    this.remember(room, list);
    return true;
  }

  /** Канал удалён — его лента больше никому не принадлежит. */
  forget(slug: string): void {
    this.history.delete(this.room(slug));
  }

  /** Сколько реплик в канале (для диалога подтверждения удаления). */
  count(slug: string): number {
    return this.history.get(this.room(slug))?.length ?? 0;
  }

  /**
   * Время последней НЕсистемной реплики канала (0 — писать ещё не начинали).
   * Системные строки активностью не считаем: точку «непрочитано» зажигают
   * только сообщения — ровно те же, что рассылают `chat-activity`.
   */
  lastTs(slug: string): number {
    const list = this.history.get(this.room(slug));
    if (!list) return 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i].system) return list[i].ts;
    }
    return 0;
  }

  /** Знаем ли мы такую реакцию (набор закрытый — произвольные эмодзи не носим). */
  knownReaction(emoji: string): boolean {
    return REACTION_EMOJIS.has(emoji);
  }

  /** Тогл реакции: повторный эмодзи снимает свою. Возвращает новый набор. */
  toggleReaction(msg: ChatMessage, name: string, emoji: string): ReactionMap {
    const reactions: ReactionMap = msg.reactions ?? (msg.reactions = {});
    const list = reactions[emoji] ?? [];
    if (list.includes(name)) {
      const next = list.filter((n) => n !== name);
      if (next.length) reactions[emoji] = next;
      else delete reactions[emoji];
    } else {
      reactions[emoji] = [...list, name];
    }
    return reactions;
  }

  /**
   * Кладёт ленту канала, удерживая число каналов в пределах MAX_CHAT_ROOMS:
   * самые старые вытесняем (Map хранит порядок вставки), текущий — никогда.
   */
  private remember(room: string, list: ChatMessage[]): void {
    this.history.set(room, list);
    if (this.history.size <= MAX_CHAT_ROOMS) return;
    for (const key of this.history.keys()) {
      if (key === room) continue;
      this.history.delete(key);
      if (this.history.size <= MAX_CHAT_ROOMS) break;
    }
  }
}

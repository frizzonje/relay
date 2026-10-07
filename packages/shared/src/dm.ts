/** Личные сообщения: беседы двоих, список собеседников, непрочитанное. */

import type { CallMark } from './chat';
import type { Person } from './common';

/** С этого начинается адрес беседы. Дальше — 24 знака шестнадцатеричных. */
export const DM_PREFIX = 'dm-';

/** Докуда обрезана последняя реплика в списке переписок. */
export const DM_PREVIEW_LIMIT = 120;

/** Сколько людей отдаётся на один запрос выбора собеседника. */
export const DM_PEOPLE_LIMIT = 30;

/**
 * Беседа это или обычный канал. Проверяем не только префикс, но и форму
 * хвоста: «dm-обсуждение» — законное имя текстового канала, и спутать их
 * значило бы отдать его ленту под правила ЛС.
 */
export function isDmSlug(slug: string): boolean {
  return /^dm-[0-9a-f]{24}$/.test(slug);
}

/**
 * С этого начинается имя голосовой комнаты беседы — той, в которую принятый
 * вызов сажает двоих.
 *
 * Приставка не украшение: адрес беседы это ещё и слаг её ленты, а комнаты
 * socket.io у ленты и у эфира общие. Без неё сигналинг звонка уезжал бы
 * каждому, кто просто открыл переписку.
 */
export const CALL_ROOM_PREFIX = 'voice:';

/**
 * Комната беседы по её адресу. Считать её клиент не может (адрес выводится из
 * id личностей, а их в протоколе нет) — имя приезжает готовым в `call-state`
 * с состоянием `accepted`; эта функция лишь называет правило, по которому
 * сервер его составил.
 */
export function callRoomOf(address: string): string {
  return CALL_ROOM_PREFIX + address;
}

/**
 * Комната беседы это или обычный голосовой канал. Проверяется форма целиком, а
 * не одна приставка: «voice:болталка» — законное имя комнаты (тот же довод,
 * что у `isDmSlug`).
 */
export function isCallRoom(room: string): boolean {
  return /^voice:dm-[0-9a-f]{24}$/.test(room);
}

/** Человек в списке выбора: собеседник плюс «когда его видели». */
export interface DmPerson extends Person {
  /** 0 — не видели ни разу. */
  lastSeenTs: number;
}

/** Строка раздела ЛС. */
export interface DmConversation {
  /** Адрес беседы: он же слаг ленты, в которую входит `dm-join`. */
  slug: string;
  peer: Person;
  /** Время последней реплики; 0 — переписки ещё не было. */
  lastTs: number;
  /** Последняя реплика, обрезанная до DM_PREVIEW_LIMIT. */
  preview: string;
  previewMine: boolean;
  /**
   * Заполнено, если последняя строка беседы — отметка о пропущенном звонке.
   * `preview` в этом случае несёт запаску сервера («missed call», непереведена
   * намеренно — см. `ChatMessage.call`), а рисовать список обязан своим
   * словом через `t()`: без этого поля список отличался бы от самой отметки в
   * ленте, где ровно то же поле уже переведено.
   */
  call?: CallMark;
}

export interface DmOpenPayload {
  /** Кому пишем. Именно отпечаток: ники не уникальны. */
  fingerprint: string;
}

export type DmOpenResult =
  | { ok: true; conversation: DmConversation }
  /** `unknown` — такой личности инсталляция не знает; `forbidden` — ЛС не для тебя (гость, бан). */
  | { ok: false; error: 'unknown' | 'self' | 'forbidden' };

export interface DmJoinPayload {
  slug: string;
}

export type DmJoinResult = { ok: true } | { ok: false; error: 'unknown' | 'forbidden' };

export type DmListResult =
  | { ok: true; conversations: DmConversation[] }
  | { ok: false; error: 'forbidden' };

export interface DmPeoplePayload {
  /** Поиск по нику или отпечатку. Пусто — просто список. */
  query?: string;
}

export type DmPeopleResult = { ok: true; people: DmPerson[] } | { ok: false; error: 'forbidden' };

/**
 * В беседе написали. Летит ДВОИМ участникам, а не всем, — тем и отличается от
 * `chat-activity`, который рассылается по инсталляции. Превью здесь есть
 * намеренно: список переписок рисует последнюю реплику, и второй запрос ради
 * неё был бы запросом на каждое сообщение.
 */
export interface DmActivityRelay {
  slug: string;
  ts: number;
  preview: string;
  previewMine: boolean;
  peer: Person;
  /** См. `DmConversation.call` — то же поле, тем же путём, что и превью. */
  call?: CallMark;
}

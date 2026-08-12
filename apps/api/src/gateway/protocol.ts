import type { Attachment } from '../uploads';

/**
 * Форма сообщений сигналинга: что приходит от клиента и что уходит ack'ом.
 *
 * Всё, что клиент прислал, объявлено как `unknown`, и это не поза: тело
 * сообщения socket.io не проверяет никто, а обработчик обязан считать его
 * враньём до первой проверки. Типы здесь описывают ФОРМУ разговора, а не
 * гарантию — гарантию даёт разбор в обработчике.
 *
 * Ответы (`*Result`) совпадают по форме с одноимёнными типами из
 * `@relay/shared`: api намеренно не зависит от пакета фронта, поэтому
 * контракт держится совпадением, а не общим импортом.
 *
 * Здесь же — единственный способ читать эти тела (`str`/`trimmed`/`optional`) и
 * потолки полей (`LIMIT`). Раньше разбор был написан тридцать три раза одной и
 * той же строкой с числом внутри, и одно поле в разных обработчиках резалось
 * по-разному просто потому, что копии писались в разные дни.
 */

// ── Как это читать ──────────────────────────────────────────────────────────

/**
 * Потолки полей, приходящих от клиента. Названы по смыслу, а не по месту: тег
 * участника — это двадцать символов в `join`, в `rename` и в `chat-join`, и
 * расходиться эти три числа не должны.
 */
export const LIMIT = {
  /** id сервера — его придумывает клиент, чтобы не ждать ответа. */
  id: 64,
  /** Имя сервера или канала. */
  name: 32,
  /** Тег участника. */
  tag: 20,
  /** Слаг канала, он же имя комнаты. */
  slug: 32,
  /** Значок сервера. */
  emoji: 8,
  /** Реплика чата. */
  message: 500,
  /** Диагностическая веха звонка и её пояснение — только в лог. */
  diagEvent: 48,
  diagDetail: 200,
} as const;

/**
 * Подпись того, кто не назвался. Сервер пишет её в историю чата и в presence,
 * то есть она уезжает клиентам готовой строкой и локалью веба не переводится —
 * английский интерфейс увидит её по-русски. Чинится это не здесь: подпись
 * перестанет быть текстом с сервера, когда участник станет личностью (слой 2
 * плана 1.0), — а до тех пор пусть будет хотя бы в одном месте, а не в семи.
 */
export const ANON_NAME = 'Аноним';

/** Строка из тела как есть. Не строка — пустая строка, а не `undefined`. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Строка из тела, обрезанная по краям и по длине. Не строка — пустая. */
export function trimmed(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * То же, но «поля не было» отличается от «пришло пустым»: `join` кладёт имя на
 * сокет, и там пустая строка и отсутствие имени — разные вещи.
 */
export function optional(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, limit) : undefined;
}

// ── Что присылает клиент ────────────────────────────────────────────────────

export interface JoinPayload {
  room?: unknown;
  name?: unknown;
  clientId?: unknown;
  transport?: unknown;
}

export interface SignalPayload {
  to?: unknown;
  sdp?: unknown;
  candidate?: unknown;
}

export interface ChatPayload {
  room?: unknown;
  name?: unknown;
  text?: unknown;
  uploadId?: unknown;
  replyTo?: unknown;
  spoiler?: unknown;
}

/**
 * Курсор подгрузки ленты вверх: время и id самой верхней реплики, которую
 * клиент уже держит. Пары достаточно и она честнее «страницы номер N» —
 * страницы разъезжаются, когда снизу приходит новое.
 */
export interface ChatHistoryMorePayload {
  beforeTs?: unknown;
  beforeId?: unknown;
}

export interface ChatEditPayload {
  id?: unknown;
  text?: unknown;
}

export interface ChatDeletePayload {
  id?: unknown;
}

export interface ChatReactPayload {
  id?: unknown;
  emoji?: unknown;
}

export interface ServerCreatePayload {
  id?: unknown;
  name?: unknown;
  emoji?: unknown;
  password?: unknown;
}

export interface ServerDeletePayload {
  id?: unknown;
}

export interface ServerStatsPayload {
  id?: unknown;
}

export interface ServerUnlockPayload {
  id?: unknown;
  password?: unknown;
}

export interface ChannelCreatePayload {
  serverId?: unknown;
  type?: unknown;
  name?: unknown;
  mode?: unknown;
}

export interface ChannelModePayload {
  id?: unknown;
  mode?: unknown;
}

export interface ChannelDeletePayload {
  id?: unknown;
}

export interface ChannelRenamePayload {
  id?: unknown;
  name?: unknown;
}

export interface ChannelStatsPayload {
  id?: unknown;
}

export interface InviteCreatePayload {
  room?: unknown;
}

/** Кого выгоняем: socket-id гостя (он же его id в presence и на плитке). */
export interface GuestKickPayload {
  id?: unknown;
}

export interface SfuTokenPayload {
  room?: unknown;
  name?: unknown;
}

/** Диагностическая веха звонка от клиента — уходит в серверный лог как есть. */
export interface VoiceDiagPayload {
  event?: unknown;
  detail?: unknown;
}

// ── Что уходит ack'ом ───────────────────────────────────────────────────────
// Отказ обязан быть внятным: интерфейс объясняет, почему канал остался на
// месте, вместо молчаливого «ничего не произошло».

export type ChannelDeleteResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'occupied' | 'not-owner'; occupants?: number };

export type ChannelRenameResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'bad-name' | 'not-owner' };

export type ChannelStatsResult = { ok: true; occupants: number; messages: number } | { ok: false };

/**
 * Страница истории. `more` — «выше есть ещё»: без него клиент не отличает
 * начало истории от её края, срезанного ретенцией, и рисует одно вместо
 * другого.
 */
export interface ChatHistoryPage {
  messages: ChatMessage[];
  more: boolean;
}

export type ChatHistoryMoreResult = { ok: true } & ChatHistoryPage;

export type ServerDeleteResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not-found' | 'forbidden' | 'not-owner' | 'occupied';
      occupants?: number;
    };

export type ServerStatsResult =
  | { ok: true; channels: number; messages: number; occupants: number }
  | { ok: false };

export type InviteCreateResult =
  | { ok: true; token: string; exp: number; listen: boolean }
  | { ok: false; error: 'not-found' | 'forbidden' };

/**
 * Отказ в «выгнать» тоже обязан быть внятным: not-found — гость уже вышел сам
 * (частый случай: кнопку жмут вдогонку), forbidden — канал этому сокету не
 * виден либо он сам гость.
 */
export type GuestKickResult = { ok: true } | { ok: false; error: 'not-found' | 'forbidden' };

export type SfuTokenResult =
  | { ok: true; token: string; exp: number; url: string }
  | { ok: false; error: 'forbidden' | 'unavailable' | 'not-in-room' | 'not-sfu' };

// ── Что живёт в состоянии ───────────────────────────────────────────────────

export type ReactionMap = Record<string, string[]>;

/**
 * Снимок цитируемого сообщения (reply) — копией, а не ссылкой: исходное могут
 * отредактировать или удалить, цитата остаётся прежней.
 */
export interface ReplyRef {
  id: string;
  name: string;
  text: string;
}

export interface ChatMessage {
  id?: string;
  name: string;
  text: string;
  ts: number;
  attachment?: Attachment;
  system?: boolean;
  reactions?: ReactionMap;
  replyTo?: ReplyRef;
  editedTs?: number;
}

/**
 * Участник голосового канала в presence. `transport` называет сам клиент в
 * `join`: разъехавшись в транспортах, люди друг друга не слышат вовсе, и знать
 * об этом должны все.
 */
export interface VoicePresenceEntry {
  id: string;
  name: string;
  micOn: boolean;
  deafened: boolean;
  transport: 'p2p' | 'sfu';
  guest?: boolean;
  /** Гость-слушатель: канал под паролем, право говорить ссылка не раздаёт. */
  listen?: boolean;
}

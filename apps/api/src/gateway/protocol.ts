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
 */

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
  | { ok: true; token: string; exp: number }
  | { ok: false; error: 'not-found' | 'forbidden' };

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
}

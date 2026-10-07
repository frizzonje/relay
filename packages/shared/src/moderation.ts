/**
 * Модерация: бан автора реплики, разбан и список забаненных. Права решает
 * сервер — по флагу `moderated` сервера реестра или по владению инсталляцией.
 */

/** Кого банить: сообщение, а `everywhere` — вся инсталляция вместо сервера. */
export interface ModerationBanPayload {
  id: string;
  /** Только владельцу инсталляции. Без него бан действует на текущем сервере. */
  everywhere?: boolean;
}

/** Охват: сервер, а пустой — вся инсталляция (её списки видит только владелец). */
export interface ModerationBansPayload {
  server?: string;
}

export interface ModerationUnbanPayload {
  fingerprint: string;
  server?: string;
}

export type ModerationResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'unknown' };

/** Забаненный так, как его показывают модератору: лицо, имя и след. */
export interface BanEntry {
  fingerprint: string;
  nick: string;
  /** Когда забанен, ISO. */
  at: string;
  /** Ник забанившего; пусто — его личности уже нет. */
  by: string | null;
}

export type ModerationBansResult =
  | { ok: true; bans: BanEntry[] }
  | { ok: false; error: 'forbidden' };

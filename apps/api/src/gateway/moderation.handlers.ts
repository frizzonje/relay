import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import type { Moderation } from './moderation';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import type { RolesService } from '../identity/roles.service';
import {
  str,
  type ModerationBanPayload,
  type ModerationBansPayload,
  type ModerationBansResult,
  type ModerationResult,
  type ModerationUnbanPayload,
} from './protocol';

/**
 * Три события модерации. Тонкие намеренно: чья это власть и что бан делает с
 * живыми сокетами — вопрос `moderation.ts`, здесь только разбор запроса и
 * поход в базу за самой записью о бане.
 */
export class ModerationHandlers {
  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly roles: RolesService,
    private readonly perimeter: Perimeter,
    private readonly moderation: Moderation,
  ) {}

  /**
   * Забанить автора сообщения.
   *
   * Модерирует создатель сервера — своего и только своего; поверх него владелец
   * инсталляции, который может и это, и бан на всю инсталляцию. Охват
   * спрашивается явно (`everywhere`): человек, выгоняющий кого-то со своего
   * сервера, не должен случайно закрыть ему всю инсталляцию.
   *
   * Целью служит сообщение, а не имя: имена не уникальны, а сказанное
   * однозначно указывает на своего автора. Автор-гость забанить себя не даёт —
   * его личности нет, за него ручается токен приглашения, и разговор с ним
   * заканчивается через `guest-kick`.
   */
  async ban(
    client: AppSocket,
    payload: ModerationBanPayload,
  ): Promise<ModerationResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const me = this.perimeter.speaker(client);
    if (!me) return { ok: false, error: 'forbidden' };
    const room = this.chats.roomOf(client);
    if (!room) return { ok: false, error: 'forbidden' };
    const channel = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!channel || !this.moderation.mayModerate(client, channel)) return { ok: false, error: 'forbidden' };

    const everywhere = payload?.everywhere === true;
    // Бан на всю инсталляцию — только владельцу: у создателя сервера власти
    // ровно на свой сервер, и расширять её нечем.
    if (everywhere && !this.perimeter.isOwner(client)) return { ok: false, error: 'forbidden' };

    const id = str(payload?.id);
    const authorId = id ? await this.chat.authorOf(this.chat.slug(room), id) : null;
    if (!authorId) return { ok: false, error: 'not-found' };

    const scope = everywhere ? null : channel.serverId;
    const done = await this.roles.ban(authorId, scope, me.id);
    if (!done.ok) return { ok: false, error: done.reason === 'unknown' ? 'unknown' : 'forbidden' };
    this.moderation.applyBan(authorId, scope);
    return { ok: true };
  }

  /** Разбанить по отпечатку — той же ручкой, которой забаненный показан. */
  async unban(
    client: AppSocket,
    payload: ModerationUnbanPayload,
  ): Promise<ModerationResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const scope = this.moderation.scopeFor(client, str(payload?.server));
    if (scope === undefined) return { ok: false, error: 'forbidden' };
    const identityId = await this.roles.byFingerprint(payload?.fingerprint);
    if (!identityId) return { ok: false, error: 'not-found' };
    if (!(await this.roles.unban(identityId, scope))) return { ok: false, error: 'not-found' };
    this.moderation.liftBan(identityId, scope);
    return { ok: true };
  }

  /** Кто забанен: на этом сервере или, если сервер не назван, на инсталляции. */
  async list(
    client: AppSocket,
    payload: ModerationBansPayload,
  ): Promise<ModerationBansResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const scope = this.moderation.scopeFor(client, str(payload?.server));
    if (scope === undefined) return { ok: false, error: 'forbidden' };
    return { ok: true, bans: await this.roles.bans(scope) };
  }

}

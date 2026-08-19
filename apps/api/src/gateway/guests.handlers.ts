import type { Logger } from '@nestjs/common';
import type { AppServer, AppSocket } from './socket-data';
import type { Directory } from './directory';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import type { VoiceSessions } from './voice-sessions';
import { issueGuestToken } from '../auth/auth';
import {
  LIMIT,
  trimmed,
  type GuestKickPayload,
  type GuestKickResult,
  type InviteCreatePayload,
  type InviteCreateResult,
} from './protocol';

/**
 * Инвайт-ссылки: выдать и выгнать по ней пришедшего.
 *
 * Оба события держатся на одном правиле: **по ссылке раздают ровно то, что
 * имеет сам приглашающий**. Пароля он не отдавал, поэтому канал закрытого
 * сервера зовёт гостя слушателем — ссылка, раздающая право говорить в закрытом
 * канале, обошла бы пароль одним сообщением в чужом чате. И симметрично:
 * выгнать гостя может любой не-гость, кому виден сам канал, — а гостю гостя не
 * выгнать, иначе ссылка, разосланная куда попало, становилась бы кнопкой
 * «выгнать всех остальных».
 */
export class GuestHandlers {
  constructor(
    private readonly registry: RegistryService,
    private readonly voice: VoiceSessions,
    private readonly perimeter: Perimeter,
    private readonly directory: Directory,
    private readonly serverOf: () => AppServer,
    private readonly logger: Logger,
  ) {}

  private get server(): AppServer {
    return this.serverOf();
  }

  // Инвайт на войс-канал: подписанный токен без хранения на сервере (24 часа,
  // многоразовый). Абсолютный URL строит клиент из window.location.origin.
  // Возвращаемое значение = socket.io ack.
  //
  // Канал закрытого сервера зовёт гостя СЛУШАТЕЛЕМ. Приглашающий раздаёт по
  // ссылке ровно то, что имеет сам, — а пароля он не отдавал: голос в закрытом
  // канале держится на том же пароле, что и всё остальное, и ссылка,
  // раздающая право говорить, обошла бы его одним сообщением в чужом чате.
  // Слышать при этом гость должен: за этим его и звали.
  createInvite(
    client: AppSocket,
    payload: InviteCreatePayload,
  ): InviteCreateResult {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const slug = trimmed(payload?.room, LIMIT.slug);
    // Канал должен существовать, быть голосовым и быть видимым этому сокету
    // (каналы закрытых серверов — только после ввода пароля).
    const channel = this.directory.channelsFor(client).find((c) => c.type === 'voice' && c.slug === slug);
    if (!channel) return { ok: false, error: 'not-found' };
    const listen = this.isLockedChannel(slug);
    const { token, exp } = issueGuestToken(slug, { listen });
    return { ok: true, token, exp, listen };
  }

  /** Канал закрытого сервера: сам канал в реестре и за ним сервер с паролем. */
  private isLockedChannel(slug: string): boolean {
    const channel = this.registry.channels.find((c) => c.type === 'voice' && c.slug === slug);
    return !!channel && !!this.registry.serverOf(channel)?.passwordHash;
  }

  /**
   * Выгнать гостя из эфира. Право на это есть у любого НЕ-гостя, кому виден сам
   * канал: гость в комнате — тот, кого сюда позвали по ссылке, и отвечает за
   * него вся комната, а не один владелец. Гостю гостя не выгнать — иначе
   * ссылка, разосланная в чужой чат, становилась бы кнопкой «выгнать всех
   * остальных».
   */
  kick(
    client: AppSocket,
    payload: GuestKickPayload,
  ): GuestKickResult {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = trimmed(payload?.id, LIMIT.id);
    const target = id ? this.server.sockets.sockets.get(id) : undefined;
    if (!target || !this.perimeter.isGuest(target)) return { ok: false, error: 'not-found' };
    const room = this.voice.roomOf(target);
    if (!room) return { ok: false, error: 'not-found' };
    // Канал закрытого сервера запирает и это: не введя пароль, ты не видишь ни
    // канала, ни того, кто в нём сидит, — значит и выгонять оттуда некого.
    if (!this.perimeter.mayEnter(client, room)) return { ok: false, error: 'forbidden' };

    this.perimeter.banGuest(target, room);
    // Сокет не рвём: гость должен УВИДЕТЬ, что произошло, а разорванное
    // соединение он бы просто переподключил и гадал, куда делся звук. Выписки
    // из комнаты и закрытой двери на обратный вход довольно.
    target.emit('kicked', { room });
    this.voice.leave(target);
    this.logger.log(
      `guest ${this.voice.nameOf(target) || '?'} (${target.id}) kicked from "${room}" by ${client.id}`,
    );
    return { ok: true };
  }

}

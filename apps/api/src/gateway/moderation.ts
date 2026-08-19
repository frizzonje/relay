import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import type { Directory } from './directory';
import type { Perimeter } from './perimeter';
import type { RegistryService } from './registry.service';
import type { VoiceSessions } from './voice-sessions';
import { Channel, ServerEntry } from './registry';
import { moderatedBy } from './ownership';

/**
 * Кто здесь модератор и что происходит, когда он банит.
 *
 * Два предмета в одном файле не случайно: право модерировать спрашивают из
 * четырёх мест (бан, разбан, список банов, удаление чужого сообщения), а
 * применяют его ровно в одном — и оба раза речь об одном и том же вопросе,
 * «чья это власть и докуда она достаёт».
 *
 * Право здесь НЕ то же, что право править запись реестра (`ownedBy`), и
 * разница стоит того, чтобы её написать. Там «создателя нет» означает «права
 * общие» — иначе сервер, созданный до самого правила владения, никто не смог
 * бы даже переименовать. Здесь такое послабление означало бы, что на главном
 * сервере любой удаляет чужие сообщения и банит кого хочет: создателя у него
 * нет и быть не может.
 *
 * Поэтому модерация требует названного хозяина — личность создателя, — либо
 * владельца инсталляции. Унаследованный clientId власти не даёт: он лежит в
 * localStorage и подделывается, а удаление чужих слов и бан — не то, что
 * доверяют строке из чужого браузера.
 */
export class Moderation {
  constructor(
    private readonly registry: RegistryService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly voice: VoiceSessions,
    private readonly perimeter: Perimeter,
    private readonly directory: Directory,
  ) {}

  /**
   * Охват, которым этому сокету позволено распоряжаться: названный сервер (если
   * он его модерирует) или вся инсталляция (если он владелец). `undefined` —
   * не позволено ничего, и это отличается от `null`, который и есть инсталляция.
   */
  scopeFor(client: AppSocket, id: string): string | null | undefined {
    if (!id) return this.perimeter.isOwner(client) ? null : undefined;
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv || !this.perimeter.isOpenTo(client, srv)) return undefined;
    return this.moderates(client, srv) ? id : undefined;
  }

  /** Модерирует ли этот сокет сервер, которому принадлежит эта комната чата. */
  moderatesRoom(client: AppSocket, room: string): boolean {
    const slug = this.chat.slug(room);
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    return !!channel && this.mayModerate(client, channel);
  }

  /** Модерирует ли этот сокет сервер, которому принадлежит канал. */
  mayModerate(client: AppSocket, channel: Channel): boolean {
    const srv = this.registry.serverOf(channel);
    return !!srv && this.perimeter.isOpenTo(client, srv) && this.moderates(client, srv);
  }

  /** То же правило, но про сам сервер. Считается там же, где рисуется флаг. */
  private moderates(client: AppSocket, srv: ServerEntry): boolean {
    return moderatedBy(srv, this.perimeter.claimant(client));
  }

  /**
   * Бан вступает в силу немедленно, под живыми сокетами.
   *
   * Иначе он не значил бы почти ничего: забаненный дописывал бы в канал до тех
   * пор, пока сам не переподключится, — то есть ровно столько, сколько длится
   * скандал, из-за которого его и банили.
   *
   * На всю инсталляцию — отключаем: пускать обратно его уже не будут, и держать
   * соединение незачем. С сервера — выписываем из его комнат и раздаём заново
   * реестр: остальная инсталляция для человека продолжается.
   */
  applyBan(identityId: string, serverId: string | null): void {
    for (const sock of this.perimeter.socketsOf(identityId)) {
      if (serverId === null) {
        sock.emit('banned');
        sock.disconnect(true);
        continue;
      }
      this.perimeter.noteBannedFrom(sock, serverId);
      this.evictFrom(sock, serverId);
      sock.emit('servers', this.directory.serversFor(sock));
      sock.emit('channels', this.directory.channelsFor(sock));
    }
  }

  /** Разбан под живым сокетом: сервер возвращается на место сам. */
  liftBan(identityId: string, serverId: string | null): void {
    if (serverId === null) return;
    for (const sock of this.perimeter.socketsOf(identityId)) {
      this.perimeter.bannedFrom(sock)?.delete(serverId);
      sock.emit('servers', this.directory.serversFor(sock));
      sock.emit('channels', this.directory.channelsFor(sock));
    }
  }

  /** Выписать сокет из эфира и ленты этого сервера — там ему больше нельзя. */
  private evictFrom(client: AppSocket, serverId: string): void {
    const voice = this.voice.roomOf(client);
    const chat = this.chats.roomOf(client);
    for (const channel of this.registry.channels) {
      if (channel.serverId !== serverId) continue;
      if (channel.type === 'voice' && voice === channel.slug) this.voice.leave(client);
      if (channel.type === 'text' && chat === this.chat.room(channel.slug)) {
        this.chats.leave(client);
        // С причиной: канал на месте, ушёл человек. Без неё клиент сказал бы
        // ему «канал удалён» — и он пошёл бы искать пропажу, которой нет.
        client.emit('chat-closed', { slug: channel.slug, reason: 'banned' });
      }
    }
  }
}

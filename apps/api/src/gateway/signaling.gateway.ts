import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { AppServer, AppSocket } from './socket-data';
import { ChatSessions } from './chat-sessions';
import { Directory } from './directory';
import { Mentions } from './mentions';
import { Moderation } from './moderation';
import { ChatHandlers } from './chat.handlers';
import { PersonalHandlers } from './personal.handlers';
import { RegistryHandlers } from './registry.handlers';
import { VoiceHandlers } from './voice.handlers';
import { Perimeter } from './perimeter';
import { VoiceSessions } from './voice-sessions';
import { isAuthorized, issueGuestToken, verifyGuestToken } from '../auth/auth';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { UploadsService } from '../uploads';
import { ChatService } from './chat.service';
import {
  RegistryService,
} from './registry.service';
import {
  normalizeClientId,
} from './ownership';
import {
  LIMIT,
  str,
  trimmed,
  type ChannelCreatePayload,
  type ChannelDeletePayload,
  type ChannelDeleteResult,
  type ChannelModePayload,
  type ChannelRenamePayload,
  type ChannelRenameResult,
  type ChannelStatsPayload,
  type ChannelStatsResult,
  type ChatDeletePayload,
  type ChatEditPayload,
  type ChatHistoryMorePayload,
  type ChatHistoryMoreResult,
  type ChatSearchResult,
  type ChatWindowResult,
  type ChatHistoryAfterPayload,
  type ChatAroundPayload,
  type ChatSearchPayload,
  type ChatPayload,
  type ChatPinPayload,
  type ChatPinResult,
  type ChatPinsPayload,
  type ChatPinsResult,
  type ChatReactPayload,
  type GuestKickPayload,
  type ModerationBanPayload,
  type ModerationBansPayload,
  type ModerationBansResult,
  type ModerationResult,
  type ModerationUnbanPayload,
  type MentionSuggestPayload,
  type MentionSuggestResult,
  type PrefsSetPayload,
  type ReadMarkPayload,
  type GuestKickResult,
  type InviteCreatePayload,
  type InviteCreateResult,
  type JoinPayload,
  type ServerCreatePayload,
  type ServerDeletePayload,
  type ServerDeleteResult,
  type ServerStatsPayload,
  type ServerStatsResult,
  type ServerUnlockPayload,
  type SfuTokenPayload,
  type SfuTokenResult,
  type SignalPayload,
  type VoiceDiagPayload,
} from './protocol';

/**
 * Отказ во входе забаненному. Уезжает клиенту текстом ошибки подключения —
 * единственным каналом, который у отвергнутого сокета есть. Клиент по этой
 * строке показывает экран «вас забанили», а не бесконечное «переподключаюсь».
 */
export const BANNED_ERROR = 'banned';

@WebSocketGateway({
  // origin: '*' — дефолт для прода (единый origin за Caddy, кука sameSite=lax не
  // уедет на чужой сайт). Если задан CORS_ORIGIN (dev на разных портах) —
  // ограничиваемся им.
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : '*',
  },
  // Кратковременный обрыв (моргание сети) не должен рвать живой звонок: socket.io
  // восстанавливает сессию с тем же id и комнатами в течение этого окна. Выход из
  // комнат при disconnect мы откладываем на сопоставимый грейс (LEAVE_GRACE_MS ≥
  // окна), чтобы при восстановлении никого не «выкинуть» из канала.
  connectionStateRecovery: { maxDisconnectionDuration: 20_000 },
})
export class SignalingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: AppServer;

  constructor(
    private readonly uploads: UploadsService,
    private readonly chat: ChatService,
    private readonly registry: RegistryService,
    private readonly identities: IdentityService,
    private readonly owner: OwnerService,
    private readonly roles: RolesService,
    private readonly reads: ReadsService,
    private readonly prefs: PrefsService,
  ) {}

  private readonly logger = new Logger(SignalingGateway.name);

  /**
   * Контур доступа. Заводится здесь по той же причине, что и голосовая сессия:
   * зависимости у него настоящие (реестр, личности, права), но приезжают они
   * гейтвею от Nest, а не ему.
   */
  private readonly perimeter = new Perimeter(
    this.registry,
    this.identities,
    this.owner,
    this.roles,
    () => this.server,
    this.logger,
  );

  /**
   * Витрина реестра: каким каждый сокет видит серверы и каналы. Отдельно от
   * самого реестра, потому что у каждого сокета она своя — от введённых
   * паролей до собственных записей, — и вся цена рассылки лежит на ней.
   */
  private readonly directory = new Directory(
    this.registry,
    this.chat,
    this.perimeter,
    () => this.server,
  );

  /** Владелец чат-сессии: принадлежность сокета к ленте и подпись в ней. */
  private readonly chats = new ChatSessions(() => this.server, {
    fingerprintOf: (sock) => this.perimeter.speaker(sock)?.fingerprint,
  });

  /**
   * Владелец голосовой сессии. Заводится здесь, а не приезжает от Nest: своих
   * зависимостей у него нет, а спрашивает он ровно то, чем владеют соседи по
   * этому же списку, — личность, гостевой контур и видимость каналов.
   */
  private readonly voice = new VoiceSessions(
    () => this.server,
    {
      fingerprintOf: (sock) => this.perimeter.speaker(sock)?.fingerprint,
      isGuest: (sock) => this.perimeter.isGuest(sock),
      guestRoomOf: (sock) => this.perimeter.guestRoom(sock),
      isListener: (sock) => this.perimeter.isListener(sock),
      visibleVoiceSlugs: (sock) => this.perimeter.visibleVoiceSlugs(sock),
      onGraceExpired: (sock) => this.chats.leave(sock),
    },
    this.logger,
  );

  /** Упоминания: кого назвали, кому сказать, сколько накопилось. */
  private readonly mentions = new Mentions(
    this.registry,
    this.chat,
    this.perimeter,
    () => this.server,
  );

  /**
   * Модерация: чья это власть, докуда достаёт и что делает бан с живыми
   * сокетами. Заводится последней — ей нужны все трое владельцев состояния.
   */
  private readonly moderation = new Moderation(
    this.registry,
    this.chat,
    this.chats,
    this.voice,
    this.perimeter,
    this.directory,
  );

  /** Обработчики текстового канала: лента, история, поиск, реплики. */
  private readonly chatHandlers = new ChatHandlers(
    this.registry,
    this.chat,
    this.chats,
    this.uploads,
    this.perimeter,
    this.directory,
    this.moderation,
    this.mentions,
    () => this.server,
  );

  /** Обработчики реестра: серверы и каналы. */
  private readonly registryHandlers = new RegistryHandlers(
    this.registry,
    this.chat,
    this.chats,
    this.voice,
    this.reads,
    this.perimeter,
    this.directory,
    this.mentions,
    () => this.server,
    this.logger,
  );

  /** Личное: отметки чтения, настройки, имя — всё, что принадлежит человеку. */
  private readonly personalHandlers = new PersonalHandlers(
    this.registry,
    this.chats,
    this.voice,
    this.identities,
    this.reads,
    this.prefs,
    this.perimeter,
    this.mentions,
    this.logger,
  );

  /** Обработчики разговора: вход, выход, негоциация, пропуск в медиасервер. */
  private readonly voiceHandlers = new VoiceHandlers(
    this.registry,
    this.voice,
    this.perimeter,
    this.directory,
    () => this.server,
    this.logger,
  );

  /**
   * Кто говорит — выясняется до первого события, а не в `handleConnection`.
   *
   * Разница не стилистическая: миддлвара socket.io отрабатывает ДО того, как
   * сокет считается подключённым, и до неё клиент физически не может ничего
   * прислать. Узнавай мы личность в обработчике подключения (он синхронный, а
   * запрос в базу — нет), первые сообщения успели бы пройти как «безымянные» —
   * то есть ровно те, которыми открывают канал и здороваются.
   *
   * Отказ не рвёт соединение: без личности живут гость по инвайту и клиент,
   * ещё не прошедший челлендж. Их имена остаются самоназванными, и это честно —
   * ручается за них не ключ, а токен приглашения.
   */
  afterInit(server: AppServer): void {
    server.use((socket, next) => {
      void this.perimeter.recognize(socket).then((banned) => {
        // Забаненного на всю инсталляцию не пускаем внутрь вовсе — отказом
        // самой миддлвары, до `handleConnection`. Причина уезжает клиенту
        // текстом ошибки: белый экран вместо объяснения — худший из ответов
        // на «почему меня не пускает».
        if (banned) {
          next(new Error(BANNED_ERROR));
          return;
        }
        next();
      });
    });
  }

  /**
   * Власть сменилась — пересобрать права живых сокетов.
   *
   * Зовётся из обработчика ссылки владельца: тот, кто её открыл, обязан увидеть
   * свои новые права сразу, а прежний владелец — потерять их, не дожидаясь
   * переподключения. Иначе бывший хозяин ещё часами удалял бы чужие серверы
   * с уже недействительным правом.
   */
  async syncOwner(): Promise<void> {
    await this.perimeter.resyncOwner();
    this.directory.broadcastServers();
    this.directory.broadcastChannels();
  }

  /**
   * Выгнать сокеты отозванного устройства. Личность узнаётся один раз, при
   * подключении (см. `afterInit`), — без этого отозванное устройство говорило
   * бы в каналы до тех пор, пока не переподключится само, то есть часами.
   * Возвращает число выгнанных: отзывать нечего — это тоже нормальный исход.
   */
  dropDevice(deviceId: string): number {
    const sockets = this.perimeter.socketsOfDevice(deviceId);
    for (const socket of sockets) socket.disconnect(true);
    return sockets.length;
  }

  // Presence меняется пачками (заход нескольких, серия media-update) —
  // коалесцируем рассылку в один emit за короткое окно вместо O(n) обхода+emit
  // на каждое событие. 80 мс незаметны на индикаторах мута/эфира.

  // Socket.io цепляется к http-серверу мимо express-миддлвар,
  // поэтому пропуск проверяем прямо в handshake
  handleConnection(client: AppSocket) {
    // Гость по инвайт-ссылке: вместо куки предъявляет подписанный токен в
    // handshake.auth.guest. Валиден → сокет помечен гостем и «пришит» к своему
    // войс-каналу; реестры серверов/каналов ему НЕ шлём (нечего подглядывать),
    // presence — только срез его комнаты.
    const guestRaw = (client.handshake.auth as { guest?: unknown } | undefined)?.guest;
    const guest = typeof guestRaw === 'string' ? verifyGuestToken(guestRaw) : null;
    if (!guest && !isAuthorized(client.handshake)) {
      client.disconnect(true);
      return;
    }
    // Сессия восстановлена после обрыва (тот же id) — отменяем отложенный выход:
    // эфир и текстовые каналы не трогаем, остальные нас и не «теряли».
    this.voice.resume(client);
    // Устройство, с которого пришли: по нему решается владение серверами и
    // каналами (audit B2) и выгоняется «призрак» прошлой вкладки в эфире.
    // Берём из handshake, а не из каждого сообщения: одна точка входа, и id
    // владельца не нужно гонять по протоколу. Клиент прошлой версии поля не
    // пришлёт — его записи останутся без владельца, как и всё, что создано до
    // правила.
    client.data.clientId = normalizeClientId(
      (client.handshake.auth as { clientId?: unknown } | undefined)?.clientId,
    );
    if (guest) {
      this.perimeter.admit(client, guest);
      // Выгнанному дверь не открывается заново: без этого «выгнать» значило бы
      // «подождать пять секунд» — гость возвращается по той же ссылке, она
      // многоразовая и живёт сутки.
      if (this.perimeter.guestBanned(client, guest.slug)) {
        client.emit('kicked', { room: guest.slug });
        return;
      }
      client.emit('voice-presence', this.voice.snapshotFor(client));
      return;
    }
    // Набор серверов, разблокированных этим сокетом (закрытые под паролем).
    // `??=` — чтобы восстановление сессии (CSR) не сбросило уже введённые пароли.
    this.perimeter.ensureUnlocked(client);
    // Пропуска, выданные за уже введённые пароли (см. ./unlock). Читаем их
    // ЗДЕСЬ, до первой рассылки реестра: разберись мы отдельным сообщением
    // после подключения — клиент успел бы получить реестр без своих закрытых
    // серверов, а вместе с ним и полную картину «каналы пропали».
    this.perimeter.restoreUnlocked(client);
    // Новому клиенту сразу шлём реестры серверов и каналов и кто где в голосовых.
    // Серверы — публичная форма (без хэшей, с флагом locked); каналы — только
    // видимые ему (закрытые серверы скрыты до ввода пароля).
    client.emit('servers', this.directory.serversFor(client));
    client.emit('channels', this.directory.channelsFor(client));
    client.emit('voice-presence', this.voice.snapshotFor(client));
    // Своё личное — отметки чтения и настройки. Отдельно от реестра и позже
    // него: за ними надо в базу, а реестр уже здесь, и задерживать первый кадр
    // приложения ради громкостей незачем.
    void this.personalHandlers.send(client);
  }

  // ===== Реестр: серверы и каналы =====

  @SubscribeMessage('server-create')
  handleServerCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerCreatePayload,
  ) {
    return this.registryHandlers.createServer(client, payload);
  }

  @SubscribeMessage('server-unlock')
  handleServerUnlock(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerUnlockPayload,
  ) {
    return this.registryHandlers.unlockServer(client, payload);
  }

  @SubscribeMessage('server-delete')
  handleServerDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerDeletePayload,
  ): Promise<ServerDeleteResult> {
    return this.registryHandlers.deleteServer(client, payload);
  }

  @SubscribeMessage('server-stats')
  handleServerStats(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerStatsPayload,
  ): Promise<ServerStatsResult> {
    return this.registryHandlers.serverStats(client, payload);
  }

  @SubscribeMessage('channel-create')
  handleChannelCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelCreatePayload,
  ) {
    return this.registryHandlers.createChannel(client, payload);
  }

  @SubscribeMessage('channel-mode')
  handleChannelMode(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelModePayload,
  ) {
    return this.registryHandlers.channelMode(client, payload);
  }

  @SubscribeMessage('channel-stats')
  handleChannelStats(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelStatsPayload,
  ): Promise<ChannelStatsResult> {
    return this.registryHandlers.channelStats(client, payload);
  }

  @SubscribeMessage('channel-rename')
  handleChannelRename(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelRenamePayload,
  ): Promise<ChannelRenameResult> {
    return this.registryHandlers.renameChannel(client, payload);
  }

  @SubscribeMessage('channel-delete')
  handleChannelDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelDeletePayload,
  ): Promise<ChannelDeleteResult> {
    return this.registryHandlers.deleteChannel(client, payload);
  }

  // ===== Личное: непрочитанное, настройки, имя =====

  @SubscribeMessage('read-mark')
  handleReadMark(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ReadMarkPayload,
  ): Promise<void> {
    return this.personalHandlers.readMark(client, payload);
  }

  @SubscribeMessage('prefs-set')
  handlePrefsSet(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: PrefsSetPayload,
  ): Promise<void> {
    return this.personalHandlers.setPref(client, payload);
  }

  @SubscribeMessage('rename')
  handleRename(@ConnectedSocket() client: AppSocket, @MessageBody() payload: { name?: unknown }) {
    return this.personalHandlers.rename(client, payload);
  }

  // ===== Модерация =====

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
  @SubscribeMessage('moderation-ban')
  async handleModerationBan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationBanPayload,
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
  @SubscribeMessage('moderation-unban')
  async handleModerationUnban(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationUnbanPayload,
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
  @SubscribeMessage('moderation-bans')
  async handleModerationBans(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationBansPayload,
  ): Promise<ModerationBansResult> {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return { ok: false, error: 'forbidden' };
    const scope = this.moderation.scopeFor(client, str(payload?.server));
    if (scope === undefined) return { ok: false, error: 'forbidden' };
    return { ok: true, bans: await this.roles.bans(scope) };
  }

  // ===== Инвайт-ссылки =====

  // Инвайт на войс-канал: подписанный токен без хранения на сервере (24 часа,
  // многоразовый). Абсолютный URL строит клиент из window.location.origin.
  // Возвращаемое значение = socket.io ack.
  //
  // Канал закрытого сервера зовёт гостя СЛУШАТЕЛЕМ. Приглашающий раздаёт по
  // ссылке ровно то, что имеет сам, — а пароля он не отдавал: голос в закрытом
  // канале держится на том же пароле, что и всё остальное, и ссылка,
  // раздающая право говорить, обошла бы его одним сообщением в чужом чате.
  // Слышать при этом гость должен: за этим его и звали.
  @SubscribeMessage('invite-create')
  handleInviteCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: InviteCreatePayload,
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
  @SubscribeMessage('guest-kick')
  handleGuestKick(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: GuestKickPayload,
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
      `guest ${target.data.name || '?'} (${target.id}) kicked from "${room}" by ${client.id}`,
    );
    return { ok: true };
  }

  // ===== Разговор =====

  @SubscribeMessage('sfu-token')
  handleSfuToken(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: SfuTokenPayload,
  ): Promise<SfuTokenResult> {
    return this.voiceHandlers.sfuToken(client, payload);
  }

  @SubscribeMessage('voice-diag')
  handleVoiceDiag(@ConnectedSocket() client: AppSocket, @MessageBody() payload: VoiceDiagPayload) {
    this.voiceHandlers.diag(client, payload);
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: AppSocket, @MessageBody() payload: JoinPayload) {
    this.voiceHandlers.join(client, payload);
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: AppSocket) {
    this.voiceHandlers.leave(client);
  }

  @SubscribeMessage('offer')
  handleOffer(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.voiceHandlers.offer(client, payload);
  }

  @SubscribeMessage('answer')
  handleAnswer(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.voiceHandlers.answer(client, payload);
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.voiceHandlers.iceCandidate(client, payload);
  }

  @SubscribeMessage('media-update')
  handleMediaUpdate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody()
    payload: { camOn?: unknown; screenOn?: unknown; micOn?: unknown; deafened?: unknown },
  ) {
    this.voiceHandlers.mediaUpdate(client, payload);
  }

  // ===== Текстовый канал =====

  @SubscribeMessage('chat-join')
  handleChatJoin(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatPayload) {
    return this.chatHandlers.join(client, payload);
  }

  @SubscribeMessage('chat-history-more')
  handleChatHistoryMore(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatHistoryMorePayload,
  ): Promise<ChatHistoryMoreResult> {
    return this.chatHandlers.older(client, payload);
  }

  @SubscribeMessage('chat-history-after')
  handleChatHistoryAfter(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatHistoryAfterPayload,
  ): Promise<ChatWindowResult> {
    return this.chatHandlers.newer(client, payload);
  }

  @SubscribeMessage('chat-around')
  handleChatAround(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatAroundPayload,
  ): Promise<ChatWindowResult> {
    return this.chatHandlers.around(client, payload);
  }

  @SubscribeMessage('chat-search')
  handleChatSearch(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatSearchPayload,
  ): Promise<ChatSearchResult> {
    return this.chatHandlers.search(client, payload);
  }

  @SubscribeMessage('mention-suggest')
  handleMentionSuggest(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: MentionSuggestPayload,
  ): Promise<MentionSuggestResult> {
    return this.chatHandlers.mentionSuggest(client, payload);
  }

  @SubscribeMessage('chat-leave')
  handleChatLeave(@ConnectedSocket() client: AppSocket) {
    this.chatHandlers.leave(client);
  }

  @SubscribeMessage('chat-message')
  handleChatMessage(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatPayload) {
    return this.chatHandlers.message(client, payload);
  }

  @SubscribeMessage('chat-edit')
  handleChatEdit(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatEditPayload) {
    return this.chatHandlers.edit(client, payload);
  }

  @SubscribeMessage('chat-delete')
  handleChatDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatDeletePayload,
  ) {
    return this.chatHandlers.remove(client, payload);
  }

  @SubscribeMessage('chat-pin')
  handleChatPin(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatPinPayload,
  ): Promise<ChatPinResult> {
    return this.chatHandlers.pin(client, payload);
  }

  @SubscribeMessage('chat-pins')
  handleChatPins(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatPinsPayload,
  ): Promise<ChatPinsResult> {
    return this.chatHandlers.pins(client, payload);
  }

  @SubscribeMessage('chat-typing')
  handleChatTyping(@ConnectedSocket() client: AppSocket) {
    this.chatHandlers.typing(client);
  }

  @SubscribeMessage('chat-react')
  handleChatReact(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatReactPayload) {
    return this.chatHandlers.react(client, payload);
  }

  handleDisconnect(client: AppSocket) {
    // Не выходим из комнат сразу: даём socket.io шанс восстановить сессию (тот же
    // id, те же комнаты). Если за грейс-период клиент не вернулся — тогда уже
    // выходим и уведомляем остальных. Так моргание сети не обрывает живой звонок.
    this.voice.hold(client);
  }


}

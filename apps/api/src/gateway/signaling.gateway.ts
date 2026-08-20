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
import { GuestHandlers } from './guests.handlers';
import { ModerationHandlers } from './moderation.handlers';
import { PersonalHandlers } from './personal.handlers';
import { RegistryHandlers } from './registry.handlers';
import { VoiceHandlers } from './voice.handlers';
import { Perimeter } from './perimeter';
import { VoiceSessions } from './voice-sessions';
import { isAuthorized, verifyGuestToken } from '../auth/auth';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { UploadsService } from '../uploads';
import { ChatService } from './chat.service';
import { RegistryService } from './registry.service';
import {
  type ChannelCreatePayload,
  type ChannelDeletePayload,
  type ChannelDeleteResult,
  type ChannelModePayload,
  type ChannelRenamePayload,
  type ChannelRenameResult,
  type ChannelStatsPayload,
  type ChannelStatsResult,
  type ChatAroundPayload,
  type ChatDeletePayload,
  type ChatEditPayload,
  type ChatHistoryAfterPayload,
  type ChatHistoryMorePayload,
  type ChatHistoryMoreResult,
  type ChatPayload,
  type ChatPinPayload,
  type ChatPinResult,
  type ChatPinsPayload,
  type ChatPinsResult,
  type ChatReactPayload,
  type ChatSearchPayload,
  type ChatSearchResult,
  type ChatWindowResult,
  type GuestKickPayload,
  type GuestKickResult,
  type InviteCreatePayload,
  type InviteCreateResult,
  type JoinPayload,
  type MentionSuggestPayload,
  type MentionSuggestResult,
  type ModerationBanPayload,
  type ModerationBansPayload,
  type ModerationBansResult,
  type ModerationResult,
  type ModerationUnbanPayload,
  type PrefsSetPayload,
  type ReadMarkPayload,
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
/**
 * Точка входа Nest: приём подключения, разбор кто это, и маршрут события к
 * тому, кто им занимается.
 *
 * Логики здесь нет намеренно, и список полей ниже объясняет почему. Сначала
 * идут владельцы состояния — контур доступа, витрина реестра, чат-сессия,
 * голосовая сессия, — и только потом обработчики, которые их спрашивают.
 * Порядок объявления здесь и есть порядок инициализации: обработчик, заведённый
 * раньше своего владельца, получил бы `undefined`, и сборка об этом честно
 * скажет (TS2729).
 *
 * Всё, что живёт на сокете, живёт у владельцев: в этом файле не осталось ни
 * одного обращения к `client.data`. Ровно из-за его отсутствия здесь и появился
 * когда-то забытый `sfuPassRoom` — см. docs/plans/old/core-refactor.md.
 */
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

  /** Три события модерации: бан, разбан, список. */
  private readonly moderationHandlers = new ModerationHandlers(
    this.registry,
    this.chat,
    this.chats,
    this.roles,
    this.perimeter,
    this.moderation,
  );

  /** Инвайт-ссылки: выдать и выгнать по ней пришедшего. */
  private readonly guestHandlers = new GuestHandlers(
    this.registry,
    this.voice,
    this.perimeter,
    this.directory,
    () => this.server,
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
    // каналами и выгоняется «призрак» прошлой вкладки в эфире.
    this.perimeter.rememberDevice(
      client,
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

  // ===== Модерация и гости =====

  @SubscribeMessage('moderation-ban')
  handleModerationBan(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationBanPayload,
  ): Promise<ModerationResult> {
    return this.moderationHandlers.ban(client, payload);
  }

  @SubscribeMessage('moderation-unban')
  handleModerationUnban(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationUnbanPayload,
  ): Promise<ModerationResult> {
    return this.moderationHandlers.unban(client, payload);
  }

  @SubscribeMessage('moderation-bans')
  handleModerationBans(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationBansPayload,
  ): Promise<ModerationBansResult> {
    return this.moderationHandlers.list(client, payload);
  }

  @SubscribeMessage('invite-create')
  handleInviteCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: InviteCreatePayload,
  ): InviteCreateResult {
    return this.guestHandlers.createInvite(client, payload);
  }

  @SubscribeMessage('guest-kick')
  handleGuestKick(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: GuestKickPayload,
  ): GuestKickResult {
    return this.guestHandlers.kick(client, payload);
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

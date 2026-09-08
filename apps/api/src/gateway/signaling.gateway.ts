import { Logger, type OnModuleDestroy } from '@nestjs/common';
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
import { BackgroundWork } from './background';
import { ChatSessions } from './chat-sessions';
import { Directory } from './directory';
import { Mentions } from './mentions';
import { Moderation } from './moderation';
import { AdminHandlers } from './admin.handlers';
import { ChatHandlers } from './chat.handlers';
import { DmHandlers } from './dm.handlers';
import { GuestHandlers } from './guests.handlers';
import { ModerationHandlers } from './moderation.handlers';
import { PersonalHandlers } from './personal.handlers';
import { RegistryHandlers } from './registry.handlers';
import { RingHandlers } from './ring.handlers';
import { VoiceHandlers } from './voice.handlers';
import { Perimeter } from './perimeter';
import { Presence } from './presence';
import { Rings } from './ring';
import { VoiceSessions, callRoom } from './voice-sessions';
import { isAuthorized, useAddressDoor, verifyGuestToken } from '../auth/auth';
import { IdentityService } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { AuditService } from '../settings/audit.service';
import { OverviewService } from '../settings/overview.service';
import { SettingsService } from '../settings/settings.service';
import { RetentionService } from '../db/retention.service';
import { UploadsService } from '../uploads';
import { ChatService } from './chat.service';
import { DmService } from './dm.service';
import { RegistryService } from './registry.service';
import {
  PROTOCOL_VERSION,
  type AdminActionPayload,
  type AdminActionResult,
  type AdminAuditPayload,
  type AdminAuditResult,
  type AdminBansResult,
  type AdminPasswordPayload,
  type AdminPasswordResult,
  type AdminPeoplePayload,
  type AdminPeopleResult,
  type AdminResetPayload,
  type AdminResetResult,
  type AdminSetPayload,
  type AdminSetResult,
  type AdminStateResult,
  type CallReplyResult,
  type CallRingPayload,
  type CallStartPayload,
  type CallStartResult,
  type ChannelCreatePayload,
  type ChannelCreateResult,
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
  type DmJoinPayload,
  type DmJoinResult,
  type DmListResult,
  type DmOpenPayload,
  type DmOpenResult,
  type DmPeoplePayload,
  type DmPeopleResult,
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
  type ServerCreateResult,
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

/**
 * Отказ во входе клиенту не той версии контракта. Тоже текстом ошибки — другого
 * канала у неподключённого сокета нет, — и двумя разными строками: «обнови
 * приложение» и «на этом сервере старая версия relay» это противоположные
 * советы, и дать не тот значит послать человека чинить не то.
 */
export const CLIENT_OUTDATED_ERROR = 'client-outdated';
export const SERVER_OUTDATED_ERROR = 'server-outdated';

/**
 * Отказ во входе на время обслуживания. Тем же каналом и по той же причине, что
 * и бан: у неподключённого сокета другого нет. Строка своя, а не общая с
 * баном, — «сервер закрыт на час» и «вас забанили» человек переживает
 * по-разному, и сказать одно вместо другого значит соврать.
 */
export const MAINTENANCE_ERROR = 'maintenance';

/**
 * Отказ во входе с закрытого адреса. Слово своё, не банное, и это решение, а не
 * оформление: за одним адресом сидит подъезд, институт, оператор, и попавший
 * под маску мог не делать ничего. «Ваш адрес закрыт» и «вас забанили» — разные
 * новости, и делать по ним надо разное.
 */
export const BLOCKED_ERROR = 'blocked';

/**
 * Версия контракта, названная клиентом. `undefined` — не назвал вовсе, то есть
 * клиент старше самого правила: до 1.0 поля не существовало.
 */
function spokenProtocol(auth: unknown): number | undefined {
  const raw = (auth as { protocol?: unknown } | undefined)?.protocol;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

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
export class SignalingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
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
    private readonly dm: DmService,
    private readonly settings: SettingsService,
    private readonly overview: OverviewService,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
  ) {}

  private readonly logger = new Logger(SignalingGateway.name);

  /**
   * Работа, которую гейтвей начал и не ждёт: отметка о пропущенном, узнавание
   * личности на подключении, личные настройки первого кадра. Почему её не
   * ждут и почему при этом обязаны уметь дождаться — в ./background.
   */
  private readonly background = new BackgroundWork((what, err) =>
    this.logger.error(`${what}: ${err}`),
  );

  /**
   * Сервис останавливают — доводим начатое до конца.
   *
   * Зовётся не сам по себе: `app.close()` по SIGTERM/SIGINT (см. main.ts)
   * проходит по провайдерам этим хуком и только потом закрывает соединение с
   * базой. Без него отметка о пропущенном, начатая за секунду до рестарта,
   * упиралась бы в уже закрытую базу — то есть пропущенный звонок пропадал бы
   * ровно так же незаметно, как сам звонок.
   */
  async onModuleDestroy(): Promise<void> {
    await this.background.settled();
  }

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
    this.settings,
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
      // То же правило личности, что у присутствия и дозвона: вкладка с кукой,
      // открывшая инвайт-ссылку, — гость, и одним из двоих в беседе быть не
      // может. Разъедься эти три ответа, гость входил бы в чужой разговор.
      identityOf: (sock) =>
        this.perimeter.isGuest(sock) ? undefined : this.perimeter.speaker(sock)?.id,
      isGuest: (sock) => this.perimeter.isGuest(sock),
      guestRoomOf: (sock) => this.perimeter.guestRoom(sock),
      isListener: (sock) => this.perimeter.isListener(sock),
      visibleVoiceSlugs: (sock) => this.perimeter.visibleVoiceSlugs(sock),
      onGraceExpired: (sock) => this.chats.leave(sock),
      onVoiceChanged: (sock) => this.notePresence(sock),
    },
    this.logger,
  );

  /**
   * Глобальное присутствие личности: где человек вообще, а не кто в этой
   * комнате. Заводится следом за голосовой сессией — «в голосе» оно спрашивает
   * у неё, а больше ни у кого ничего не спрашивает: присутствие глобально по
   * построению, и ни права, ни видимость каналов его не касаются.
   */
  private readonly presence = new Presence(() => this.server, {
    // Гость по инвайту личности не предъявляет — но предъявить её может САМ
    // СОКЕТ: вкладка с кукой личности, открывшая инвайт-ссылку, это гость С
    // личностью (`admit` отсутствия личности не требует). Такому отвечаем
    // «личности нет»: иначе состав инсталляции утекал бы за приглашение, а
    // доккомментарий класса обещает обратное как факт.
    identityOf: (sock) => (this.perimeter.isGuest(sock) ? undefined : this.perimeter.speaker(sock)),
    inVoice: (sock) => this.voice.roomOf(sock) !== undefined,
  });

  /**
   * Владелец живых вызовов: дозвон между двумя людьми — до ответа и не дальше.
   * Заводится следом за присутствием, потому что «занят разговором» спрашивает
   * у него: звонят человеку, а не комнате, и где он сейчас, знает только оно.
   *
   * Все четыре настройки читаются функциями, а не числами: у группы `calls`
   * стоит `applies: 'now'`, и снятая при сборке копия действовала бы до
   * перезапуска процесса.
   */
  private readonly rings = new Rings(() => this.server, {
    // То же правило, что и у присутствия, и по той же причине: гость с кукой
    // личности иначе стал бы и целью звонка, и живым устройством своего
    // хозяина — вызов держался бы на вкладке приглашения.
    identityOf: (sock) => (this.perimeter.isGuest(sock) ? undefined : this.perimeter.speaker(sock)),
    stateOf: (id) => this.presence.stateOf(id),
    ringTimeoutMs: () => this.settings.get<number>('calls.ringTimeoutSeconds') * 1000,
    busyWhenInVoice: () => this.settings.get<boolean>('calls.busyWhenInVoice'),
    marksMissed: () => this.settings.get<boolean>('calls.missedMarkEnabled'),
    // Саму строку пишет лента (`ChatHandlers`), а не владелец вызовов: тот про
    // переписку не знает вовсе и ждать записи в базу не должен — оба конца
    // ждут «чем кончилось» прямо сейчас. Поэтому запись уходит в фоновую
    // работу: здесь её не ждут, но дождаться её можно — на остановке сервиса и
    // на стенде тестов (см. ./background).
    markMissed: (from, to, mark) => {
      this.background.run(
        'отметка о пропущенном не записана',
        this.chatHandlers.noteMissedCall({ id: from.id, nick: from.nick }, to.fingerprint, mark),
      );
    },
    // Принятый вызов открывает комнату беседы — и на этом дозвон кончается.
    // Адрес у неё тот же, что у переписки этих двоих (он считается из их id и
    // только из них), с приставкой `voice:`: комнаты socket.io у ленты и у
    // эфира общие, и без приставки сигналинг звонка уезжал бы всякому, кто
    // просто открыл переписку.
    openRoom: (from, to) =>
      this.voice.openCallRoom(callRoom(DmService.address(from, to)), [from, to]),
  });

  /** Упоминания: кого назвали, кому сказать, сколько накопилось. */
  private readonly mentions = new Mentions(
    this.registry,
    this.chat,
    this.perimeter,
    this.dm,
    this.settings,
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
    this.settings,
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
    this.dm,
    this.settings,
    () => this.server,
  );

  /** Дверь в личную переписку: открыть, войти, список, выбор собеседника. */
  private readonly dmHandlers = new DmHandlers(
    this.dm,
    this.chat,
    this.chats,
    this.perimeter,
    this.settings,
  );

  /** Четыре события дозвона: позвонить, принять, отклонить, дать отбой. */
  private readonly ringHandlers = new RingHandlers(
    this.rings,
    this.dm,
    this.perimeter,
    this.settings,
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
    this.settings,
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
    this.dm,
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
    () => this.server,
  );

  /** Инвайт-ссылки: выдать и выгнать по ней пришедшего. */
  private readonly guestHandlers = new GuestHandlers(
    this.registry,
    this.voice,
    this.perimeter,
    this.directory,
    this.settings,
    () => this.server,
    this.logger,
  );

  /**
   * Панель владельца: настройки, люди, баны, журнал, обслуживание.
   *
   * Заводится последней и берёт почти всех соседей — так и должно быть: панель
   * не заводит своего состояния, она показывает и правит чужое. Дверь у неё
   * своя и проверяется В КАЖДОМ обработчике (см. `admin.handlers.ts`).
   */
  private readonly adminHandlers = new AdminHandlers(
    this.settings,
    this.overview,
    this.audit,
    this.roles,
    this.owner,
    this.identities,
    this.retention,
    this.uploads,
    this.perimeter,
    this.moderation,
    (deviceId) => this.dropDevice(deviceId),
    () => this.server,
  );

  /** Обработчики разговора: вход, выход, негоциация, пропуск в медиасервер. */
  private readonly voiceHandlers = new VoiceHandlers(
    this.registry,
    this.voice,
    this.perimeter,
    this.directory,
    this.settings,
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
    this.watchSettings(server);
    // Список закрытых адресов запирает обе двери, а не одну. Http-гейт стоит
    // перед загрузками и контейнера не знает, поэтому дверь ему передаётся
    // подстановкой — так же, как настройки передают ему пароль инсталляции.
    // Только сокет означал бы, что заблокированный по-прежнему тянет файлы.
    useAddressDoor(this.perimeter.httpDoor());
    server.use((socket, next) => {
      // Версия контракта — раньше всего остального: у сокета, говорящего на
      // другом языке, спрашивать личность бессмысленно. До 1.0 версии не было
      // вовсе, и отставший клиент выглядел не устаревшим, а сломанным: молчащие
      // каналы и вечное «переподключаюсь» вместо одной внятной строки.
      const spoken = spokenProtocol(socket.handshake.auth);
      if (spoken !== PROTOCOL_VERSION) {
        this.logger.warn(
          `отказ во входе: контракт ${spoken ?? 'не назван'} против ${PROTOCOL_VERSION}`,
        );
        next(
          new Error(
            spoken !== undefined && spoken > PROTOCOL_VERSION
              ? SERVER_OUTDATED_ERROR
              : CLIENT_OUTDATED_ERROR,
          ),
        );
        return;
      }
      // Узнавание идёт в базу, а рукопожатие её не ждёт. Регистрируем по
      // тому же правилу, что и остальное начатое: гейтвей, которого
      // останавливают посреди чужого входа, доводит вход до ответа.
      this.background.run(
        'личность на подключении не разобрана',
        this.perimeter.recognize(socket).then((refusal) => {
          // Забаненного на всю инсталляцию — и всякого, кроме владельца, пока
          // идёт обслуживание, — не пускаем внутрь вовсе: отказом самой
          // миддлвары, до `handleConnection`. Причина уезжает клиенту текстом
          // ошибки: белый экран вместо объяснения — худший из ответов на «почему
          // меня не пускает».
          if (refusal) {
            if (refusal === 'banned') {
              next(new Error(BANNED_ERROR));
              return;
            }
            if (refusal === 'blocked') {
              next(new Error(BLOCKED_ERROR));
              return;
            }
            // Текст обслуживания едет ВМЕСТЕ с отказом, а не снимком настроек:
            // снимок приезжает по сокету, которого у отвергнутого как раз и нет.
            // socket.io доставляет `data` рядом с сообщением ошибки — это
            // единственное, что доходит до того, кого не пустили.
            const err = new Error(MAINTENANCE_ERROR) as Error & { data?: unknown };
            const text = this.settings.get<string>('maintenance.message').trim();
            if (text) err.data = { message: text };
            next(err);
            return;
          }
          next();
        }),
      );
    });
  }

  /**
   * Настройку поменяли — сказать об этом всем открытым вкладкам.
   *
   * Без этой подписки настройка доезжала бы только до тех, кто перезагрузит
   * страницу, — то есть была бы половиной настройки: владелец выключает
   * реакции, а человек рядом ещё час жмёт на смайлик и получает отказ.
   *
   * Шлём снимок целиком, а не изменившийся ключ: собирать разницу — значит
   * держать вторую копию состояния и однажды разойтись с первой. Что именно
   * входит в снимок, решает каталог пометкой `client` (см. `snapshot()`):
   * браузеру уезжает то, чем он пользуется, а не всё, что знает сервер.
   *
   * Правки склеиваем в один оборот цикла. Сброс группы будит подписчиков по
   * разу на ключ (`resetGroup`), и без склейки один щелчок владельца обернулся
   * бы сорока рассылками полного снимка каждому сокету.
   */
  private watchSettings(server: AppServer): void {
    let pending = false;
    this.settings.onChange(() => {
      if (pending) return;
      pending = true;
      // Микрозадача, а не таймер: тесты гейтвея живут на поддельных часах, и
      // рассылка, отложенная на `setTimeout`, ждала бы в них того, кто её
      // подтолкнёт.
      void Promise.resolve().then(() => {
        pending = false;
        const snapshot = this.settings.snapshot();
        for (const sock of server.sockets.sockets.values()) sock.emit('settings', snapshot);
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
      // Гостей может не быть вовсе. Проверяем здесь, а не при выдаче ссылки:
      // выданные живут сутки, и выключение обязано закрыть дверь тем, у кого
      // ссылка уже на руках. Отвечаем тем же событием, что и выгнанному, —
      // клиент умеет показать «сюда нельзя», а молча оборванный сокет он
      // переподключал бы вечно.
      if (!this.perimeter.guestsAllowed()) {
        client.emit('kicked', { room: guest.slug });
        return;
      }
      this.perimeter.admit(client, guest);
      // Выгнанному дверь не открывается заново: без этого «выгнать» значило бы
      // «подождать пять секунд» — гость возвращается по той же ссылке, она
      // многоразовая и живёт сутки.
      if (this.perimeter.guestBanned(client, guest.slug)) {
        client.emit('kicked', { room: guest.slug });
        return;
      }
      // Настройки гостю шлём наравне со всеми, в отличие от реестров: снимок
      // публичен по построению (секреты вычистил каталог), а без битрейтов и
      // порога mesh гость звонил бы по чужим числам.
      client.emit('settings', this.settings.snapshot());
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
    // Настройки — первым делом: по ним клиент решает, что показывать и чем
    // резать ввод, и снимок обязан доехать раньше первой ленты.
    client.emit('settings', this.settings.snapshot());
    client.emit('servers', this.directory.serversFor(client));
    client.emit('channels', this.directory.channelsFor(client));
    client.emit('voice-presence', this.voice.snapshotFor(client));
    // Глобальное присутствие — только тому, кто предъявил личность: гостю по
    // инвайту и клиенту без ключа звонить некуда, состав инсталляции им не
    // положен (правило — в ./presence), а пустой список им не событие. Свой
    // приход человек увидит дельтой следом.
    if (this.perimeter.speaker(client)) {
      client.emit('presence', this.presence.snapshot(client));
    }
    this.notePresence(client);
    // Своё личное — отметки чтения и настройки. Отдельно от реестра и позже
    // него: за ними надо в базу, а реестр уже здесь, и задерживать первый кадр
    // приложения ради громкостей незачем.
    this.background.run('личное не доехало', this.personalHandlers.send(client));
  }

  /**
   * Сокет появился или сменил голосовое состояние — сказать об этом
   * присутствию. У сокета без личности присутствия нет вовсе, и звать тут
   * некого (см. ./presence).
   *
   * Из эфира зовётся не отсюда, а из самой голосовой сессии
   * (`onVoiceChanged`): вынимают оттуда не только `leave`, но и бан с сервера,
   * и истёкший грейс, — а перечисляй мы эти пути здесь поимённо, забытый
   * означал бы человека, вечно «звонящего» в глазах остальных.
   */
  private notePresence(client: AppSocket): void {
    const me = this.perimeter.speaker(client)?.id;
    if (me) this.presence.touch(me);
  }

  // ===== Реестр: серверы и каналы =====

  @SubscribeMessage('server-create')
  handleServerCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerCreatePayload,
  ): Promise<ServerCreateResult> {
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
  ): Promise<ChannelCreateResult> {
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

  // ===== Личные сообщения =====

  @SubscribeMessage('dm-open')
  handleDmOpen(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: DmOpenPayload,
  ): Promise<DmOpenResult> {
    return this.dmHandlers.open(client, payload);
  }

  @SubscribeMessage('dm-list')
  handleDmList(@ConnectedSocket() client: AppSocket): Promise<DmListResult> {
    return this.dmHandlers.list(client);
  }

  @SubscribeMessage('dm-join')
  handleDmJoin(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: DmJoinPayload,
  ): Promise<DmJoinResult> {
    return this.dmHandlers.join(client, payload);
  }

  @SubscribeMessage('dm-people')
  handleDmPeople(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: DmPeoplePayload,
  ): Promise<DmPeopleResult> {
    return this.dmHandlers.people(client, payload);
  }

  // ===== Дозвон =====

  @SubscribeMessage('call-start')
  handleCallStart(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CallStartPayload,
  ): CallStartResult {
    return this.ringHandlers.start(client, payload);
  }

  @SubscribeMessage('call-accept')
  handleCallAccept(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CallRingPayload,
  ): CallReplyResult {
    return this.ringHandlers.accept(client, payload);
  }

  @SubscribeMessage('call-decline')
  handleCallDecline(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CallRingPayload,
  ): CallReplyResult {
    return this.ringHandlers.decline(client, payload);
  }

  @SubscribeMessage('call-cancel')
  handleCallCancel(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CallRingPayload,
  ): CallReplyResult {
    return this.ringHandlers.cancel(client, payload);
  }

  // ===== Админ-панель =====
  //
  // Все события панели — только для владельца, и владение проверяет КАЖДЫЙ
  // обработчик сам (`AdminHandlers.me`). Здесь, в маршрутизаторе, проверки нет
  // намеренно: она стояла бы в одном месте на семь событий, и восьмое,
  // добавленное мимо неё, открыло бы настройки инсталляции молча.

  @SubscribeMessage('admin-state')
  handleAdminState(@ConnectedSocket() client: AppSocket): Promise<AdminStateResult> {
    return this.adminHandlers.state(client);
  }

  @SubscribeMessage('admin-set')
  handleAdminSet(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminSetPayload,
  ): Promise<AdminSetResult> {
    return this.adminHandlers.set(client, payload);
  }

  @SubscribeMessage('admin-reset')
  handleAdminReset(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminResetPayload,
  ): Promise<AdminResetResult> {
    return this.adminHandlers.reset(client, payload);
  }

  @SubscribeMessage('admin-people')
  handleAdminPeople(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminPeoplePayload,
  ): Promise<AdminPeopleResult> {
    return this.adminHandlers.people(client, payload);
  }

  @SubscribeMessage('admin-bans')
  handleAdminBans(@ConnectedSocket() client: AppSocket): Promise<AdminBansResult> {
    return this.adminHandlers.bans(client);
  }

  @SubscribeMessage('admin-audit')
  handleAdminAudit(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminAuditPayload,
  ): Promise<AdminAuditResult> {
    return this.adminHandlers.journal(client, payload);
  }

  /** Пароль инсталляции — своя дорога, мимо `admin-set`. */
  @SubscribeMessage('admin-password')
  handleAdminPassword(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminPasswordPayload,
  ): Promise<AdminPasswordResult> {
    return this.adminHandlers.password(client, payload);
  }

  @SubscribeMessage('admin-action')
  handleAdminAction(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: AdminActionPayload,
  ): Promise<AdminActionResult> {
    return this.adminHandlers.action(client, payload);
  }

  handleDisconnect(client: AppSocket) {
    // Не выходим из комнат сразу: даём socket.io шанс восстановить сессию (тот же
    // id, те же комнаты). Если за грейс-период клиент не вернулся — тогда уже
    // выходим и уведомляем остальных. Так моргание сети не обрывает живой звонок.
    this.voice.hold(client);
    // Присутствие, в отличие от эфира, ждать грейса не может: «недавно» — это и
    // есть его собственный грейс, и начаться он обязан в момент обрыва.
    const me = this.perimeter.speaker(client)?.id;
    if (me) this.presence.drop(me);
    // Дозвон грейса не имеет вовсе: оба конца смотрят на экран прямо сейчас, а
    // ушедшее устройство могло быть не последним — кого именно потеряли, решает
    // сам владелец вызовов.
    this.rings.dropSocket(client);
  }
}

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
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppServer, AppSocket } from './socket-data';
import { VoiceSessions } from './voice-sessions';
import { isAuthorized, issueGuestToken, verifyGuestToken } from '../auth/auth';
import { IdentityService, type Speaker } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { PrefsService } from '../identity/prefs.service';
import { ReadsService } from '../identity/reads.service';
import { RolesService } from '../identity/roles.service';
import { sfuHealthy } from '../sfu/sfu-health';
import { issueSfuToken, sfuSecret } from '../sfu/sfu-token';
import { UploadsService } from '../uploads';
import { ChatService, MENTION_SUGGEST_LIMIT, mentionedIn, searchTerms } from './chat.service';
import {
  MAIN_SERVER_ID,
  MAX_CHANNELS,
  MAX_SERVERS,
  RegistryService,
  slugifyChannel,
} from './registry.service';
import { Channel, ServerEntry, VoiceMode } from './registry';
import {
  type Claimant,
  type PublicChannel,
  type PublicServer,
  moderatedBy,
  normalizeClientId,
  ownedBy,
  publicChannel,
} from './ownership';
import {
  UnlockAttempts,
  clientIp,
  hashServerPassword,
  issueUnlockToken,
  verifyServerPassword,
  verifyUnlockToken,
} from './unlock';
import {
  ANON_NAME,
  LIMIT,
  optional,
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
  type MentionRef,
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
  type RosterPerson,
  type SignalPayload,
  type VoiceDiagPayload,
  type VoicePresenceEntry,
} from './protocol';

/**
 * Отказ во входе забаненному. Уезжает клиенту текстом ошибки подключения —
 * единственным каналом, который у отвергнутого сокета есть. Клиент по этой
 * строке показывает экран «вас забанили», а не бесконечное «переподключаюсь».
 */
export const BANNED_ERROR = 'banned';

// Строка для лога: без переводов строк (чтобы клиент не подделал чужие записи)
// и лишних пробелов.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Устройство, с которого пришёл сокет: clientId из handshake, положенный в
// client.data на подключении. Одна точка входа на все реестровые действия —
// в отдельных сообщениях его не спрашиваем и им не верим (см. ./ownership).
function deviceId(client: AppSocket): string | undefined {
  return client.data.clientId;
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
   * Владелец голосовой сессии. Заводится здесь, а не приезжает от Nest: своих
   * зависимостей у него нет, а спрашивает он у гейтвея ровно то, чем гейтвей и
   * владеет, — личность, гостевой контур и видимость каналов.
   */
  private readonly voice = new VoiceSessions(
    () => this.server,
    {
      fingerprintOf: (sock) => this.speaker(sock)?.fingerprint,
      isGuest: (sock) => this.isGuest(sock),
      guestRoomOf: (sock) => (this.isGuest(sock) ? sock.data.guestRoom : undefined),
      isListener: (sock) => this.isListener(sock),
      visibleVoiceSlugs: (sock) => {
        const visible = new Set<string>();
        for (const c of this.registry.channels) {
          if (c.type === 'voice' && this.canSee(sock, c)) visible.add(c.slug);
        }
        return visible;
      },
      onGraceExpired: (sock) => this.leaveChatRoom(sock),
    },
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
      void this.identities
        .fromCookie(socket.handshake.headers.cookie)
        .then(async (speaker) => {
          if (!speaker) return;
          socket.data.identity = speaker;
          // Власть над инсталляцией выясняется здесь же и один раз: её
          // спрашивает каждая рассылка реестра, а меняется она перевыпуском
          // ссылки владельца — событием, у которого есть свой обработчик
          // (см. `syncOwner`).
          socket.data.owner = await this.owner.isOwner(speaker.id);
          const rights = await this.roles.rightsOf(speaker.id);
          socket.data.bannedFrom = rights.bannedFrom;
          socket.data.banned = rights.banned;
        })
        .catch((e) => this.logger.error(`не удалось узнать личность сокета: ${e}`))
        .finally(() => {
          // Забаненного на всю инсталляцию не пускаем внутрь вовсе — отказом
          // самой миддлвары, до `handleConnection`. Причина уезжает клиенту
          // текстом ошибки: белый экран вместо объяснения — худший из ответов
          // на «почему меня не пускает».
          if (socket.data.banned === true) {
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
    const ownerId = await this.owner.ownerId();
    for (const socket of this.server?.sockets.sockets.values() ?? []) {
      socket.data.owner =
        !!ownerId && socket.data.identity?.id === ownerId;
    }
    this.broadcastServers();
    this.broadcastChannels();
  }

  /** Личность этого сокета — или `undefined`: гость, старый клиент, чужой ключ. */
  private speaker(client: AppSocket): Speaker | undefined {
    return client.data.identity;
  }

  /**
   * Кто спрашивает, с точки зрения прав: устройство, личность за ним и власть
   * над инсталляцией. Собирается из того, что уже лежит на сокете, — в базу за
   * этим не ходят: правами интересуется каждая рассылка реестра, а меняются они
   * считанные разы за жизнь инсталляции (см. `syncOwner`).
   */
  private claimant(client: AppSocket): Claimant {
    return {
      clientId: deviceId(client),
      identityId: this.speaker(client)?.id,
      owner: client.data.owner === true,
    };
  }

  /** Серверы, с которых этот сокет забанен. Обычный случай — пустое множество. */
  private bannedFrom(client: AppSocket): Set<string> | undefined {
    return client.data.bannedFrom;
  }

  /** Забанен ли этот сокет с этого сервера. */
  private isBannedFrom(client: AppSocket, serverId: string | undefined): boolean {
    return !!serverId && this.bannedFrom(client)?.has(serverId) === true;
  }

  /**
   * Выгнать сокеты отозванного устройства. Личность узнаётся один раз, при
   * подключении (см. `afterInit`), — без этого отозванное устройство говорило
   * бы в каналы до тех пор, пока не переподключится само, то есть часами.
   * Возвращает число выгнанных: отзывать нечего — это тоже нормальный исход.
   */
  dropDevice(deviceId: string): number {
    let dropped = 0;
    for (const socket of this.server?.sockets.sockets.values() ?? []) {
      if (socket.data.identity?.deviceId !== deviceId) continue;
      socket.disconnect(true);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Имя, под которым сокет говорит. С личностью его называет сервер, а тело
   * сообщения не спрашивают вовсе: иначе identicon рядом с ником оставался бы
   * украшением — представиться чужим именем можно было бы одним `join`.
   */
  private nameOf(client: AppSocket, claimed: string | undefined): string | undefined {
    return this.speaker(client)?.nick ?? claimed;
  }

  // Выгнанные гости: «комната + устройство» → до какого времени дверь закрыта.
  // Ссылка многоразовая и живёт сутки, поэтому без этой карты «выгнать» не
  // значило бы ничего. Час — не наказание, а пауза: он переживает обиду и
  // перезаход, но не превращает случайный клик в приговор до конца инвайта.
  // Хранится в памяти процесса: рестарт api прощает всех, и это честно —
  // серьёзный запрет живёт в пароле сервера, а не здесь.
  private readonly guestBans = new Map<string, number>();
  private static readonly GUEST_BAN_MS = 60 * 60 * 1000;

  // ── Токен-бакет на сокет ────────────────────────────────────────────────
  // Гасим флуд событий, каждое из которых иначе вызывает рассылку на весь
  // сервер (presence/чат/реестр) — O(n) обход+emit на всех. Живому человеку
  // 20 действий/с с запасом хватает (join, мут, сообщения — единицы в минуту),
  // бот на тысячах/с упрётся в пустой бакет. Заодно тормозит перебор пароля
  // закрытого сервера (server-unlock). Негоциацию (offer/answer/ice) НЕ трогаем:
  // она бывает легитимно бурстовой и релеится 1:1, дёшево.
  private static readonly RL_CAPACITY = 40;
  private static readonly RL_REFILL_PER_SEC = 20;

  // Диагностические вехи звонка считаем ОТДЕЛЬНО от действий человека, и это не
  // щедрость, а разделение: вехи шлёт сам клиент, пачкой и ровно в те секунды,
  // когда человек прыгает по каналам, — то есть телеметрия занимала место в том
  // же бакете, из которого через мгновение платит `join`. Не пустить веху в лог
  // не стоит ничего; не пустить `join` — значит оставить человека в канале,
  // которого сервер за ним не числит: его не слышно, а ошибки он не увидит,
  // потому что отказ здесь молчаливый.
  private static readonly DIAG_CAPACITY = 20;
  private static readonly DIAG_REFILL_PER_SEC = 5;

  // ── Разблокировка закрытых серверов ─────────────────────────────────────
  // Общий бакет (20/с) от перебора пароля не защищает: 20 попыток в секунду с
  // сокета, а сокетов можно открыть сколько угодно. Счётчик неудач живёт не на
  // сокете (реконнект обнулял бы его за один round-trip), а на паре «адрес +
  // сервер» — см. ./unlock, там же семафор на одновременные scrypt.
  private readonly unlockAttempts = new UnlockAttempts();

  // Уже проверенные пароли: ключ — HMAC от «хэш + пароль» на случайном ключе
  // процесса (голый sha256 пароля в памяти — плохая идея, а так дамп кучи не
  // даёт ничего). Ради этого кэша всё и затевалось: авто-разблокировка после
  // реконнекта перестаёт быть пересчётом scrypt на каждого вернувшегося.
  private readonly unlockCache = new Map<string, true>();
  private readonly unlockCacheKey = randomBytes(32);
  private static readonly UNLOCK_CACHE_MAX = 500;

  // Ключ вяжем к самому хэшу, а не к id сервера: id можно освободить удалением и
  // занять заново с другим паролем — тогда запись из кэша пустила бы по старому.
  private unlockCacheId(storedHash: string, password: string): string {
    return createHmac('sha256', this.unlockCacheKey)
      .update(storedHash + '\0' + password)
      .digest('base64url');
  }

  // Presence меняется пачками (заход нескольких, серия media-update) —
  // коалесцируем рассылку в один emit за короткое окно вместо O(n) обхода+emit
  // на каждое событие. 80 мс незаметны на индикаторах мута/эфира.

  // То же окно — реестру каналов и пингам активности чата. Обе рассылки идут по
  // всем сокетам, и без коалесцирования работа растёт как квадрат их числа:
  // каждое сообщение с каждого сокета — обход всех остальных.
  private static readonly REGISTRY_DEBOUNCE_MS = 80;
  private channelsTimer: ReturnType<typeof setTimeout> | null = null;
  // slug -> время последней реплики и сервер, под паролем которого канал лежит
  // (null — открытый или неизвестный). Видимость решаем в момент отправки
  // сообщения, а не при сбросе: канал за эти 80 мс могут удалить, и тогда его
  // слаг — уже «неизвестный» — уехал бы посторонним.
  private readonly pendingActivity = new Map<string, { ts: number; locked: string | null }>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  // Списываем токен; false → бакет пуст (флуд), обработчик молча выходит.

  private allow(client: AppSocket): boolean {
    return this.spend(
      client,
      'rl',
      SignalingGateway.RL_CAPACITY,
      SignalingGateway.RL_REFILL_PER_SEC,
    );
  }

  /** Бакет диагностических вех — свой, чтобы телеметрия не съедала звонок. */
  private allowDiag(client: AppSocket): boolean {
    return this.spend(
      client,
      'rlDiag',
      SignalingGateway.DIAG_CAPACITY,
      SignalingGateway.DIAG_REFILL_PER_SEC,
    );
  }

  private spend(
    client: AppSocket,
    key: 'rl' | 'rlDiag',
    capacity: number,
    refillPerSec: number,
  ): boolean {
    const now = Date.now();
    const bucket = client.data[key] ?? {
      tokens: capacity,
      ts: now,
    };
    const elapsed = (now - bucket.ts) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.ts = now;
    client.data[key] = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
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
    // каналами (audit B2) и выгоняется «призрак» прошлой вкладки в эфире.
    // Берём из handshake, а не из каждого сообщения: одна точка входа, и id
    // владельца не нужно гонять по протоколу. Клиент прошлой версии поля не
    // пришлёт — его записи останутся без владельца, как и всё, что создано до
    // правила.
    client.data.clientId = normalizeClientId(
      (client.handshake.auth as { clientId?: unknown } | undefined)?.clientId,
    );
    if (guest) {
      client.data.guest = true;
      client.data.guestRoom = guest.slug;
      // Право говорить приезжает подписанным в токене (см. handleInviteCreate):
      // канал закрытого сервера зовёт слушателем. Сокет запоминает это один раз
      // и на всю сессию — переспрашивать клиента не о чем.
      client.data.guestListen = guest.listen;
      // Выгнанному дверь не открывается заново: без этого «выгнать» значило бы
      // «подождать пять секунд» — гость возвращается по той же ссылке, она
      // многоразовая и живёт сутки.
      if (this.guestBanned(client, guest.slug)) {
        client.emit('kicked', { room: guest.slug });
        return;
      }
      client.emit('voice-presence', this.voice.snapshotFor(client));
      return;
    }
    // Набор серверов, разблокированных этим сокетом (закрытые под паролем).
    // `??=` — чтобы восстановление сессии (CSR) не сбросило уже введённые пароли.
    client.data.unlocked ??= new Set<string>();
    // Пропуска, выданные за уже введённые пароли (см. ./unlock). Читаем их
    // ЗДЕСЬ, до первой рассылки реестра: разберись мы отдельным сообщением
    // после подключения — клиент успел бы получить реестр без своих закрытых
    // серверов, а вместе с ним и полную картину «каналы пропали».
    this.restoreUnlocked(client);
    // Новому клиенту сразу шлём реестры серверов и каналов и кто где в голосовых.
    // Серверы — публичная форма (без хэшей, с флагом locked); каналы — только
    // видимые ему (закрытые серверы скрыты до ввода пароля).
    client.emit('servers', this.publicServersFor(client));
    client.emit('channels', this.channelsFor(client));
    client.emit('voice-presence', this.voice.snapshotFor(client));
    // Своё личное — отметки чтения и настройки. Отдельно от реестра и позже
    // него: за ними надо в базу, а реестр уже здесь, и задерживать первый кадр
    // приложения ради громкостей незачем.
    void this.sendPersonal(client);
  }

  /**
   * Отдать сокету то, что принадлежит человеку, а не браузеру: докуда дочитаны
   * каналы и его настройки.
   *
   * Без личности не шлём ничего — и это не забывчивость. У гостя по инвайту и у
   * браузера, который не смог родить ключ, личности нет, а значит нет и общего
   * между устройствами: их непрочитанное остаётся в localStorage, как и было.
   */
  private async sendPersonal(client: AppSocket): Promise<void> {
    const me = this.speaker(client);
    if (!me) return;
    try {
      const [marks, values] = await Promise.all([
        this.reads.marks(me.id),
        this.prefs.values(me.id),
      ]);
      // `full` — «это весь список». По нему клиент понимает, что может отдать
      // серверу то, что прочитал и настроил без личности, а не только принять.
      client.emit('reads', { marks: this.marksBySlug(marks), full: true });
      client.emit('prefs', { values, full: true });
      // Упоминания — после отметок чтения и не случайно: счётчик считается
      // «сколько раз назвали после того, как канал дочитан», и клиенту он
      // приезжает уже посчитанным, поверх известных ему отметок.
      await this.sendMentions(client);
    } catch (e) {
      // Личное — не то, без чего приложение не работает: без отметок канал
      // просто выглядит непрочитанным. Падать на этом (и уж тем более рвать
      // подключение) хуже, чем показать точку лишний раз.
      this.logger.error(`не удалось отдать личное состояние: ${e}`);
    }
  }

  /**
   * Отметки чтения так, как их зовёт клиент: по слагам. Хранятся они по id
   * канала — переименование не должно зажигать «непрочитано» у всех разом, — а
   * в протоколе канал всю жизнь звался слагом, и заводить ради этого второе имя
   * канала на проводе незачем. Каналы, которых уже нет, отпадают сами.
   */
  private marksBySlug(marks: Map<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const ts = marks.get(channel.id);
      if (ts) out[channel.slug] = ts;
    }
    return out;
  }

  // Гость по инвайту: разрешён только эфир своей комнаты (join/leave/сигналинг/
  // media-update/rename) — остальные обработчики выходят на этом гарде.
  private isGuest(client: AppSocket): boolean {
    return client.data.guest === true;
  }

  /**
   * Слушатель: гость, позванный в канал закрытого сервера. Слышит комнату, но
   * своего медиа не отдаёт. Держится это не на кнопке в интерфейсе — она лишь
   * не врёт человеку, — а на двух настоящих заслонах: пропуск в медиасервер
   * уходит с клеймом `listen` (produce получит отказ), а в прямых звонках
   * входящий звук слушателя отбрасывают сами собеседники по флагу в presence.
   */
  private isListener(client: AppSocket): boolean {
    return client.data.guestListen === true;
  }

  // Публичная форма реестра серверов: без хэша пароля, с флагом `locked` и с
  // `mine` — «этой записью управляешь ты». Наружу уходит именно флаг, а не
  // clientId владельца: рассылать id значило бы раздавать всем то единственное,
  // чем правило владения и держится (см. ./ownership).
  private publicServersFor(client: AppSocket): PublicServer[] {
    const banned = this.bannedFrom(client);
    const all = this.registry.publicServers(this.claimant(client));
    return banned?.size ? all.filter((s) => !banned.has(s.id)) : all;
  }

  // Каналы, видимые сокету: из закрытых серверов — только если он их разблокировал.
  // Текстовым подмешиваем время последнего сообщения: по нему клиент зажигает
  // «непрочитано» сразу после загрузки, не дожидаясь живого `chat-activity`.
  private channelsFor(client: AppSocket): PublicChannel[] {
    const who = this.claimant(client);
    return this.registry.channels
      .filter((c) => this.canSee(client, c))
      .map((c) => publicChannel(c, who, c.type === 'text' ? this.chat.lastTs(c.slug) : 0));
  }

  // Разблокировки этого сокета — набор id закрытых серверов, чьи пароли он ввёл.
  // Набор заводится на подключении (handleConnection, рядом с остальными полями
  // сокета), а читают и пополняют его ТОЛЬКО методы ниже: сырой доступ к
  // нетипизированному client.data расползался по обработчикам, и каждая копия
  // сама решала, что делать с его отсутствием.
  private unlockedOf(client: AppSocket): Set<string> | undefined {
    return client.data.unlocked;
  }

  // Пароль сервера принят — запоминаем разблокировку на этом сокете.
  private markUnlocked(client: AppSocket, serverId: string) {
    this.unlockedOf(client)?.add(serverId);
  }

  /**
   * Восстановить разблокировки по пропускам из handshake. Пропуск подписан
   * хэшем пароля своего сервера (см. ./unlock), так что сменённый пароль
   * отзывает его сам — проверять тут больше нечего.
   *
   * Битые и просроченные пропуска молча пропускаем: клиент предъявляет всё, что
   * у него лежит, и ровно так же выглядит пропуск сервера, который успели
   * открыть, удалить или перепаролить. Отвечать на каждый значило бы
   * рассказывать по одному токену, что стало с сервером, которого спросивший
   * не видит.
   */
  private restoreUnlocked(client: AppSocket) {
    const raw = (client.handshake.auth as { unlock?: unknown } | undefined)?.unlock;
    if (!Array.isArray(raw)) return;
    // Столько же, сколько серверов вообще может быть: больше валидных пропусков
    // не бывает, а перебирать присланное без предела незачем.
    for (const item of raw.slice(0, MAX_SERVERS)) {
      if (typeof item !== 'string' || !item) continue;
      const id = verifyUnlockToken(item, (serverId) => {
        const srv = this.registry.servers.find((s) => s.id === serverId);
        return srv?.passwordHash;
      });
      if (id) this.markUnlocked(client, id);
    }
  }

  // Открыт ли сервер этому сокету: открытый — всем, закрытый — только тому,
  // кто ввёл пароль. Право на сам сервер, не на его каналы (те — canSee).
  private isOpenTo(client: AppSocket, server: ServerEntry): boolean {
    if (this.isBannedFrom(client, server.id)) return false;
    return !server.passwordHash || this.unlockedOf(client)?.has(server.id) === true;
  }

  // Подпись этого сокета в текстовом канале. Имя самоназванное (см. S1 ревизии),
  // но по нему же сверяется авторство правки и удаления, поэтому читается оно
  // в одном месте и с одним запасным вариантом.
  private chatNameOf(client: AppSocket): string {
    return client.data.chatName || ANON_NAME;
  }

  // Видит ли сокет этот канал: закрытый сервер — только после ввода пароля.
  private canSee(client: AppSocket, channel: Channel): boolean {
    if (this.isBannedFrom(client, channel.serverId)) return false;
    return this.registry.canSee(this.unlockedOf(client), channel);
  }

  /**
   * Вправе ли сокет войти в голосовую комнату. Комната, за которой нет канала
   * реестра, — это «сирота» (канал удалили под живым разговором) или комната
   * инвайта: их не запираем, запирать нечего. А вот канал закрытого сервера
   * пускает только по паролю: `join` берёт слаг, и без этой проверки пароль
   * обходится одной строкой, даже когда сам канал в списке не показан.
   */
  private mayEnter(client: AppSocket, room: string): boolean {
    const channel = this.registry.channels.find((c) => c.type === 'voice' && c.slug === room);
    return !channel || this.canSee(client, channel);
  }

  /**
   * Реестр серверов почти одинаков для всех: различает сокеты ровно один бит —
   * `mine` у записей, созданных этим устройством. Поэтому и группируем по
   * владению: у кого в реестре ничего своего нет (подавляющее большинство),
   * получают один и тот же payload, а отдельная сборка достаётся только тем,
   * кто прямо сейчас онлайн и чем-то владеет.
   *
   * Гости пропускаются, как и в рассылке каналов: по инвайту человек пришит к
   * своему эфиру и реестра не получает вовсе — ни на подключении, ни правкой.
   * Сама рассылка идёт на создание/удаление сервера, то есть считанные разы за
   * сессию: обход сокетов здесь ничего не стоит (в отличие от каналов и
   * активности чата, где он и разгонялся до квадрата — см. S4).
   */
  private broadcastServers() {
    const owners = this.registry.ownerIds(this.registry.servers);
    const byOwner = new Map<string, PublicServer[]>();
    for (const sock of this.server.sockets.sockets.values()) {
      if (sock.data.guest === true) continue;
      const key = this.ownerKey(sock, owners);
      let payload = byOwner.get(key);
      if (!payload) {
        payload = this.publicServersFor(sock);
        byOwner.set(key, payload);
      }
      sock.emit('servers', payload);
    }
  }

  // Чем этот сокет отличается от прочих с точки зрения реестра: своими записями
  // и своими банами. Пустая строка — общая группа «не владелец, не забанен», в
  // ней сидит подавляющее большинство. Владелец инсталляции — своя группа на
  // всех: ему принадлежит всё, и второй такой на инсталляции невозможен.
  //
  // Баны обязаны быть в ключе: два сокета с одинаковым владением, но разными
  // банами получают РАЗНЫЕ реестры, и общая группа отдала бы забаненному
  // сервер, с которого его выгнали.
  private ownerKey(client: AppSocket, owners: Set<string>): string {
    const who = this.claimant(client);
    const banned = [...(this.bannedFrom(client) ?? [])].sort().join('\u0004');
    const mine = who.owner
      ? '\u0003owner'
      : [who.identityId, who.clientId].filter((id) => id && owners.has(id)).join('\u0002');
    return banned ? `${mine}\u0005${banned}` : mine;
  }

  /**
   * Каналы у каждого свои (закрытые серверы скрыты до пароля), поэтому рассылка
   * пер-сокетная — и потому же она была самой дорогой в гейтвее: на каждую
   * правку реестра полный обход сокетов, а внутри на каждый — фильтр всех
   * каналов с поиском сервера по id.
   *
   * Считаем иначе. Набор каналов зависит ровно от двух вещей — какие закрытые
   * серверы этот сокет разблокировал и какие каналы созданы им самим. Сокеты с
   * одинаковой парой получают одинаковый ответ, и подавляющее большинство
   * сидит в одной группе (ничего не разблокировано, ничем не владеет).
   * Плюс дебаунс: правки реестра ходят пачками (создание сервера — это сразу
   * servers + channels, удаление — каналы следом за сервером).
   */
  private broadcastChannels() {
    if (this.channelsTimer) return;
    this.channelsTimer = setTimeout(() => {
      this.channelsTimer = null;
      const owners = this.registry.ownerIds(this.registry.channels);
      const byGroup = new Map<string, PublicChannel[]>();
      for (const sock of this.server.sockets.sockets.values()) {
        if (sock.data.guest === true) continue;
        const key =
          this.registry.visibilityKey(this.unlockedOf(sock)) +
          '\u0001' +
          this.ownerKey(sock, owners);
        let payload = byGroup.get(key);
        if (!payload) {
          payload = this.channelsFor(sock);
          byGroup.set(key, payload);
        }
        sock.emit('channels', payload);
      }
    }, SignalingGateway.REGISTRY_DEBOUNCE_MS);
    this.channelsTimer.unref?.();
  }

  // ===== Реестр серверов =====

  @SubscribeMessage('server-create')
  async handleServerCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerCreatePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    // id генерирует клиент — принимаем как есть (санитизируем длину), чтобы он мог
    // сразу открыть новый сервер и создавать в нём каналы, не дожидаясь ответа.
    const id = trimmed(payload?.id, LIMIT.id);
    const name = trimmed(payload?.name, LIMIT.name);
    if (!id || !name) return;
    if (this.registry.servers.length >= MAX_SERVERS) return;
    // Повторный create с тем же id — не плодим дубликаты (напр. ретрай сокета).
    if (this.registry.servers.some((s) => s.id === id)) return;
    const emoji = trimmed(payload?.emoji, LIMIT.emoji) || undefined;
    // Пароль (если задан) → сервер закрытый. Хэшируем, храним только хэш.
    // Хэширование асинхронное и через тот же семафор, что и проверка: в
    // синхронном виде оно стоит десятки миллисекунд ПОЛНОЙ остановки — не пула,
    // а цикла событий, — и цикл «создать закрытый сервер, удалить, повторить»
    // укладывал бы сигналинг с одного сокета.
    const password = str(payload?.password);
    const passwordHash = password ? await hashServerPassword(password) : undefined;
    // Пока считался хэш, реестр мог измениться: тот же id мог занять другой
    // сокет, а свободное место — кончиться.
    if (this.registry.servers.length >= MAX_SERVERS) return;
    if (this.registry.servers.some((s) => s.id === id)) return;

    // Создатель — личность, и он же единственный модератор этого сервера
    // (см. ./ownership). Клиент без ключа (старый или чужой) по-прежнему
    // называется устройством: заслон от ленивого сноса лучше, чем ничего.
    this.registry.servers.push({
      id,
      name,
      emoji,
      removable: true,
      passwordHash,
      ...this.creatorOf(client),
    });
    // Создатель знает пароль — сразу разблокируем сервер для его сокета.
    if (passwordHash) this.markUnlocked(client, id);
    this.broadcastServers();
    // Раздаём каналы заново: у создателя новый сервер уже разблокирован.
    this.broadcastChannels();
    await this.registry.persist();
  }

  @SubscribeMessage('server-unlock')
  async handleServerUnlock(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerUnlockPayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = str(payload?.id);
    const password = str(payload?.password);
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    // Открытый сервер — доступен и так; считаем разблокировку успешной.
    if (!srv.passwordHash) {
      client.emit('server-unlock-result', { id, ok: true });
      return;
    }
    // Этот адрес уже отстрелялся неудачами по этому серверу — до конца простоя
    // даже не считаем хэш. Проверка ДО scrypt — она же и есть то, что не даёт
    // перебору забить пул: сам семафор только ограничивает ущерб.
    const ip = clientIp(client.handshake);
    if (this.unlockAttempts.blockedUntil(ip, id)) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    const cacheKey = this.unlockCacheId(srv.passwordHash, password);
    const ok = this.unlockCache.has(cacheKey)
      ? true
      : await verifyServerPassword(password, srv.passwordHash);
    // Пока считался хэш, сервер могли удалить — тогда разблокировать нечего.
    if (!this.registry.servers.some((s) => s.id === id)) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    if (!ok) {
      // Пишем каждую неудачу, а не только превышение порога: по одной строчке
      // «превышено» не видно ни начала подбора, ни его темпа.
      const { count, until } = this.unlockAttempts.fail(ip, id);
      const cooldown =
        until > Date.now() ? `, cooldown ${Math.round((until - Date.now()) / 1000)}s` : '';
      this.logger.warn(`server-unlock: failed attempt ${count} for "${id}" from ${ip}${cooldown}`);
    }
    if (ok) {
      this.unlockAttempts.succeed(ip, id);
      // Кэш держим ограниченным: ключей ровно столько, сколько разных паролей
      // предъявили, а вытесняем самый старый (Map хранит порядок вставки).
      if (!this.unlockCache.has(cacheKey)) {
        if (this.unlockCache.size >= SignalingGateway.UNLOCK_CACHE_MAX) {
          const oldest = this.unlockCache.keys().next().value;
          if (oldest) this.unlockCache.delete(oldest);
        }
        this.unlockCache.set(cacheKey, true);
      }
      this.markUnlocked(client, id);
      // Пароль подошёл — теперь этому сокету видны каналы сервера…
      client.emit('channels', this.channelsFor(client));
      // …и состав их эфиров. Без этого строки каналов стоят пустыми до первого
      // чужого входа-выхода: присутствие теперь режется по видимости, и
      // прошлую рассылку этот сокет получил ещё запертым.
      client.emit('voice-presence', this.voice.snapshotFor(client));
      // …и счётчики упоминаний в них: снимок на подключении собирался, когда
      // эти каналы были ещё не видны, и «тебя звали» в них молчало бы до
      // следующего захода.
      void this.sendMentions(client);
      // Пропуск на будущие подключения: с ним разблокировка переживает
      // реконнект, а пароль остаётся там, где ему и место, — у человека.
      // Хэш перечитываем: пока считался scrypt, пароль могли сменить, и
      // подписать пропуск прежним значило бы выдать заведомо мёртвый.
      const fresh = this.registry.servers.find((s) => s.id === id);
      if (fresh?.passwordHash) {
        const { token } = issueUnlockToken(id, fresh.passwordHash);
        client.emit('server-unlock-result', { id, ok, token });
        return;
      }
    }
    client.emit('server-unlock-result', { id, ok });
  }

  @SubscribeMessage('server-delete')
  async handleServerDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerDeletePayload,
  ): Promise<ServerDeleteResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    const idx = this.registry.servers.findIndex((s) => s.id === id && s.removable);
    if (idx === -1) return { ok: false, error: 'not-found' };
    // Закрытый сервер удалить может только тот, кто ввёл пароль (разблокировал).
    const srv = this.registry.servers[idx];
    if (!this.isOpenTo(client, srv)) return { ok: false, error: 'forbidden' };
    // Удаляет создатель сервера — или владелец инсталляции, которому
    // принадлежит всё. У записей без создателя (они старше самого правила
    // владения) владельца не существует: права прежние. Заблокировать их
    // удаление навсегда было бы хуже — чужой не нарочно удалит разве что по
    // неосторожности, а лишённый возможности хозяин не восстановит сервер
    // никак. Отказ пишем в лог: чужой снос — событие, а не шум.
    if (!ownedBy(srv, this.claimant(client))) {
      this.logger.warn(`server-delete: "${id}" refused for ${client.id} (not the creator)`);
      return { ok: false, error: 'not-owner' };
    }
    // Живой разговор дороже уборки. Канал с людьми в эфире не удаляется
    // (channel-delete → occupied), и через удаление сервера это правило
    // обходиться не должно: он уносит все свои каналы разом, то есть выбросил
    // бы из разговора сразу всех. Ждём, пока эфир опустеет.
    const occupants = this.voiceOccupantsOfServer(id);
    if (occupants > 0) return { ok: false, error: 'occupied', occupants };
    this.registry.servers.splice(idx, 1);
    // Простой за неудачи вязался к этому id — новому серверу с тем же id он
    // достаться не должен.
    this.unlockAttempts.forgetServer(id);
    this.broadcastServers();

    // Каналы удалённого сервера уходят вместе с ним — иначе повиснут сиротами.
    // Текстовые провожаем так же, как в channel-delete: стираем историю и
    // распускаем комнату, чтобы у читателей не осталось канала-призрака.
    const before = this.registry.channels.length;
    for (let i = this.registry.channels.length - 1; i >= 0; i--) {
      const channel = this.registry.channels[i];
      if (channel.serverId !== id) continue;
      // Забываем ДО того, как канал исчезнет из реестра: слаг разрешается в
      // канал по этому же списку, и после splice забывать было бы уже нечего.
      if (channel.type === 'text') {
        this.chat.forget(channel.slug);
        this.closeChatRoom(channel.slug);
      }
      this.registry.channels.splice(i, 1);
    }
    if (this.registry.channels.length !== before) this.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }

  // Цена удаления сервера для диалога подтверждения: сколько каналов и сколько
  // сообщений исчезнет вместе с ним и сколько человек сидит в его эфирах
  // (пока сидят — сервер не удаляется вовсе, см. server-delete). Права те же,
  // что у server-delete: срез нужен владельцу, которому сервер покажет кнопку,
  // а раздавать его каждому значило бы рассказывать всем, сколько написано в
  // чужих каналах.
  @SubscribeMessage('server-stats')
  async handleServerStats(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ServerStatsPayload,
  ): Promise<ServerStatsResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv || !srv.removable) return { ok: false };
    if (!this.isOpenTo(client, srv)) return { ok: false };
    if (!ownedBy(srv, this.claimant(client))) return { ok: false };
    const own = this.registry.channels.filter((c) => c.serverId === id);
    const counted = await Promise.all(
      own.filter((c) => c.type === 'text').map((c) => this.chat.count(c.slug)),
    );
    return {
      ok: true,
      channels: own.length,
      messages: counted.reduce((sum, n) => sum + n, 0),
      occupants: this.voiceOccupantsOfServer(id),
    };
  }

  // Сколько человек прямо сейчас в голосовых каналах этого сервера. Один обход
  // сокетов на все каналы разом: occupantsOf считает по одному, а здесь их
  // может быть десяток.
  private voiceOccupantsOfServer(serverId: string): number {
    const rooms = new Set(
      this.registry.channels
        .filter((c) => c.serverId === serverId && c.type === 'voice')
        .map((c) => c.slug),
    );
    if (!rooms.size) return 0;
    let count = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const room = this.voice.roomOf(sock);
      if (room && rooms.has(room)) count++;
    }
    return count;
  }

  // ===== Реестр каналов =====

  @SubscribeMessage('channel-create')
  async handleChannelCreate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelCreatePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const type = payload?.type === 'voice' ? 'voice' : payload?.type === 'text' ? 'text' : null;
    if (!type) return;
    // Сервер-владелец должен существовать (иначе канал повиснет вне рейки).
    const serverId = str(payload?.serverId) || MAIN_SERVER_ID;
    const srv = this.registry.servers.find((s) => s.id === serverId);
    if (!srv) return;
    // Главный сервер — витрина с фиксированным набором каналов (см.
    // DEFAULT_CHANNELS). Свои каналы заводят в своих серверах; интерфейс тут
    // «+» и не показывает, но запрет держим на сервере, а не на кнопке.
    if (serverId === MAIN_SERVER_ID) return;
    // В закрытый сервер канал создаёт только разблокировавший его сокет.
    if (!this.isOpenTo(client, srv)) return;
    const rawName = trimmed(payload?.name, LIMIT.name);
    const slug = slugifyChannel(rawName);
    if (!slug) return;
    if (this.registry.channels.length >= MAX_CHANNELS) return;
    // Слаг уникален глобально (комнаты голоса/чата ключуются по нему) — один слаг
    // на тип по всем серверам, повторное создание не плодит дубликаты.
    if (this.registry.channels.some((c) => c.type === type && c.slug === slug)) return;

    const channel: Channel = {
      id: randomUUID(),
      serverId,
      type,
      name: rawName,
      slug,
      removable: true,
      // Создатель канала — как у серверов: личность, а если ключа нет, то
      // устройство (см. handleServerCreate).
      ...this.creatorOf(client),
      // Режим — только у голосовых; p2p по умолчанию не пишем, отсутствие поля
      // и есть p2p (реестр не распухает, старые записи читаются одинаково).
      ...(type === 'voice' && payload?.mode === 'sfu' ? { mode: 'sfu' as const } : {}),
    };
    this.registry.channels.push(channel);
    this.broadcastChannels();
    await this.registry.persist();
  }

  // Смена транспорта голосового канала. Права те же, что у channel-delete:
  // трогать можно только свои каналы (removable), дефолтные остаются на p2p —
  // они обязаны работать и без поднятого медиасервера.
  @SubscribeMessage('channel-mode')
  async handleChannelMode(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelModePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = str(payload?.id);
    const mode: VoiceMode | null =
      payload?.mode === 'sfu' ? 'sfu' : payload?.mode === 'p2p' ? 'p2p' : null;
    if (!id || !mode) return;
    const found = this.editableChannel(client, id);
    if ('error' in found) return;
    if (found.channel.type !== 'voice') return;
    const channel = found.channel;
    const next = mode === 'sfu' ? 'sfu' : undefined;
    if (channel.mode === next) return;
    if (next) channel.mode = next;
    else delete channel.mode;
    this.broadcastChannels();
    // Отдельно — тем, кто прямо сейчас в этом канале: им нужно переехать на
    // другой транспорт. Реестра каналов для этого мало — гость по инвайту его
    // не получает, а переезжать обязан вместе со всеми.
    this.server.to(channel.slug).emit('voice-mode', { room: channel.slug, mode });
    await this.registry.persist();
  }

  /**
   * Сколько человек прямо сейчас в канале: для голосового — кто в эфире, для
   * текстового — у кого он открыт (socket.io-комната `chat:<slug>`).
   */
  private occupantsOf(channel: Channel): number {
    const target = channel.type === 'voice' ? channel.slug : this.chat.room(channel.slug);
    let count = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const where = channel.type === 'voice' ? this.voice.roomOf(sock) : sock.data.chatRoom;
      if (where === target) count++;
    }
    return count;
  }

  /**
   * Канал, который этому сокету разрешено менять. Само правило — в реестре
   * (RegistryService.editable); здесь только распаковка сокета: чьи пароли
   * введены и кто за ним стоит.
   */
  private editableChannel(client: AppSocket, id: string) {
    return this.registry.editable(id, this.unlockedOf(client), this.claimant(client));
  }

  /**
   * Чьей записью станет создаваемое. Личность, если она есть; устройство, если
   * ключа нет вовсе. Обе колонки сразу не пишем: две двери в один сервер — это
   * не запасной вход, а щель, и открыта она была бы ровно тем, что подделывается
   * (см. ./ownership).
   */
  private creatorOf(client: AppSocket): { creatorIdentityId: string } | { creatorId?: string } {
    const identityId = this.speaker(client)?.id;
    return identityId ? { creatorIdentityId: identityId } : { creatorId: deviceId(client) };
  }

  // Живой срез канала для диалога подтверждения (сколько человек внутри,
  // сколько сообщений пропадёт). Спрашивают по одному разу на открытие
  // диалога — рассылать это всем постоянно незачем. Права — как у правки:
  // срез канала с людьми и перепиской — это уже данные о нём, их не раздаём.
  @SubscribeMessage('channel-stats')
  async handleChannelStats(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelStatsPayload,
  ): Promise<ChannelStatsResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false };
    const channel = found.channel;
    return {
      ok: true,
      occupants: this.occupantsOf(channel),
      messages: channel.type === 'text' ? await this.chat.count(channel.slug) : 0,
    };
  }

  // Переименование канала. Меняем ТОЛЬКО отображаемое имя: slug остаётся
  // прежним, потому что по нему ключуются комната эфира, история чата и
  // «непрочитано» — смена имени не должна ни рвать живой звонок, ни терять
  // переписку. Права те же, что у удаления: дефолтные каналы неприкосновенны.
  @SubscribeMessage('channel-rename')
  async handleChannelRename(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelRenamePayload,
  ): Promise<ChannelRenameResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    const name = trimmed(payload?.name, LIMIT.name);
    if (!id) return { ok: false, error: 'not-found' };
    if (!name) return { ok: false, error: 'bad-name' };
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false, error: found.error };
    if (found.channel.name === name) return { ok: true };
    found.channel.name = name;
    this.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }

  @SubscribeMessage('channel-delete')
  async handleChannelDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChannelDeletePayload,
  ): Promise<ChannelDeleteResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false, error: found.error };
    const { channel, index } = found;

    // Голосовой канал с людьми в эфире не удаляем ни при каких условиях:
    // удаление выбросило бы их из звонка посреди разговора. Текстовый — можно
    // (там теряется только история), но клиент честно предупреждает, сколько
    // человек его сейчас читают.
    if (channel.type === 'voice') {
      const occupants = this.occupantsOf(channel);
      if (occupants > 0) return { ok: false, error: 'occupied', occupants };
    }

    // История удалённого канала уходит вместе с ним (каскадом в базе), а
    // читателей выписываем сами: их клиент мог бы и не заметить пропажу канала
    // в новом реестре, а остаться в комнате — значит продолжать писать в канал,
    // которого больше нет ни у кого. Порядок важен: `forget` разрешает слаг по
    // реестру, поэтому идёт до того, как канал из него исчезнет.
    if (channel.type === 'text') {
      this.chat.forget(channel.slug);
      this.closeChatRoom(channel.slug);
      // Отметки чтения канала уходят вместе с ним: каскада у них нет намеренно
      // (отметка не должна запирать удаление канала), значит убрать за собой
      // некому, кроме этого места.
      await this.reads.forget(channel.id);
    }
    this.registry.channels.splice(index, 1);
    this.broadcastChannels();
    await this.registry.persist();
    return { ok: true };
  }

  // ===== Личное: непрочитанное и настройки =====

  /**
   * «Этот канал дочитан до этого момента».
   *
   * Отметка растёт и только растёт (см. `reads.service`), поэтому опоздавшее
   * сообщение с устройства, которое проснулось со старым снимком, ничего не
   * ломает: оно просто не делает ничего. Ответа клиент не ждёт — у него уже
   * погашена точка, и переспрашивать сервер, засчитал ли он прочтение, значило
   * бы держать индикатор в зависимости от сети.
   */
  @SubscribeMessage('read-mark')
  async handleReadMark(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ReadMarkPayload,
  ): Promise<void> {
    if (!this.allow(client) || this.isGuest(client)) return;
    const me = this.speaker(client);
    if (!me) return;
    const slug = trimmed(payload?.slug, LIMIT.slug);
    const ts = typeof payload?.ts === 'number' ? payload.ts : 0;
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    // Канал, которого этот сокет не видит, ему и не дочитать: иначе отметки
    // становятся способом перебирать слаги закрытых серверов.
    if (!channel || !this.canSee(client, channel)) return;
    const mark = await this.reads.mark(me.id, channel.id, ts);
    if (mark === null) return;
    // Прочитано на десктопе — прочитано и в браузере, прямо сейчас. Это и есть
    // весь смысл переезда: догонять его перезагрузкой страницы было бы почти
    // тем же самым, что и не переезжать.
    this.tellOtherDevices(client, me.id, 'reads', { marks: { [slug]: mark } });
  }

  /**
   * Настройка человека. Что можно писать — решает `prefs.service`, здесь только
   * доставка: отказ (чужой ключ, слишком большое значение) остаётся молчанием.
   * Клиент шлёт лишь то, что сам же и понимает, а живого человека за неверным
   * ключом нет — объяснять некому.
   */
  @SubscribeMessage('prefs-set')
  async handlePrefsSet(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: PrefsSetPayload,
  ): Promise<void> {
    if (!this.allow(client) || this.isGuest(client)) return;
    const me = this.speaker(client);
    if (!me) return;
    const key = payload?.key;
    if (!(await this.prefs.set(me.id, key, payload?.value))) return;
    this.tellOtherDevices(client, me.id, 'prefs', { values: { [key as string]: payload?.value } });
  }

  /** Остальным устройствам того же человека — но не тому, кто это и сделал. */
  private tellOtherDevices(client: AppSocket, identityId: string, event: string, data: unknown): void {
    for (const sock of this.socketsOf(identityId)) {
      if (sock.id !== client.id) sock.emit(event, data);
    }
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
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const me = this.speaker(client);
    if (!me) return { ok: false, error: 'forbidden' };
    const room = client.data.chatRoom;
    if (!room) return { ok: false, error: 'forbidden' };
    const channel = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!channel || !this.mayModerate(client, channel)) return { ok: false, error: 'forbidden' };

    const everywhere = payload?.everywhere === true;
    // Бан на всю инсталляцию — только владельцу: у создателя сервера власти
    // ровно на свой сервер, и расширять её нечем.
    if (everywhere && client.data.owner !== true) return { ok: false, error: 'forbidden' };

    const id = str(payload?.id);
    const authorId = id ? await this.chat.authorOf(this.chat.slug(room), id) : null;
    if (!authorId) return { ok: false, error: 'not-found' };

    const scope = everywhere ? null : channel.serverId;
    const done = await this.roles.ban(authorId, scope, me.id);
    if (!done.ok) return { ok: false, error: done.reason === 'unknown' ? 'unknown' : 'forbidden' };
    this.applyBan(authorId, scope);
    return { ok: true };
  }

  /** Разбанить по отпечатку — той же ручкой, которой забаненный показан. */
  @SubscribeMessage('moderation-unban')
  async handleModerationUnban(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationUnbanPayload,
  ): Promise<ModerationResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const scope = this.moderatedScope(client, payload?.server);
    if (scope === undefined) return { ok: false, error: 'forbidden' };
    const identityId = await this.roles.byFingerprint(payload?.fingerprint);
    if (!identityId) return { ok: false, error: 'not-found' };
    if (!(await this.roles.unban(identityId, scope))) return { ok: false, error: 'not-found' };
    this.liftBan(identityId, scope);
    return { ok: true };
  }

  /** Кто забанен: на этом сервере или, если сервер не назван, на инсталляции. */
  @SubscribeMessage('moderation-bans')
  async handleModerationBans(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ModerationBansPayload,
  ): Promise<ModerationBansResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const scope = this.moderatedScope(client, payload?.server);
    if (scope === undefined) return { ok: false, error: 'forbidden' };
    return { ok: true, bans: await this.roles.bans(scope) };
  }

  /**
   * Охват, которым этому сокету позволено распоряжаться: названный сервер (если
   * он его модерирует) или вся инсталляция (если он владелец). `undefined` —
   * не позволено ничего, и это отличается от `null`, который и есть инсталляция.
   */
  private moderatedScope(client: AppSocket, raw: unknown): string | null | undefined {
    const id = str(raw);
    if (!id) return client.data.owner === true ? null : undefined;
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv || !this.isOpenTo(client, srv)) return undefined;
    return this.moderates(client, srv) ? id : undefined;
  }

  /** Модерирует ли этот сокет сервер, которому принадлежит эта комната чата. */
  private moderatesRoom(client: AppSocket, room: string): boolean {
    const slug = this.chat.slug(room);
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    return !!channel && this.mayModerate(client, channel);
  }

  /**
   * Модерирует ли этот сокет сервер, которому принадлежит канал.
   *
   * Это НЕ то же, что право править запись реестра (`ownedBy`), и разница
   * стоит того, чтобы её написать. Там «создателя нет» означает «права общие» —
   * иначе сервер, созданный до самого правила владения, никто не смог бы даже
   * переименовать. Здесь такое послабление означало бы, что на главном сервере
   * любой удаляет чужие сообщения и банит кого хочет: создателя у него нет и
   * быть не может.
   *
   * Поэтому модерация требует названного хозяина — личность создателя, — либо
   * владельца инсталляции. Унаследованный clientId власти не даёт: он лежит в
   * localStorage и подделывается, а удаление чужих слов и бан — не то, что
   * доверяют строке из чужого браузера.
   */
  private mayModerate(client: AppSocket, channel: Channel): boolean {
    const srv = this.registry.serverOf(channel);
    return !!srv && this.isOpenTo(client, srv) && this.moderates(client, srv);
  }

  /** То же правило, но про сам сервер. Считается там же, где рисуется флаг. */
  private moderates(client: AppSocket, srv: ServerEntry): boolean {
    return moderatedBy(srv, this.claimant(client));
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
  private applyBan(identityId: string, serverId: string | null): void {
    for (const sock of this.socketsOf(identityId)) {
      if (serverId === null) {
        sock.emit('banned');
        sock.disconnect(true);
        continue;
      }
      ((sock.data.bannedFrom) ??= new Set()).add(serverId);
      this.evictFrom(sock, serverId);
      sock.emit('servers', this.publicServersFor(sock));
      sock.emit('channels', this.channelsFor(sock));
    }
  }

  /** Разбан под живым сокетом: сервер возвращается на место сам. */
  private liftBan(identityId: string, serverId: string | null): void {
    if (serverId === null) return;
    for (const sock of this.socketsOf(identityId)) {
      this.bannedFrom(sock)?.delete(serverId);
      sock.emit('servers', this.publicServersFor(sock));
      sock.emit('channels', this.channelsFor(sock));
    }
  }

  /** Живые сокеты этой личности. Их обычно один-два: браузер и десктоп. */
  private socketsOf(identityId: string): AppSocket[] {
    const out: AppSocket[] = [];
    for (const sock of this.server?.sockets.sockets.values() ?? []) {
      if (sock.data.identity?.id === identityId) out.push(sock);
    }
    return out;
  }

  /** Выписать сокет из эфира и ленты этого сервера — там ему больше нельзя. */
  private evictFrom(client: AppSocket, serverId: string): void {
    const voice = this.voice.roomOf(client);
    const chat = client.data.chatRoom;
    for (const channel of this.registry.channels) {
      if (channel.serverId !== serverId) continue;
      if (channel.type === 'voice' && voice === channel.slug) this.voice.leave(client);
      if (channel.type === 'text' && chat === this.chat.room(channel.slug)) {
        this.leaveChatRoom(client);
        // С причиной: канал на месте, ушёл человек. Без неё клиент сказал бы
        // ему «канал удалён» — и он пошёл бы искать пропажу, которой нет.
        client.emit('chat-closed', { slug: channel.slug, reason: 'banned' });
      }
    }
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
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const slug = trimmed(payload?.room, LIMIT.slug);
    // Канал должен существовать, быть голосовым и быть видимым этому сокету
    // (каналы закрытых серверов — только после ввода пароля).
    const channel = this.channelsFor(client).find((c) => c.type === 'voice' && c.slug === slug);
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
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = trimmed(payload?.id, LIMIT.id);
    const target = id ? this.server.sockets.sockets.get(id) : undefined;
    if (!target || target.data.guest !== true) return { ok: false, error: 'not-found' };
    const room = this.voice.roomOf(target);
    if (!room) return { ok: false, error: 'not-found' };
    // Канал закрытого сервера запирает и это: не введя пароль, ты не видишь ни
    // канала, ни того, кто в нём сидит, — значит и выгонять оттуда некого.
    if (!this.mayEnter(client, room)) return { ok: false, error: 'forbidden' };

    this.banGuest(target, room);
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

  /** Ключ отлучения: комната + устройство (а если оно не назвалось — адрес). */
  private banKey(client: AppSocket, room: string): string {
    const device = deviceId(client) || `ip:${clientIp(client.handshake)}`;
    // Разделитель — NUL, записанный escape-последовательностью: сырой байт
    // делает весь файл двоичным для grep и file. Ни в имени комнаты, ни в id
    // устройства он встретиться не может, поэтому склейка однозначна.
    return `${room}\0${device}`;
  }

  private banGuest(client: AppSocket, room: string) {
    // Заодно подметаем протухшее: карта живёт всё время работы процесса, а
    // класть в неё по записи на каждого выгнанного и не убирать — это утечка
    // размером в историю инсталляции.
    const now = Date.now();
    for (const [key, until] of this.guestBans) {
      if (until <= now) this.guestBans.delete(key);
    }
    this.guestBans.set(this.banKey(client, room), now + SignalingGateway.GUEST_BAN_MS);
  }

  private guestBanned(client: AppSocket, room: string): boolean {
    const until = this.guestBans.get(this.banKey(client, room));
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.guestBans.delete(this.banKey(client, room));
    return false;
  }

  // ===== Пропуск в медиасервер =====

  // Пропуск на namespace /sfu: короткоживущий подписанный токен + адрес
  // медиасервера. Комнату и peerId берём из состояния сокета, а не из запроса —
  // напроситься в чужой канал или назваться чужим id так нельзя. Гость проходит
  // на общих основаниях: он уже «пришит» к своей комнате.
  @SubscribeMessage('sfu-token')
  async handleSfuToken(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: SfuTokenPayload,
  ): Promise<SfuTokenResult> {
    if (!this.allow(client)) return { ok: false, error: 'forbidden' };
    // Отказ обязан стирать прошлый пропуск, и это не уборка ради порядка.
    // Пропуск — единственное, чем сервер догадывается о транспорте клиента,
    // который его не называет (бандл прошлой версии). Не сотри мы его, человек,
    // ушедший из sfu-канала в обычный, остался бы в presence помечен как «через
    // медиасервер» — и весь канал, работающий прекрасно, получил бы красное
    // «тебя не слышат» на пустом месте. Пропуск описывает СЛЕДУЮЩИЙ вход, и
    // отказ в нём — такой же ответ, как выдача.
    const forget = () => this.voice.forgetPass(client);
    const url = (process.env.SFU_URL ?? '').trim();
    if (!url || !sfuSecret()) {
      forget();
      return { ok: false, error: 'unavailable' };
    }
    // Настроен — не значит жив: пропуск в лежащий медиасервер собирает комнату
    // в расщеплённое «вижу, но не слышу». Пинг с коротким кэшем, sfu-health.ts.
    if (!(await sfuHealthy())) {
      this.logger.warn(`sfu-token denied (sfu down) for ${client.id}`);
      forget();
      return { ok: false, error: 'unavailable' };
    }
    // Комната приходит в запросе: клиенту нужно знать транспорт ДО `join`,
    // иначе он пропустит ответный `peers`. Секрета в ней нет — войти в любой
    // голосовой канал он и так вправе, а `peerId` по-прежнему берётся из
    // сокета, так что назваться чужим id нельзя.
    const asked = trimmed(payload?.room, LIMIT.slug);
    const room = asked || this.voice.roomOf(client) || '';
    if (!room) {
      forget();
      return { ok: false, error: 'not-in-room' };
    }
    // Гость «пришит» к своему каналу — чужую комнату не спросит.
    if (this.isGuest(client) && room !== client.data.guestRoom) {
      forget();
      return { ok: false, error: 'forbidden' };
    }
    // Режим канала — не декорация: пропуск выдаём только тем каналам, что
    // помечены sfu. Дефолтные (всегда p2p) отсюда уходят ни с чем.
    // Пропуск — только в видимый канал: закрытый сервер запирает и медиасервер,
    // иначе пароль обходится одним слагом. Гость идёт по своей комнате: реестра
    // у него нет, а к каналу он уже пришит проверкой выше.
    const channel = (this.isGuest(client) ? this.registry.channels : this.channelsFor(client)).find(
      (c) => c.type === 'voice' && c.slug === room,
    );
    if (!channel || channel.mode !== 'sfu') {
      forget();
      return { ok: false, error: 'not-sfu' };
    }
    // Имя берём из запроса: пропуск спрашивают ДО `join`, и client.data.name в
    // этот момент ещё пуст (заполнен он только при пере-выдаче во время звонка).
    // Лимит — тот же, что у `join`.
    const askedName = trimmed(payload?.name, LIMIT.tag);
    const name = askedName || this.voice.nameOf(client) || '';
    // Слушателю пропуск выдаём тот же, но с клеймом: медиасервер откажет ему в
    // produce. Клиент у гостя свой — запрет обязан жить там, где течёт медиа.
    const { token, exp } = issueSfuToken({
      room,
      peerId: client.id,
      name,
      listen: this.isListener(client),
    });
    // Запоминаем выдачу: клиент, не умеющий сообщать транспорт в `join` (бандл
    // прошлой версии), иначе сошёл бы за p2p — и остальные съехали бы в прямые
    // звонки, разъехавшись с ним по-настоящему. Пропуск — лучшее, что о таком
    // клиенте известно: за ним идут в медиасервер.
    this.voice.grantPass(client, room);
    this.logger.log(`sfu-token issued to ${name || '?'} (${client.id}) room "${room}"`);
    return { ok: true, token, exp, url };
  }

  // ===== Диагностика звонков =====

  // Клиентские вехи звонка (выбор транспорта, фолбэк в p2p, обрывы) — в лог
  // сервера. Все эти решения клиент принимает молча у себя, сервер видит лишь
  // их отсутствие — а «телефон в канале, но не слышно» разбирают назавтра по
  // серверному логу, клиентская консоль к тому моменту мертва. Только лог,
  // никакой логики: верить содержимому на слово нельзя.
  @SubscribeMessage('voice-diag')
  handleVoiceDiag(@ConnectedSocket() client: AppSocket, @MessageBody() payload: VoiceDiagPayload) {
    if (!this.allowDiag(client)) return;
    const event = oneLine(str(payload?.event)).slice(0, LIMIT.diagEvent);
    if (!event) return;
    const detail = oneLine(str(payload?.detail)).slice(0, LIMIT.diagDetail);
    const name = client.data.name || '?';
    this.logger.log(`diag ${name} (${client.id}): ${event}${detail ? ` ${detail}` : ''}`);
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: AppSocket, @MessageBody() payload: JoinPayload) {
    if (!this.allow(client)) return;
    const room = trimmed(payload?.room, LIMIT.slug);
    if (!room) return;
    // Гость «пришит» к каналу из своего токена — другие комнаты недоступны.
    if (this.isGuest(client) && room !== client.data.guestRoom) return;
    // Выгнанный не возвращается, пока не истечёт пауза (см. handleGuestKick).
    // Проверяем и здесь, а не только в handshake: сокет мог быть открыт до
    // того, как его выгнали, — тогда `join` был бы дверью с другой стороны.
    if (this.isGuest(client) && this.guestBanned(client, room)) {
      client.emit('kicked', { room });
      return;
    }
    // Канал закрытого сервера — только для тех, кто ввёл пароль. Комнату, которой
    // в реестре нет вовсе, пропускаем: это либо канал, удалённый под живым
    // разговором, либо инвайт-комната, и запирать их не за что.
    if (!this.isGuest(client) && !this.mayEnter(client, room)) {
      this.logger.warn(`voice: join to locked room "${room}" refused for ${client.id}`);
      // Отказ обязан быть слышен. Молчащий `return` клиент не отличал от
      // удавшегося входа: он считал себя в канале, для остальных его там не
      // было, и разъезд по транспортам довершал дело — вместо «введи пароль»
      // человек получал тишину без объяснений.
      client.emit('voice-locked', { room });
      return;
    }
    // Имя называет сервер, если сокет — личность; тело сообщения остаётся
    // именем только у гостя по инвайту.
    const name = this.nameOf(client, optional(payload?.name, LIMIT.tag));
    // Устройство: сначала handshake (см. handleConnection), и только если там
    // пусто — поле payload. Порядок именно такой, и он важен: по этому же id
    // решается владение серверами и каналами, а `??` не даёт перебить уже
    // названное — иначе владельцем можно было бы представиться одним
    // `voice-join` посреди сессии.
    //
    // Совсем закрыть эту дверь нельзя: клиент прошлой версии шлёт clientId
    // только здесь, и без него не выгнать «призрака» его прошлой вкладки. Так
    // что назваться первым join'ом сокет, промолчавший в handshake, всё же
    // может — но ровно один раз, и не большего, чем то же самое поле в
    // handshake, которое ничем не защищено и защищать не пытается.
    const clientId = deviceId(client) ?? normalizeClientId(payload?.clientId);
    // Транспорт называет сам клиент: сервер знает лишь режим канала, а решение
    // принимает клиент — и оно может разойтись с режимом (медиасервер не
    // поднялся у него одного, нативный iOS про SFU вовсе не знает). Клиент
    // прошлой версии поля не пришлёт — за него отвечает выданный пропуск:
    // считать такого p2p нельзя, остальные съехали бы в прямые звонки и
    // разъехались бы с ним уже по-настоящему.
    const transport = this.voice.transportFor(client, payload?.transport, room);

    // Вход: выход из прошлой комнаты, выселение «призрака» своего же устройства
    // и сбор соседей — всё это один неделимый порядок, и живёт он в VoiceSessions.
    const peers = this.voice.enter(client, { room, name, transport, clientId });

    // Новичку — список тех, кто уже в канале (он шлёт им offer'ы),
    // остальным — уведомление о пополнении
    client.emit('peers', peers);
    client.to(room).emit('peer-joined', {
      id: client.id,
      name,
      ...(this.speaker(client) ? { fingerprint: this.speaker(client)?.fingerprint } : {}),
      ...(this.isGuest(client) ? { guest: true } : {}),
      ...(this.isListener(client) ? { listen: true } : {}),
    });
    this.voice.broadcast();
    // UA — в лог: «телефон не слышит» первым делом упирается в вопрос, ЧТО это
    // за клиент был (мобильный Safari? нативное приложение? старый бандл?).
    const ua = oneLine(String(client.handshake.headers['user-agent'] ?? '')).slice(0, 120);
    this.logger.log(
      `voice: ${name || '?'} (${client.id}${this.isGuest(client) ? ', guest' : ''}) joined "${room}" via ${transport} ua="${ua}"`,
    );
    // Разъехались в транспортах — участники друг друга не слышат вообще.
    // Клиенты разберутся сами (мелкая комната съедет в p2p целиком), но в логе
    // это должно быть видно сразу: снаружи такое выглядит как «он в канале, но
    // молчит», и без строчки в логе разбирается только гаданием.
    const split = this.voice.transportsInRoom(room);
    if (split.size > 1) {
      this.logger.warn(
        `voice: room "${room}" is split across transports: ${[...split].join(' + ')}`,
      );
    }
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: AppSocket) {
    this.voice.leave(client);
  }

  @SubscribeMessage('offer')
  handleOffer(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'offer', payload?.to, {
      name: client.data.name,
      sdp: payload?.sdp,
    });
  }

  @SubscribeMessage('answer')
  handleAnswer(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'answer', payload?.to, { sdp: payload?.sdp });
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(@ConnectedSocket() client: AppSocket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'ice-candidate', payload?.to, { candidate: payload?.candidate });
  }

  @SubscribeMessage('media-update')
  handleMediaUpdate(
    @ConnectedSocket() client: AppSocket,
    @MessageBody()
    payload: { camOn?: unknown; screenOn?: unknown; micOn?: unknown; deafened?: unknown },
  ) {
    if (!this.allow(client)) return;
    const room = this.voice.roomOf(client);
    if (!room) return;
    // Мут/глушилку запоминает голосовая сессия — их раздаёт voice-presence
    // (индикаторы в сайдбаре видят и те, кто сам не в эфире).
    const changed = this.voice.setMedia(client, payload?.micOn, payload?.deafened);
    client.to(room).emit('media-update', {
      from: client.id,
      camOn: payload?.camOn === true,
      screenOn: payload?.screenOn === true,
      ...this.voice.mediaOf(client),
    });
    // Presence несёт только мут/глушилку — камеру/экран (или повтор того же
    // состояния) не гоним на весь сервер. Рассылаем лишь при реальной их смене.
    if (changed) this.voice.broadcast();
  }

  // Смена тега на лету: обновляем имя в голосовой комнате (presence + подписи
  // плиток у собеседников) и в текстовом канале (ростер). Пустое имя игнорируем.
  /**
   * Человек переименовался. От личности это не «зовите меня так», а «сходите
   * перечитайте»: имя меняется обычным HTTP (`POST /api/identity/nick`), сокет
   * узнаёт о смене последним и берёт новое имя из базы, а не из тела события.
   * Иначе одним `rename` можно было бы назваться кем угодно посреди разговора —
   * и лицо рядом с ником перестало бы что-либо значить.
   */
  @SubscribeMessage('rename')
  async handleRename(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: { name?: unknown },
  ) {
    if (!this.allow(client)) return;
    const speaker = this.speaker(client);
    const name = speaker
      ? ((await this.identities.nickOf(speaker.id)) ?? speaker.nick)
      : trimmed(payload?.name, LIMIT.tag);
    if (!name) return;

    // Имя принадлежит личности, а не сокету, — значит и менять его надо у всех
    // сокетов этой личности. Иначе человек, переименовавшийся с телефона,
    // остаётся прежним для комнаты, в которой сидит его же десктоп: подписи
    // плиток, ростер и presence там нарисованы по данным ТОГО сокета, а он о
    // смене не узнаёт до перезахода. У того, кто вошёл без ключа, устройство
    // ровно одно — им и ограничиваемся.
    const targets = speaker ? this.socketsOf(speaker.id) : [client];
    const rosters = new Set<string>();
    let presence = false;

    for (const sock of targets) {
      const own = this.speaker(sock);
      if (own) own.nick = name;

      if (this.voice.rename(sock, name)) presence = true;

      const chatRoom = sock.data.chatRoom;
      if (chatRoom && sock.data.chatName !== name) {
        sock.data.chatName = name;
        rosters.add(chatRoom);
      }

      // Самому устройству-инициатору говорить нечего: оно и так знает.
      if (sock.id !== client.id) sock.emit('renamed', { name });
    }

    for (const room of rosters) this.emitRoster(room);
    if (presence) this.voice.broadcast();
  }

  // ===== Текстовый канал =====

  @SubscribeMessage('chat-join')
  async handleChatJoin(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const slug = trimmed(payload?.room, LIMIT.slug);
    if (!slug) return;
    // Как и в голосовом: имя личности называет сервер (см. nameOf).
    const name = this.nameOf(client, trimmed(payload?.name, LIMIT.tag));

    // В несуществующий канал не пускаем: комната-призрак принимала бы сообщения
    // и заново копила историю под удалённым слагом. Случая два, и они разные.
    // Канала нет ни у кого (удалили, пока клиент переподключался) — так и
    // отвечаем, `chat-closed`. Канал есть, но не виден (закрытый сервер, пароль
    // ещё не введён) — молча не пускаем: вводить пароль никто не запрещал, и
    // выгонять из ленты тут не за что. Проверяем ДО выхода из прежней комнаты —
    // неудачный вход не должен выбрасывать из той, где человек уже сидит.
    const known = this.registry.channels.some((c) => c.type === 'text' && c.slug === slug);
    const visible =
      known && this.channelsFor(client).some((c) => c.type === 'text' && c.slug === slug);
    if (!visible) {
      if (!known) client.emit('chat-closed', { slug });
      return;
    }

    // Уже сидел в другом текстовом канале — сначала выходим
    this.leaveChatRoom(client);

    const room = this.chat.room(slug);
    client.join(room);
    client.data.chatRoom = room;
    client.data.chatName = name || ANON_NAME;

    // Новичку — последняя страница канала. Не вся история: она больше не
    // помещается в один снимок, и остальное он подтянет вверх сам. Вместе с ней
    // — сколько здесь закреплено: число рисуется в шапке сразу, а сам список
    // спрашивают, только когда его открывают.
    const [page, pins] = await Promise.all([this.chat.history(slug), this.chat.pinCount(slug)]);
    client.emit('chat-history', { slug, ...page, pins });
    this.emitRoster(room);
  }

  /**
   * Страница выше уже показанной. Курсор клиент присылает свой — время и id
   * самой верхней реплики, которую он держит; сервер по нему ничего не хранит.
   * Ответ уходит ack'ом, а не событием: страницу ждёт конкретный запрос, и
   * рассылать её в комнату незачем.
   */
  @SubscribeMessage('chat-history-more')
  async handleChatHistoryMore(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatHistoryMorePayload,
  ): Promise<ChatHistoryMoreResult> {
    const empty = { ok: true as const, messages: [], more: false };
    if (!this.allow(client) || this.isGuest(client)) return empty;
    const room = client.data.chatRoom;
    if (!room) return empty;
    const beforeTs = typeof payload?.beforeTs === 'number' ? payload.beforeTs : 0;
    const beforeId = str(payload?.beforeId);
    if (!beforeTs || !beforeId) return empty;
    return { ok: true, ...(await this.chat.older(this.chat.slug(room), beforeTs, beforeId)) };
  }

  /**
   * Страница ниже показанной. Спрашивается только после перехода из поиска: у
   * живого конца канала ниже ничего нет, и обычное чтение сюда не приходит.
   */
  @SubscribeMessage('chat-history-after')
  async handleChatHistoryAfter(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatHistoryAfterPayload,
  ): Promise<ChatWindowResult> {
    const empty = { ok: true as const, messages: [], more: false, moreAfter: false };
    if (!this.allow(client) || this.isGuest(client)) return empty;
    const room = client.data.chatRoom;
    if (!room) return empty;
    const afterTs = typeof payload?.afterTs === 'number' ? payload.afterTs : 0;
    const afterId = str(payload?.afterId);
    if (!afterTs || !afterId) return empty;
    return { ok: true, ...(await this.chat.newer(this.chat.slug(room), afterTs, afterId)) };
  }

  /**
   * Окно вокруг реплики — то, чем заканчивается переход из результатов поиска.
   *
   * Канал не называется: берём тот, в котором сокет сидит. Клиент, идущий в
   * чужой канал, сперва входит в него обычным `chat-join` (и там же проверяются
   * права), а socket.io держит порядок событий одного сокета, так что к моменту
   * этого запроса комната уже та.
   */
  @SubscribeMessage('chat-around')
  async handleChatAround(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatAroundPayload,
  ): Promise<ChatWindowResult> {
    const empty = { ok: true as const, messages: [], more: false, moreAfter: false };
    if (!this.allow(client) || this.isGuest(client)) return empty;
    const room = client.data.chatRoom;
    const id = str(payload?.id);
    if (!room || !id) return empty;
    return { ok: true, ...(await this.chat.around(this.chat.slug(room), id)) };
  }

  /**
   * Поиск по истории.
   *
   * Область называет клиент, но каналы по ней собирает сервер: «по серверу»
   * значит «по тем его текстовым каналам, которые видно этому сокету», и решать
   * это клиенту не дают нигде. Пустой набор каналов — пустой результат, а не
   * отказ: искать в закрытом сервере, пароль от которого не введён, не
   * запрещено, там просто нечего найти.
   */
  @SubscribeMessage('chat-search')
  async handleChatSearch(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatSearchPayload,
  ): Promise<ChatSearchResult> {
    const empty = { ok: true as const, hits: [], more: false, terms: [] };
    if (!this.allow(client) || this.isGuest(client)) return empty;
    const room = client.data.chatRoom;
    if (!room) return empty;
    const here = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!here || !this.canSee(client, here)) return empty;

    const query = trimmed(payload?.query, LIMIT.search);
    const terms = searchTerms(query);
    if (!terms.length) return empty;

    const scope = payload?.scope === 'server' ? 'server' : 'channel';
    const channels =
      scope === 'server'
        ? this.registry.channels.filter(
            (c) => c.type === 'text' && c.serverId === here.serverId && this.canSee(client, c),
          )
        : [here];

    const beforeTs = typeof payload?.beforeTs === 'number' ? payload.beforeTs : 0;
    const beforeId = str(payload?.beforeId);
    const cursor = beforeTs && beforeId ? { ts: beforeTs, id: beforeId } : undefined;

    const { hits, more } = await this.chat.search(
      channels.map((c) => c.id),
      query,
      cursor,
    );
    return { ok: true, hits, more, terms };
  }

  /**
   * Кого предложить после набранного `@`.
   *
   * Список собирает сервер, и в него попадают только те, кому этот канал виден:
   * подсказать человека, который не может прочитать канал, значит предложить
   * позвать его в комнату за запертой дверью. Себя в подсказке нет — позвать
   * себя нельзя, и место в списке из восьми имён этим не тратится.
   */
  @SubscribeMessage('mention-suggest')
  async handleMentionSuggest(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: MentionSuggestPayload,
  ): Promise<MentionSuggestResult> {
    const empty = { ok: true as const, people: [] };
    if (!this.allow(client) || this.isGuest(client)) return empty;
    const room = client.data.chatRoom;
    if (!room) return empty;
    const here = this.registry.channels.find(
      (c) => c.type === 'text' && c.slug === this.chat.slug(room),
    );
    if (!here || !this.canSee(client, here)) return empty;

    const prefix = trimmed(payload?.prefix, LIMIT.tag).toLowerCase();
    const me = this.speaker(client)?.fingerprint;
    const seen = new Set<string>();
    const people: MentionSuggestResult['people'] = [];

    // Сначала те, кто сейчас на связи: для них упоминание — не запись в
    // историю, а обращение, которое они увидят сию минуту.
    for (const sock of this.server.sockets.sockets.values()) {
      const who = this.speaker(sock);
      if (!who || who.fingerprint === me || seen.has(who.fingerprint)) continue;
      if (this.isGuest(sock) || !this.canSee(sock, here)) continue;
      if (prefix && !who.nick.toLowerCase().startsWith(prefix)) continue;
      seen.add(who.fingerprint);
      people.push({ fingerprint: who.fingerprint, nick: who.nick, online: true });
    }

    // Затем — говорившие на этом сервере, в тех его каналах, что видно
    // спрашивающему: звать через канал человека, о котором ты знаешь только по
    // соседнему каналу, — обычное дело.
    const channels = this.registry.channels.filter(
      (c) => c.type === 'text' && c.serverId === here.serverId && this.canSee(client, c),
    );
    const spoke = await this.chat.mentionCandidates(
      channels.map((c) => c.id),
      prefix,
    );
    for (const person of spoke) {
      if (person.fingerprint === me || seen.has(person.fingerprint)) continue;
      seen.add(person.fingerprint);
      people.push({ ...person, online: false });
    }

    return { ok: true, people: people.slice(0, MENTION_SUGGEST_LIMIT) };
  }

  /**
   * Кого назвали в этом тексте: клиент присылает отпечатки выбранных им людей,
   * сервер оставляет тех, чьё имя в тексте и правда написано.
   *
   * Ник в снимок берётся из базы, а не из тела сообщения: иначе рядом с чужим
   * лицом можно было бы написать любое имя.
   */
  private async resolveMentions(text: string, claimed: unknown): Promise<MentionRef[]> {
    if (!text || !Array.isArray(claimed) || !claimed.length) return [];
    const fingerprints = [
      ...new Set(
        claimed
          .slice(0, LIMIT.mentions)
          .map((value) => trimmed(value, LIMIT.fingerprint))
          .filter(Boolean),
      ),
    ];
    if (!fingerprints.length) return [];
    return mentionedIn(text, await this.chat.peopleByFingerprint(fingerprints));
  }

  /**
   * Сказать названным, что их назвали. Летит на все устройства человека — тем
   * же порядком, что и отметки чтения: канал, в котором тебя позвали, обязан
   * загореться и на телефоне.
   *
   * Себе не звоним (написать собственное имя — не вызов), гостю по инвайту
   * тоже: у него нет личности, а значит и счётчика, который это зажигает.
   * Тому, кому канал не виден, — тем более: событие несёт слаг, а слаг канала
   * закрытого сервера сам по себе часть секрета.
   */
  private pingMentions(from: AppSocket, mentions: MentionRef[], slug: string, ts: number): void {
    if (!mentions.length) return;
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    if (!channel) return;
    const author = this.speaker(from)?.fingerprint;
    const targets = new Set(mentions.map((m) => m.fingerprint));
    for (const sock of this.server.sockets.sockets.values()) {
      const who = this.speaker(sock)?.fingerprint;
      if (!who || who === author || !targets.has(who)) continue;
      if (this.isGuest(sock) || !this.canSee(sock, channel)) continue;
      sock.emit('mention', { slug, ts });
    }
  }

  /**
   * Снимок непрочитанных упоминаний по каналам. Считается в базе, а не
   * копится в памяти: счётчик обязан пережить и рестарт api, и смену
   * устройства, — иначе «тебя звали» существовало бы ровно до перезагрузки
   * страницы.
   */
  private async sendMentions(client: AppSocket): Promise<void> {
    const me = this.speaker(client);
    if (!me) return;
    const counts = await this.chat.mentionCounts(me.id, me.fingerprint);
    const bySlug: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const n = counts.get(channel.id);
      if (n && this.canSee(client, channel)) bySlug[channel.slug] = n;
    }
    client.emit('mentions', { counts: bySlug });
  }

  @SubscribeMessage('chat-leave')
  handleChatLeave(@ConnectedSocket() client: AppSocket) {
    this.leaveChatRoom(client);
  }

  @SubscribeMessage('chat-message')
  async handleChatMessage(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom;
    if (!room) return;
    const text = trimmed(payload?.text, LIMIT.message);

    // Вложение называется id'ом загрузки, а не url'ом и не mime: подставить
    // себе чужой файл или соврать про его тип клиент не может — метаданные
    // берутся из таблицы вложений (см. chat.service).
    const uploadId = str(payload?.uploadId);
    if (!text && !(await this.uploads.exists(uploadId))) return;

    const mentions = await this.resolveMentions(text, payload?.mentions);

    // Снимок цитаты, вложение и время назначает хранилище: время — потому что
    // по нему же строится курсор ленты, и оно обязано быть одних часов с ней.
    const msg = await this.chat.add(this.chat.slug(room), {
      name: this.chatNameOf(client),
      // Авторство пишется рядом с именем, а не вместо: имя — снимок момента,
      // личность — то, по чему потом сверяются правка, удаление и модерация.
      identityId: this.speaker(client)?.id,
      text,
      uploadId,
      spoiler: payload?.spoiler === true,
      replyToId: str(payload?.replyTo),
      mentions,
    });
    // Канал удалили, пока сообщение шло, — писать его некуда.
    if (!msg) return;

    this.server.to(room).emit('chat', msg);
    this.pingMentions(client, mentions, this.chat.slug(room), msg.ts);
    // Лёгкий пинг активности: сайдбар зажигает «непрочитано» на закрытых сейчас
    // каналах. Только слаг и время, без содержимого. Рассылаем не всем подряд, а
    // тем, кому канал виден: слаг канала закрытого сервера — часть секрета, и
    // «в тайном канале сейчас пишут» посторонним знать неоткуда.
    const slug = this.chat.slug(room);
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    const srv = channel ? this.registry.servers.find((s) => s.id === channel.serverId) : undefined;
    this.queueChatActivity(slug, msg.ts, srv?.passwordHash ? srv.id : null);
  }

  /**
   * Пинг активности — это состояние («в канале писали в такой-то момент»), а не
   * событие, поэтому его можно копить: из десяти реплик подряд смысл несёт
   * последняя. Без этого каждое сообщение каждого участника означало обход всех
   * сокетов — та самая квадратичная работа при живом разговоре.
   */
  private queueChatActivity(slug: string, ts: number, locked: string | null) {
    this.pendingActivity.set(slug, { ts, locked });
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      const batch = [...this.pendingActivity];
      this.pendingActivity.clear();
      for (const sock of this.server.sockets.sockets.values()) {
        if (sock.data.guest === true) continue; // гостю реестр не положен вовсе
        const unlocked = sock.data.unlocked;
        for (const [slug, { ts, locked }] of batch) {
          if (locked && !unlocked?.has(locked)) continue;
          sock.emit('chat-activity', { slug, ts });
        }
      }
    }, SignalingGateway.REGISTRY_DEBOUNCE_MS);
    this.activityTimer.unref?.();
  }

  /**
   * Своё ли это сообщение. У реплики с личностью сверяется отпечаток — тот
   * самый, что нарисован рядом с ней в ленте: подписаться чужим именем теперь
   * нельзя, а значит и правку чужого именем не открыть.
   *
   * Без личности остаётся прежнее сравнение имён (audit S1): так подписаны
   * реплики гостей и всё, что написано до 1.0. Строгость там взять не из чего —
   * зато и не притворяемся, что она есть.
   */
  private ownsMessage(client: AppSocket, msg: { name: string; fingerprint?: string }): boolean {
    if (msg.fingerprint) return this.speaker(client)?.fingerprint === msg.fingerprint;
    return msg.name === this.chatNameOf(client);
  }

  // Правка своего сообщения — автора сверяет ownsMessage.
  // Системные и сообщения-вложения без текста не редактируем.
  @SubscribeMessage('chat-edit')
  async handleChatEdit(@ConnectedSocket() client: AppSocket, @MessageBody() payload: ChatEditPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom;
    if (!room) return;
    const id = str(payload?.id);
    const text = trimmed(payload?.text, LIMIT.message);
    if (!id || !text) return;

    const msg = await this.chat.find(this.chat.slug(room), id);
    if (!msg) return;
    if (!this.ownsMessage(client, msg)) return;

    const mentions = await this.resolveMentions(text, payload?.mentions);
    const editedTs = await this.chat.edit(id, text, mentions);
    this.server.to(room).emit('chat-edited', { id, text, editedTs, mentions });

    // Позвали правкой — значит позвали. Молчать здесь означало бы, что имя,
    // дописанное через минуту после отправки, увидит только тот, кто и так
    // читает канал, — то есть ровно не тот, кого звали. Уже названным второй
    // раз не звоним: правка опечатки — не повод повторить вызов.
    const already = new Set((msg.mentions ?? []).map((m) => m.fingerprint));
    this.pingMentions(
      client,
      mentions.filter((m) => !already.has(m.fingerprint)),
      this.chat.slug(room),
      editedTs,
    );
  }

  // Удаление сообщения: своего — автором, любого — модератором сервера, которому
  // принадлежит канал (и владельцем инсталляции поверх него). Убираем из истории
  // и просим всех снять из ленты. Цитаты в чужих ответах не трогаем — они хранят
  // собственный снимок.
  //
  // Правка чужого при этом остаётся невозможной, и это не недосмотр: удалить
  // сказанное — модерация, переписать сказанное чужим именем — подлог.
  @SubscribeMessage('chat-delete')
  async handleChatDelete(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatDeletePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom;
    if (!room) return;
    const id = str(payload?.id);
    if (!id) return;

    const slug = this.chat.slug(room);
    const msg = await this.chat.find(slug, id);
    if (!msg) return;
    if (!this.ownsMessage(client, msg) && !this.moderatesRoom(client, room)) return;

    if (!(await this.chat.remove(id))) return;
    this.server.to(room).emit('chat-deleted', { id });

    // Удалили закреплённое — закрепление ушло вместе с ним (ON DELETE CASCADE),
    // а число в шапке про это не знает. Считать его клиенту самому значило бы
    // требовать, чтобы каждый держал у себя список закреплённого целиком — ради
    // одного вычитания.
    if (msg.pinned) {
      this.server
        .to(room)
        .emit('chat-pinned', { id, pinned: false, count: await this.chat.pinCount(slug) });
    }
  }

  /**
   * Закрепить или открепить реплику.
   *
   * Право то же, что и на удаление чужого, — модерация сервера, и это не
   * строгость ради строгости. Закрепление меняет канал для всех, кто в него
   * зайдёт, и вдобавок вынимает реплику из-под ретенции: это единственный
   * способ оставить сказанное жить дольше четырнадцати дней. Раздай мы его
   * каждому вошедшему — и срок хранения перестал бы что-либо значить, а шапка
   * канала стала бы доской объявлений для случайного гостя.
   */
  @SubscribeMessage('chat-pin')
  async handleChatPin(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatPinPayload,
  ): Promise<ChatPinResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const room = client.data.chatRoom;
    if (!room) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    if (!this.moderatesRoom(client, room)) return { ok: false, error: 'forbidden' };

    const slug = this.chat.slug(room);
    // «Закрепить» приходит явно, а не выводится из того, что клиент видит у
    // себя: его лента бывает старше действительности на одно чужое действие,
    // и «переключить» сняло бы то, что человек только что хотел поставить.
    const on = payload?.on === true;

    if (on) {
      const res = await this.chat.pin(slug, id, this.speaker(client)?.id ?? null);
      if (res === 'gone') return { ok: false, error: 'not-found' };
      if (res === 'limit') return { ok: false, error: 'limit' };
    } else if (!(await this.chat.unpin(slug, id))) {
      return { ok: false, error: 'not-found' };
    }

    const count = await this.chat.pinCount(slug);
    this.server.to(room).emit('chat-pinned', { id, pinned: on, count });
    return { ok: true, pinned: on, count };
  }

  /**
   * Закреплённое канала списком — по запросу, а не в снимке при входе:
   * закреплённых бывает полсотни, и слать их каждому входящему в канал ради
   * поповера, который откроют однажды, незачем.
   */
  @SubscribeMessage('chat-pins')
  async handleChatPins(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatPinsPayload,
  ): Promise<ChatPinsResult> {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false };
    const room = client.data.chatRoom;
    if (!room) return { ok: false };
    const slug = this.chat.slug(room);
    // Спросили про другой канал — значит спрашивавший уже не здесь: отвечаем
    // отказом, а не списком того канала, где сокет оказался.
    const asked = trimmed(payload?.slug, LIMIT.slug);
    if (asked && asked !== slug) return { ok: false };
    return { ok: true, slug, pins: await this.chat.pinned(slug) };
  }

  // «Печатает…»: клиент шлёт с троттлингом, релеим остальным в канале (себе — нет).
  // Тег берём с сокета, тело клиента не нужно. allow() гасит перебор.
  @SubscribeMessage('chat-typing')
  handleChatTyping(@ConnectedSocket() client: AppSocket) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom;
    if (!room) return;
    const name = this.chatNameOf(client);
    client.to(room).emit('chat-typing', { name });
  }

  // Тогл реакции на сообщение: тег добавляется/снимается из набора по эмодзи.
  // Состояние храним в истории канала и рассылаем всем читающим — как и сами сообщения.
  @SubscribeMessage('chat-react')
  async handleChatReact(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: ChatReactPayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom;
    if (!room) return;
    const id = str(payload?.id);
    const emoji = str(payload?.emoji);
    if (!id || !this.chat.knownReaction(emoji)) return;

    const msg = await this.chat.findAny(this.chat.slug(room), id);
    if (!msg) return;

    const name = this.chatNameOf(client);
    const reactions = this.chat.toggleReaction(msg, name, emoji);
    await this.chat.saveReactions(id, reactions);

    this.server.to(room).emit('chat-reaction', { id, reactions });
  }

  handleDisconnect(client: AppSocket) {
    // Не выходим из комнат сразу: даём socket.io шанс восстановить сессию (тот же
    // id, те же комнаты). Если за грейс-период клиент не вернулся — тогда уже
    // выходим и уведомляем остальных. Так моргание сети не обрывает живой звонок.
    this.voice.hold(client);
  }

  // Пересылаем сигнал только участнику той же комнаты, что и отправитель
  private relay(client: AppSocket, event: string, to: unknown, data: Record<string, unknown>) {
    if (typeof to !== 'string') return;
    const room = this.voice.roomOf(client);
    if (!room) return;
    const target = this.server.sockets.sockets.get(to);
    if (!target || this.voice.roomOf(target) !== room) return;
    target.emit(event, { from: client.id, ...data });
  }

  /**
   * Канал удалили — распускаем его комнату. Каждому читателю говорим об этом
   * прямо (`chat-closed`), а не оставляем догадываться по новому реестру:
   * закрытые серверы делают реестр неполным, и клиент имеет право не считать
   * пропажу канала удалением. После выписки писать в канал уже нечем —
   * `chat-message` смотрит на `client.data.chatRoom`.
   */
  private closeChatRoom(slug: string) {
    const room = this.chat.room(slug);
    const ids = this.server.sockets.adapter.rooms.get(room);
    if (!ids) return;
    for (const id of [...ids]) {
      const sock = this.server.sockets.sockets.get(id);
      if (!sock) continue;
      sock.leave(room);
      sock.data.chatRoom = undefined;
      sock.data.chatName = undefined;
      sock.emit('chat-closed', { slug });
    }
  }

  private leaveChatRoom(client: AppSocket) {
    const room = client.data.chatRoom;
    if (!room) return;
    client.leave(room);
    client.data.chatRoom = undefined;
    client.data.chatName = undefined;
    // Системку о выходе не шлём: вход тоже не объявляем — ростер сам покажет уход.
    this.emitRoster(room);
  }

  /**
   * Состав текстового канала — рассылаем всем участникам.
   *
   * Список людей, а не сокетов: 1.0 разрешает одной личности войти с телефона и
   * с ноутбука разом, и без склейки по отпечатку она стояла бы в составе дважды
   * — двумя строками с одинаковым лицом и одинаковым именем. Гостей по инвайту
   * склеивать нечем и не нужно: у них нет ключа, и каждый сам по себе.
   */
  private emitRoster(room: string) {
    const ids = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const people: RosterPerson[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const sock = this.server.sockets.sockets.get(id);
      const nick = sock?.data.chatName;
      if (!nick) continue;
      const fingerprint = sock?.data.identity?.fingerprint;
      if (fingerprint) {
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
      }
      people.push(fingerprint ? { nick, fingerprint } : { nick });
    }
    this.server.to(room).emit('chat-roster', people);
  }
}

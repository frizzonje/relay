import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { isAuthorized, issueGuestToken, verifyGuestToken } from '../auth/auth';
import { sfuHealthy } from '../sfu/sfu-health';
import { issueSfuToken, sfuSecret } from '../sfu/sfu-token';
import { UploadsService } from '../uploads';
import { ChatService } from './chat.service';
import {
  MAIN_SERVER_ID,
  MAX_CHANNELS,
  MAX_SERVERS,
  RegistryService,
  slugifyChannel,
} from './registry.service';
import { Channel, ServerEntry, VoiceMode } from './registry';
import {
  type PublicChannel,
  type PublicServer,
  normalizeClientId,
  ownedBy,
  publicChannel,
} from './ownership';
import { UnlockAttempts, clientIp, hashServerPassword, verifyServerPassword } from './unlock';
import {
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
  type ChatMessage,
  type ChatPayload,
  type ChatReactPayload,
  type InviteCreatePayload,
  type InviteCreateResult,
  type JoinPayload,
  type ReplyRef,
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
  type VoicePresenceEntry,
} from './protocol';

// Строка для лога: без переводов строк (чтобы клиент не подделал чужие записи)
// и лишних пробелов.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Устройство, с которого пришёл сокет: clientId из handshake, положенный в
// client.data на подключении. Одна точка входа на все реестровые действия —
// в отдельных сообщениях его не спрашиваем и им не верим (см. ./ownership).
function deviceId(client: Socket): string | undefined {
  return client.data.clientId as string | undefined;
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
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly uploads: UploadsService,
    private readonly chat: ChatService,
    private readonly registry: RegistryService,
  ) {}

  // Отложенный выход из комнат по socket.id: при восстановлении сессии отменяем.
  private readonly pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();
  // clientId (стабильный id устройства) -> { socket.id, комната } того, кто сейчас
  // в голосовом. По нему выгоняем «призрака»: прошлый сокет того же клиента, ещё
  // висящий в комнате после перезагрузки (новый сокет — новый id, старый уходит
  // лишь по грейсу LEAVE_GRACE_MS, и всё это время участника двоит у остальных).
  private readonly voiceMembers = new Map<string, { id: string; room: string }>();
  // Грейс на восстановление сессии перед уведомлением остальных об уходе. Чуть
  // больше окна connectionStateRecovery — чтобы CSR успел отработать первым.
  private static readonly LEAVE_GRACE_MS = 24_000;

  // ── Токен-бакет на сокет ────────────────────────────────────────────────
  // Гасим флуд событий, каждое из которых иначе вызывает рассылку на весь
  // сервер (presence/чат/реестр) — O(n) обход+emit на всех. Живому человеку
  // 20 действий/с с запасом хватает (join, мут, сообщения — единицы в минуту),
  // бот на тысячах/с упрётся в пустой бакет. Заодно тормозит перебор пароля
  // закрытого сервера (server-unlock). Негоциацию (offer/answer/ice) НЕ трогаем:
  // она бывает легитимно бурстовой и релеится 1:1, дёшево.
  private static readonly RL_CAPACITY = 40;
  private static readonly RL_REFILL_PER_SEC = 20;

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
  private static readonly PRESENCE_DEBOUNCE_MS = 80;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

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
  private readonly logger = new Logger(SignalingGateway.name);

  private allow(client: Socket): boolean {
    const now = Date.now();
    const bucket = (client.data.rl as { tokens: number; ts: number } | undefined) ?? {
      tokens: SignalingGateway.RL_CAPACITY,
      ts: now,
    };
    const elapsed = (now - bucket.ts) / 1000;
    bucket.tokens = Math.min(
      SignalingGateway.RL_CAPACITY,
      bucket.tokens + elapsed * SignalingGateway.RL_REFILL_PER_SEC,
    );
    bucket.ts = now;
    client.data.rl = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // Socket.io цепляется к http-серверу мимо express-миддлвар,
  // поэтому пропуск проверяем прямо в handshake
  handleConnection(client: Socket) {
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
    const pending = this.pendingLeave.get(client.id);
    if (pending) {
      clearTimeout(pending);
      this.pendingLeave.delete(client.id);
    }
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
      const presence = this.buildVoicePresence();
      client.emit(
        'voice-presence',
        guest.slug in presence ? { [guest.slug]: presence[guest.slug] } : {},
      );
      return;
    }
    // Набор серверов, разблокированных этим сокетом (закрытые под паролем).
    // `??=` — чтобы восстановление сессии (CSR) не сбросило уже введённые пароли.
    (client.data.unlocked as Set<string>) ??= new Set<string>();
    // Новому клиенту сразу шлём реестры серверов и каналов и кто где в голосовых.
    // Серверы — публичная форма (без хэшей, с флагом locked); каналы — только
    // видимые ему (закрытые серверы скрыты до ввода пароля).
    client.emit('servers', this.publicServersFor(client));
    client.emit('channels', this.channelsFor(client));
    client.emit('voice-presence', this.presenceFor(client, this.buildVoicePresence()));
  }

  // Гость по инвайту: разрешён только эфир своей комнаты (join/leave/сигналинг/
  // media-update/rename) — остальные обработчики выходят на этом гарде.
  private isGuest(client: Socket): boolean {
    return client.data.guest === true;
  }

  // Публичная форма реестра серверов: без хэша пароля, с флагом `locked` и с
  // `mine` — «этой записью управляешь ты». Наружу уходит именно флаг, а не
  // clientId владельца: рассылать id значило бы раздавать всем то единственное,
  // чем правило владения и держится (см. ./ownership).
  private publicServersFor(client: Socket): PublicServer[] {
    return this.registry.publicServers(deviceId(client));
  }

  // Каналы, видимые сокету: из закрытых серверов — только если он их разблокировал.
  // Текстовым подмешиваем время последнего сообщения: по нему клиент зажигает
  // «непрочитано» сразу после загрузки, не дожидаясь живого `chat-activity`.
  private channelsFor(client: Socket): PublicChannel[] {
    const clientId = deviceId(client);
    return this.registry.channels
      .filter((c) => this.canSee(client, c))
      .map((c) => publicChannel(c, clientId, c.type === 'text' ? this.chat.lastTs(c.slug) : 0));
  }

  // Разблокировки этого сокета — набор id закрытых серверов, чьи пароли он ввёл.
  // Набор заводится на подключении (handleConnection, рядом с остальными полями
  // сокета), а читают и пополняют его ТОЛЬКО методы ниже: сырой доступ к
  // нетипизированному client.data расползался по обработчикам, и каждая копия
  // сама решала, что делать с его отсутствием.
  private unlockedOf(client: Socket): Set<string> | undefined {
    return client.data.unlocked as Set<string> | undefined;
  }

  // Пароль сервера принят — запоминаем разблокировку на этом сокете.
  private markUnlocked(client: Socket, serverId: string) {
    this.unlockedOf(client)?.add(serverId);
  }

  // Открыт ли сервер этому сокету: открытый — всем, закрытый — только тому,
  // кто ввёл пароль. Право на сам сервер, не на его каналы (те — canSee).
  private isOpenTo(client: Socket, server: ServerEntry): boolean {
    return !server.passwordHash || this.unlockedOf(client)?.has(server.id) === true;
  }

  // Видит ли сокет этот канал: закрытый сервер — только после ввода пароля.
  private canSee(client: Socket, channel: Channel): boolean {
    return this.registry.canSee(this.unlockedOf(client), channel);
  }

  /**
   * Вправе ли сокет войти в голосовую комнату. Комната, за которой нет канала
   * реестра, — это «сирота» (канал удалили под живым разговором) или комната
   * инвайта: их не запираем, запирать нечего. А вот канал закрытого сервера
   * пускает только по паролю: `join` берёт слаг, и без этой проверки пароль
   * обходится одной строкой, даже когда сам канал в списке не показан.
   */
  private mayEnter(client: Socket, room: string): boolean {
    const channel = this.registry.channels.find((c) => c.type === 'voice' && c.slug === room);
    return !channel || this.canSee(client, channel);
  }

  /**
   * Присутствие в форме, пригодной этому сокету. Правило белого списка: комната
   * едет к нему, только если за ней стоит видимый ему канал реестра. Слаг канала
   * закрытого сервера — такой же секрет, как и сам канал (по нему заходят: `join`
   * берёт слаг, а не id), а комната, которой в реестре нет вовсе, — вообще не
   * канал: `join` пускает в любой слаг, и рассылка такой строки означала бы, что
   * каждый участник может нарисовать остальным на главном сервере «эфир» с
   * произвольным названием. Своя комната — исключение: в ней человек сидит, и
   * не показать её ему было бы враньём.
   */
  private presenceFor(
    client: Socket,
    presence: Record<string, VoicePresenceEntry[]>,
  ): Record<string, VoicePresenceEntry[]> {
    const own = typeof client.data.room === 'string' ? client.data.room : null;
    const visible = new Set<string>();
    for (const c of this.registry.channels) {
      if (c.type === 'voice' && this.canSee(client, c)) visible.add(c.slug);
    }
    return Object.fromEntries(
      Object.entries(presence).filter(([room]) => room === own || visible.has(room)),
    );
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

  // Чем этот сокет отличается от прочих с точки зрения владения: ничем, если
  // среди записей нет ни одной его. Пустая строка — общая группа «не владелец».
  private ownerKey(client: Socket, owners: Set<string>): string {
    const clientId = deviceId(client);
    return clientId && owners.has(clientId) ? clientId : '';
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
    @ConnectedSocket() client: Socket,
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

    // Владелец — то устройство, с которого сервер создали (clientId из
    // handshake). Личности оно не удостоверяет (см. ./ownership): это заслон
    // от случайного и ленивого сноса чужого сервера, не от атаки. Настоящие
    // права придут со слоями 2–3 плана 1.0.
    this.registry.servers.push({
      id,
      name,
      emoji,
      removable: true,
      passwordHash,
      creatorId: deviceId(client),
    });
    // Создатель знает пароль — сразу разблокируем сервер для его сокета.
    if (passwordHash) this.markUnlocked(client, id);
    this.broadcastServers();
    // Раздаём каналы заново: у создателя новый сервер уже разблокирован.
    this.broadcastChannels();
    this.registry.persist();
  }

  @SubscribeMessage('server-unlock')
  async handleServerUnlock(
    @ConnectedSocket() client: Socket,
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
      client.emit('voice-presence', this.presenceFor(client, this.buildVoicePresence()));
    }
    client.emit('server-unlock-result', { id, ok });
  }

  @SubscribeMessage('server-delete')
  handleServerDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ServerDeletePayload,
  ): ServerDeleteResult {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const id = str(payload?.id);
    if (!id) return { ok: false, error: 'not-found' };
    const idx = this.registry.servers.findIndex((s) => s.id === id && s.removable);
    if (idx === -1) return { ok: false, error: 'not-found' };
    // Закрытый сервер удалить может только тот, кто ввёл пароль (разблокировал).
    const srv = this.registry.servers[idx];
    if (!this.isOpenTo(client, srv)) return { ok: false, error: 'forbidden' };
    // Владелец — создатель сервера (clientId из handshake). У записей без
    // creatorId (созданы до этого правила) владельца не существует: права
    // прежние. Заблокировать их удаление навсегда было бы хуже — чужой не
    // нарочно удалит разве что по неосторожности, а лишённый возможности
    // хозяин не восстановит сервер никак. Отказ пишем в лог: чужой снос —
    // событие, а не шум.
    if (!ownedBy(srv, deviceId(client))) {
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
      this.registry.channels.splice(i, 1);
      if (channel.type !== 'text') continue;
      this.chat.forget(channel.slug);
      this.closeChatRoom(channel.slug);
    }
    if (this.registry.channels.length !== before) this.broadcastChannels();
    this.registry.persist();
    return { ok: true };
  }

  // Цена удаления сервера для диалога подтверждения: сколько каналов и сколько
  // сообщений исчезнет вместе с ним и сколько человек сидит в его эфирах
  // (пока сидят — сервер не удаляется вовсе, см. server-delete). Права те же,
  // что у server-delete: срез нужен владельцу, которому сервер покажет кнопку,
  // а раздавать его каждому значило бы рассказывать всем, сколько написано в
  // чужих каналах.
  @SubscribeMessage('server-stats')
  handleServerStats(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ServerStatsPayload,
  ): ServerStatsResult {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const srv = this.registry.servers.find((s) => s.id === id);
    if (!srv || !srv.removable) return { ok: false };
    if (!this.isOpenTo(client, srv)) return { ok: false };
    if (!ownedBy(srv, deviceId(client))) return { ok: false };
    let channels = 0;
    let messages = 0;
    for (const c of this.registry.channels) {
      if (c.serverId !== id) continue;
      channels++;
      if (c.type === 'text') {
        messages += this.chat.count(c.slug);
      }
    }
    return { ok: true, channels, messages, occupants: this.voiceOccupantsOfServer(id) };
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
      const room = sock.data.room as string | undefined;
      if (room && rooms.has(room)) count++;
    }
    return count;
  }

  // ===== Реестр каналов =====

  @SubscribeMessage('channel-create')
  handleChannelCreate(
    @ConnectedSocket() client: Socket,
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
      // Владелец канала — создавшее его устройство, как у серверов: заслон
      // от случайного сноса, не личность (см. handleServerCreate).
      creatorId: deviceId(client),
      // Режим — только у голосовых; p2p по умолчанию не пишем, отсутствие поля
      // и есть p2p (реестр не распухает, старые записи читаются одинаково).
      ...(type === 'voice' && payload?.mode === 'sfu' ? { mode: 'sfu' as const } : {}),
    };
    this.registry.channels.push(channel);
    this.broadcastChannels();
    this.registry.persist();
  }

  // Смена транспорта голосового канала. Права те же, что у channel-delete:
  // трогать можно только свои каналы (removable), дефолтные остаются на p2p —
  // они обязаны работать и без поднятого медиасервера.
  @SubscribeMessage('channel-mode')
  handleChannelMode(@ConnectedSocket() client: Socket, @MessageBody() payload: ChannelModePayload) {
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
    this.registry.persist();
  }

  /**
   * Сколько человек прямо сейчас в канале: для голосового — кто в эфире, для
   * текстового — у кого он открыт (socket.io-комната `chat:<slug>`).
   */
  private occupantsOf(channel: Channel): number {
    const target = channel.type === 'voice' ? channel.slug : this.chat.room(channel.slug);
    let count = 0;
    for (const sock of this.server.sockets.sockets.values()) {
      const where = (channel.type === 'voice' ? sock.data.room : sock.data.chatRoom) as
        | string
        | undefined;
      if (where === target) count++;
    }
    return count;
  }

  /**
   * Канал, который этому сокету разрешено менять. Само правило — в реестре
   * (RegistryService.editable); здесь только распаковка сокета: чьи пароли
   * введены и с какого устройства пришли.
   */
  private editableChannel(client: Socket, id: string) {
    return this.registry.editable(id, this.unlockedOf(client), deviceId(client));
  }

  // Живой срез канала для диалога подтверждения (сколько человек внутри,
  // сколько сообщений пропадёт). Спрашивают по одному разу на открытие
  // диалога — рассылать это всем постоянно незачем. Права — как у правки:
  // срез канала с людьми и перепиской — это уже данные о нём, их не раздаём.
  @SubscribeMessage('channel-stats')
  handleChannelStats(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChannelStatsPayload,
  ): ChannelStatsResult {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false };
    const id = str(payload?.id);
    const found = this.editableChannel(client, id);
    if ('error' in found) return { ok: false };
    const channel = found.channel;
    return {
      ok: true,
      occupants: this.occupantsOf(channel),
      messages: channel.type === 'text' ? this.chat.count(channel.slug) : 0,
    };
  }

  // Переименование канала. Меняем ТОЛЬКО отображаемое имя: slug остаётся
  // прежним, потому что по нему ключуются комната эфира, история чата и
  // «непрочитано» — смена имени не должна ни рвать живой звонок, ни терять
  // переписку. Права те же, что у удаления: дефолтные каналы неприкосновенны.
  @SubscribeMessage('channel-rename')
  handleChannelRename(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChannelRenamePayload,
  ): ChannelRenameResult {
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
    this.registry.persist();
    return { ok: true };
  }

  @SubscribeMessage('channel-delete')
  handleChannelDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChannelDeletePayload,
  ): ChannelDeleteResult {
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

    this.registry.channels.splice(index, 1);
    // История удалённого канала больше никому не принадлежит: держать её в
    // памяти незачем, а канал с тем же слагом иначе унаследовал бы чужую ленту.
    // Читателей выписываем сами: их клиент мог бы и не заметить пропажу канала
    // в новом реестре, а остаться в комнате — значит продолжать писать в канал,
    // которого больше нет ни у кого (и заново набивать только что стёртую ленту).
    if (channel.type === 'text') {
      this.chat.forget(channel.slug);
      this.closeChatRoom(channel.slug);
    }
    this.broadcastChannels();
    this.registry.persist();
    return { ok: true };
  }

  // ===== Инвайт-ссылки =====

  // Инвайт на войс-канал: подписанный токен без хранения на сервере (24 часа,
  // многоразовый). Абсолютный URL строит клиент из window.location.origin.
  // Возвращаемое значение = socket.io ack.
  @SubscribeMessage('invite-create')
  handleInviteCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: InviteCreatePayload,
  ): InviteCreateResult {
    if (!this.allow(client) || this.isGuest(client)) return { ok: false, error: 'forbidden' };
    const slug = trimmed(payload?.room, LIMIT.slug);
    // Канал должен существовать, быть голосовым и быть видимым этому сокету
    // (каналы закрытых серверов — только после ввода пароля).
    const channel = this.channelsFor(client).find((c) => c.type === 'voice' && c.slug === slug);
    if (!channel) return { ok: false, error: 'not-found' };
    const { token, exp } = issueGuestToken(slug);
    return { ok: true, token, exp };
  }

  // ===== Пропуск в медиасервер =====

  // Пропуск на namespace /sfu: короткоживущий подписанный токен + адрес
  // медиасервера. Комнату и peerId берём из состояния сокета, а не из запроса —
  // напроситься в чужой канал или назваться чужим id так нельзя. Гость проходит
  // на общих основаниях: он уже «пришит» к своей комнате.
  @SubscribeMessage('sfu-token')
  async handleSfuToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SfuTokenPayload,
  ): Promise<SfuTokenResult> {
    if (!this.allow(client)) return { ok: false, error: 'forbidden' };
    const url = (process.env.SFU_URL ?? '').trim();
    if (!url || !sfuSecret()) return { ok: false, error: 'unavailable' };
    // Настроен — не значит жив: пропуск в лежащий медиасервер собирает комнату
    // в расщеплённое «вижу, но не слышу». Пинг с коротким кэшем, sfu-health.ts.
    if (!(await sfuHealthy())) {
      this.logger.warn(`sfu-token denied (sfu down) for ${client.id}`);
      return { ok: false, error: 'unavailable' };
    }
    // Комната приходит в запросе: клиенту нужно знать транспорт ДО `join`,
    // иначе он пропустит ответный `peers`. Секрета в ней нет — войти в любой
    // голосовой канал он и так вправе, а `peerId` по-прежнему берётся из
    // сокета, так что назваться чужим id нельзя.
    const asked = trimmed(payload?.room, LIMIT.slug);
    const room = asked || (typeof client.data.room === 'string' ? client.data.room : '');
    if (!room) return { ok: false, error: 'not-in-room' };
    // Гость «пришит» к своему каналу — чужую комнату не спросит.
    if (this.isGuest(client) && room !== client.data.guestRoom) {
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
    if (!channel || channel.mode !== 'sfu') return { ok: false, error: 'not-sfu' };
    // Имя берём из запроса: пропуск спрашивают ДО `join`, и client.data.name в
    // этот момент ещё пуст (заполнен он только при пере-выдаче во время звонка).
    // Лимит — тот же, что у `join`.
    const askedName = trimmed(payload?.name, LIMIT.tag);
    const name = askedName || (typeof client.data.name === 'string' ? client.data.name : '');
    const { token, exp } = issueSfuToken({ room, peerId: client.id, name });
    // Запоминаем выдачу: клиент, не умеющий сообщать транспорт в `join` (бандл
    // прошлой версии), иначе сошёл бы за p2p — и остальные съехали бы в прямые
    // звонки, разъехавшись с ним по-настоящему. Пропуск — лучшее, что о таком
    // клиенте известно: за ним идут в медиасервер.
    client.data.sfuPassRoom = room;
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
  handleVoiceDiag(@ConnectedSocket() client: Socket, @MessageBody() payload: VoiceDiagPayload) {
    if (!this.allow(client)) return;
    const event = oneLine(str(payload?.event)).slice(0, LIMIT.diagEvent);
    if (!event) return;
    const detail = oneLine(str(payload?.detail)).slice(0, LIMIT.diagDetail);
    const name = (client.data.name as string) || '?';
    this.logger.log(`diag ${name} (${client.id}): ${event}${detail ? ` ${detail}` : ''}`);
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: Socket, @MessageBody() payload: JoinPayload) {
    if (!this.allow(client)) return;
    const room = trimmed(payload?.room, LIMIT.slug);
    if (!room) return;
    // Гость «пришит» к каналу из своего токена — другие комнаты недоступны.
    if (this.isGuest(client) && room !== client.data.guestRoom) return;
    // Канал закрытого сервера — только для тех, кто ввёл пароль. Комнату, которой
    // в реестре нет вовсе, пропускаем: это либо канал, удалённый под живым
    // разговором, либо инвайт-комната, и запирать их не за что.
    if (!this.isGuest(client) && !this.mayEnter(client, room)) {
      this.logger.warn(`voice: join to locked room "${room}" refused for ${client.id}`);
      return;
    }
    const name = optional(payload?.name, LIMIT.tag);
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
    const transport =
      payload?.transport === 'sfu' || payload?.transport === 'p2p'
        ? payload.transport
        : client.data.sfuPassRoom === room
          ? 'sfu'
          : 'p2p';

    // Повторный join без leave (например, после обрыва) — сначала выходим из старой комнаты
    this.leaveRoom(client);

    // Выгоняем «призрака»: прошлый сокет того же устройства, ещё висящий в этой
    // комнате (перезагрузка страницы = новый id, старый уйдёт лишь по грейсу).
    // Так участника не двоит у остальных. Делаем ДО сбора списка пиров.
    if (clientId) this.evictGhost(clientId, client.id);
    client.data.clientId = clientId;

    // Только реально подключённые сокеты: в adapter.rooms может ещё висеть id
    // отвалившегося пира (окно connectionStateRecovery) — ему offer слать некому.
    const peerIds = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const peers = [...peerIds]
      .filter((id) => this.server.sockets.sockets.has(id))
      .map((id) => {
        const sock = this.server.sockets.sockets.get(id);
        return {
          id,
          name: sock?.data.name as string | undefined,
          ...(sock?.data.guest === true ? { guest: true } : {}),
        };
      });

    client.join(room);
    client.data.room = room;
    client.data.name = name;
    client.data.transport = transport;
    if (clientId) this.voiceMembers.set(clientId, { id: client.id, room });
    // Медиасостояние прошлого захода не тащим: клиент пришлёт своё сразу после join.
    client.data.micOn = undefined;
    client.data.deafened = undefined;

    // Новичку — список тех, кто уже в канале (он шлёт им offer'ы),
    // остальным — уведомление о пополнении
    client.emit('peers', peers);
    client.to(room).emit('peer-joined', {
      id: client.id,
      name,
      ...(this.isGuest(client) ? { guest: true } : {}),
    });
    this.broadcastVoicePresence();
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
    const split = this.transportsInRoom(room);
    if (split.size > 1) {
      this.logger.warn(
        `voice: room "${room}" is split across transports: ${[...split].join(' + ')}`,
      );
    }
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: Socket) {
    this.leaveRoom(client);
  }

  @SubscribeMessage('offer')
  handleOffer(@ConnectedSocket() client: Socket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'offer', payload?.to, {
      name: client.data.name as string | undefined,
      sdp: payload?.sdp,
    });
  }

  @SubscribeMessage('answer')
  handleAnswer(@ConnectedSocket() client: Socket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'answer', payload?.to, { sdp: payload?.sdp });
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(@ConnectedSocket() client: Socket, @MessageBody() payload: SignalPayload) {
    this.relay(client, 'ice-candidate', payload?.to, { candidate: payload?.candidate });
  }

  @SubscribeMessage('media-update')
  handleMediaUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { camOn?: unknown; screenOn?: unknown; micOn?: unknown; deafened?: unknown },
  ) {
    if (!this.allow(client)) return;
    const room = client.data.room as string | undefined;
    if (!room) return;
    // Мут/глушилку запоминаем на сокете — их раздаёт voice-presence (индикаторы в
    // сайдбаре видят и те, кто сам не в эфире). micOn по умолчанию true.
    const prevMic = client.data.micOn;
    const prevDeafened = client.data.deafened;
    client.data.micOn = payload?.micOn !== false;
    client.data.deafened = payload?.deafened === true;
    client.to(room).emit('media-update', {
      from: client.id,
      camOn: payload?.camOn === true,
      screenOn: payload?.screenOn === true,
      micOn: client.data.micOn,
      deafened: client.data.deafened,
    });
    // Presence несёт только мут/глушилку — камеру/экран (или повтор того же
    // состояния) не гоним на весь сервер. Рассылаем лишь при реальной их смене.
    if (client.data.micOn !== prevMic || client.data.deafened !== prevDeafened) {
      this.broadcastVoicePresence();
    }
  }

  // Смена тега на лету: обновляем имя в голосовой комнате (presence + подписи
  // плиток у собеседников) и в текстовом канале (ростер). Пустое имя игнорируем.
  @SubscribeMessage('rename')
  handleRename(@ConnectedSocket() client: Socket, @MessageBody() payload: { name?: unknown }) {
    if (!this.allow(client)) return;
    const name = trimmed(payload?.name, LIMIT.tag);
    if (!name) return;

    const room = client.data.room as string | undefined;
    if (room && client.data.name !== name) {
      client.data.name = name;
      client.to(room).emit('peer-renamed', { id: client.id, name });
      this.broadcastVoicePresence();
    }

    const chatRoom = client.data.chatRoom as string | undefined;
    if (chatRoom && client.data.chatName !== name) {
      client.data.chatName = name;
      this.emitRoster(chatRoom);
    }
  }

  // ===== Текстовый канал =====

  @SubscribeMessage('chat-join')
  handleChatJoin(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const slug = trimmed(payload?.room, LIMIT.slug);
    if (!slug) return;
    const name = trimmed(payload?.name, LIMIT.tag);

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
    client.data.chatName = name || 'Аноним';

    // Новичку — история канала.
    client.emit('chat-history', this.chat.messages(room));
    this.emitRoster(room);
  }

  @SubscribeMessage('chat-leave')
  handleChatLeave(@ConnectedSocket() client: Socket) {
    this.leaveChatRoom(client);
  }

  @SubscribeMessage('chat-message')
  handleChatMessage(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const text = trimmed(payload?.text, LIMIT.message);

    // Вложение берём из доверенного реестра по id (клиент не задаёт url/mime сам).
    // Спойлер — метка сообщения: копируем вложение, чтобы не мутировать общий реестр.
    const stored = this.uploads.get(str(payload?.uploadId));
    const attachment = stored && payload?.spoiler === true ? { ...stored, spoiler: true } : stored;

    // Пустое сообщение без вложения — игнорируем
    if (!text && !attachment) return;

    const history = this.chat.messages(room);

    // Ответ: снимок цитируемого сообщения того же канала (усечённый текст). Само
    // сообщение могут потом отредактировать/удалить — цитата останется прежней.
    const replyToId = str(payload?.replyTo);
    const src = replyToId ? history.find((m) => m.id === replyToId && !m.system) : undefined;
    const replyTo: ReplyRef | undefined = src
      ? { id: src.id!, name: src.name, text: src.text.slice(0, 140) }
      : undefined;

    const msg: ChatMessage = {
      id: randomUUID(),
      name: (client.data.chatName as string) || 'Аноним',
      text,
      ts: Date.now(),
      ...(attachment ? { attachment } : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    this.chat.add(room, msg);

    this.server.to(room).emit('chat', msg);
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
        const unlocked = sock.data.unlocked as Set<string> | undefined;
        for (const [slug, { ts, locked }] of batch) {
          if (locked && !unlocked?.has(locked)) continue;
          sock.emit('chat-activity', { slug, ts });
        }
      }
    }, SignalingGateway.REGISTRY_DEBOUNCE_MS);
    this.activityTimer.unref?.();
  }

  // Правка своего сообщения. Автора сверяем по тегу (chatName) — та же модель
  // доверия, что у реакций: имя самоназначаемое, но менять чужие реплики нельзя.
  // Системные и сообщения-вложения без текста не редактируем.
  @SubscribeMessage('chat-edit')
  handleChatEdit(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatEditPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const id = str(payload?.id);
    const text = trimmed(payload?.text, LIMIT.message);
    if (!id || !text) return;

    const msg = this.chat.find(room, id);
    if (!msg) return;
    const name = (client.data.chatName as string) || 'Аноним';
    if (msg.name !== name) return;

    msg.text = text;
    msg.editedTs = Date.now();
    this.server.to(room).emit('chat-edited', { id, text, editedTs: msg.editedTs });
  }

  // Удаление своего сообщения (автор — по тегу, как в chat-edit). Убираем из
  // истории и просим всех снять из ленты. Цитаты в чужих ответах не трогаем —
  // они хранят собственный снимок.
  @SubscribeMessage('chat-delete')
  handleChatDelete(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatDeletePayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const id = str(payload?.id);
    if (!id) return;

    const msg = this.chat.find(room, id);
    if (!msg) return;
    const name = (client.data.chatName as string) || 'Аноним';
    if (msg.name !== name) return;

    if (!this.chat.remove(room, msg)) return;
    this.server.to(room).emit('chat-deleted', { id });
  }

  // «Печатает…»: клиент шлёт с троттлингом, релеим остальным в канале (себе — нет).
  // Тег берём с сокета, тело клиента не нужно. allow() гасит перебор.
  @SubscribeMessage('chat-typing')
  handleChatTyping(@ConnectedSocket() client: Socket) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const name = (client.data.chatName as string) || 'Аноним';
    client.to(room).emit('chat-typing', { name });
  }

  // Тогл реакции на сообщение: тег добавляется/снимается из набора по эмодзи.
  // Состояние храним в истории канала и рассылаем всем читающим — как и сами сообщения.
  @SubscribeMessage('chat-react')
  handleChatReact(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatReactPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const id = str(payload?.id);
    const emoji = str(payload?.emoji);
    if (!id || !this.chat.knownReaction(emoji)) return;

    const msg = this.chat.findAny(room, id);
    if (!msg) return;

    const name = (client.data.chatName as string) || 'Аноним';
    const reactions = this.chat.toggleReaction(msg, name, emoji);

    this.server.to(room).emit('chat-reaction', { id, reactions });
  }

  handleDisconnect(client: Socket) {
    // Не выходим из комнат сразу: даём socket.io шанс восстановить сессию (тот же
    // id, те же комнаты). Если за грейс-период клиент не вернулся — тогда уже
    // выходим и уведомляем остальных. Так моргание сети не обрывает живой звонок.
    const id = client.id;
    const timer = setTimeout(() => {
      this.pendingLeave.delete(id);
      this.leaveRoom(client);
      this.leaveChatRoom(client);
    }, SignalingGateway.LEAVE_GRACE_MS);
    timer.unref?.();
    this.pendingLeave.set(id, timer);
  }

  // Пересылаем сигнал только участнику той же комнаты, что и отправитель
  private relay(client: Socket, event: string, to: unknown, data: Record<string, unknown>) {
    if (typeof to !== 'string') return;
    const room = client.data.room as string | undefined;
    if (!room) return;
    const target = this.server.sockets.sockets.get(to);
    if (!target || target.data.room !== room) return;
    target.emit(event, { from: client.id, ...data });
  }

  // Убираем прошлый сокет того же устройства из голосового. Два случая:
  // — сокет ещё жив (второй таб / сессия сохранена CSR) — штатно выводим leaveRoom;
  // — сокет уже отвалился (перезагрузка) — шлём peer-left по его id в ЕГО комнату,
  //   чтобы плитку сняли сразу, не дожидаясь грейса. В обоих отменяем отложенный выход.
  private evictGhost(clientId: string, keepId: string) {
    const ghost = this.voiceMembers.get(clientId);
    if (!ghost || ghost.id === keepId) return;
    const timer = this.pendingLeave.get(ghost.id);
    if (timer) {
      clearTimeout(timer);
      this.pendingLeave.delete(ghost.id);
    }
    const sock = this.server.sockets.sockets.get(ghost.id);
    if (sock) {
      // Живой сокет: штатный выход сам снимет запись из voiceMembers.
      this.leaveRoom(sock);
    } else {
      // Отвалившийся: сокета уже нет — сами уведомляем комнату и чистим карту.
      this.server.to(ghost.room).emit('peer-left', { id: ghost.id });
      this.voiceMembers.delete(clientId);
      this.broadcastVoicePresence();
    }
  }

  /** Какими транспортами сейчас звонят в комнате. Больше одного = расщепление. */
  private transportsInRoom(room: string): Set<string> {
    const kinds = new Set<string>();
    for (const id of this.server.sockets.adapter.rooms.get(room) ?? []) {
      const sock = this.server.sockets.sockets.get(id);
      if (sock) kinds.add(sock.data.transport === 'sfu' ? 'sfu' : 'p2p');
    }
    return kinds;
  }

  private leaveRoom(client: Socket) {
    const room = client.data.room as string | undefined;
    if (room) {
      this.logger.log(
        `voice: ${(client.data.name as string) || '?'} (${client.id}) left "${room}"`,
      );
      client.to(room).emit('peer-left', { id: client.id });
      client.leave(room);
      client.data.room = undefined;
      client.data.transport = undefined;
      const clientId = client.data.clientId as string | undefined;
      if (clientId && this.voiceMembers.get(clientId)?.id === client.id) {
        this.voiceMembers.delete(clientId);
      }
      this.broadcastVoicePresence();
    }
  }

  // Кто сейчас в каких голосовых каналах (формат совпадает с VoicePeer из shared)
  private buildVoicePresence(): Record<string, VoicePresenceEntry[]> {
    const presence: Record<string, VoicePresenceEntry[]> = {};
    for (const [id, sock] of this.server.sockets.sockets) {
      const room = sock.data.room as string | undefined;
      if (!room) continue;
      (presence[room] ??= []).push({
        id,
        name: (sock.data.name as string) || 'Аноним',
        micOn: sock.data.micOn !== false,
        deafened: sock.data.deafened === true,
        transport: sock.data.transport === 'sfu' ? 'sfu' : 'p2p',
        ...(sock.data.guest === true ? { guest: true } : {}),
      });
    }
    return presence;
  }

  // Коалесцирующий (trailing-edge) дебаунс: пачка событий за окно = один emit
  // с итоговым состоянием. Таймер уже взведён — ничего не делаем.
  // Рассылка пер-сокетная (как broadcastChannels): гостям — только срез их
  // комнаты, чтобы состав остальных каналов не утекал за инвайт.
  private broadcastVoicePresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const presence = this.buildVoicePresence();
      for (const sock of this.server.sockets.sockets.values()) {
        if (sock.data.guest === true) {
          const room = sock.data.guestRoom as string;
          sock.emit('voice-presence', room in presence ? { [room]: presence[room] } : {});
        } else {
          sock.emit('voice-presence', this.presenceFor(sock, presence));
        }
      }
    }, SignalingGateway.PRESENCE_DEBOUNCE_MS);
    this.presenceTimer.unref?.();
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

  private leaveChatRoom(client: Socket) {
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    client.leave(room);
    client.data.chatRoom = undefined;
    client.data.chatName = undefined;
    // Системку о выходе не шлём: вход тоже не объявляем — ростер сам покажет уход.
    this.emitRoster(room);
  }

  // Состав текстового канала — рассылаем всем участникам
  private emitRoster(room: string) {
    const ids = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const names = [...ids]
      .map((id) => this.server.sockets.sockets.get(id)?.data.chatName as string | undefined)
      .filter((n): n is string => !!n);
    this.server.to(room).emit('chat-roster', names);
  }
}

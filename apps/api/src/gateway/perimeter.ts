import { Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { IdentityService, type Speaker } from '../identity/identity.service';
import { OwnerService } from '../identity/owner.service';
import { RolesService } from '../identity/roles.service';
import type { AppServer, AppSocket, TokenBucket } from './socket-data';
import { Channel, ServerEntry } from './registry';
import { MAX_SERVERS, RegistryService } from './registry.service';
import { type Claimant } from './ownership';
import { UnlockAttempts, clientIp, verifyServerPassword, verifyUnlockToken } from './unlock';

/** Права гостя, приехавшие подписанными в токене приглашения. */
export interface GuestPass {
  slug: string;
  listen: boolean;
}

/**
 * Контур доступа: кто это и что ему здесь можно.
 *
 * Раньше на этот вопрос отвечали семь приватных методов, разбросанных между
 * обработчиками, и три карты состояния рядом с ними. Спрашивали их по-разному,
 * и каждый обработчик сам решал, что делать с отсутствующим ответом. Теперь
 * спрашивают у одного объекта.
 *
 * Внутри — четыре разных заслона, и путать их не стоит:
 *
 * 1. **Личность** (`recognize`): ключ, власть над инсталляцией, баны. Узнаётся
 *    один раз, в миддлваре, до первого события клиента.
 * 2. **Гость** (`admit`): пришёл по ссылке, пришит к одному каналу, реестра не
 *    видит вовсе.
 * 3. **Замок** (`unlock*`, `canSee`, `mayEnter`): пароль закрытого сервера. Он
 *    же запирает и слаги его каналов — иначе пароль обходится одной строкой.
 * 4. **Лимитер** (`allow`, `allowDiag`): два раздельных ведра, чтобы
 *    телеметрия не съедала звонок.
 */
export class Perimeter {
  // ── Лимитер ───────────────────────────────────────────────────────────────
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

  // ── Замки ─────────────────────────────────────────────────────────────────
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

  // ── Выгнанные гости ───────────────────────────────────────────────────────
  // «комната + устройство» → до какого времени дверь закрыта. Ссылка
  // многоразовая и живёт сутки, поэтому без этой карты «выгнать» не значило бы
  // ничего. Час — не наказание, а пауза: он переживает обиду и перезаход, но не
  // превращает случайный клик в приговор до конца инвайта. Хранится в памяти
  // процесса: рестарт api прощает всех, и это честно — серьёзный запрет живёт в
  // пароле сервера, а не здесь.
  private readonly guestBans = new Map<string, number>();
  private static readonly GUEST_BAN_MS = 60 * 60 * 1000;

  constructor(
    private readonly registry: RegistryService,
    private readonly identities: IdentityService,
    private readonly owner: OwnerService,
    private readonly roles: RolesService,
    private readonly serverOf: () => AppServer | undefined,
    private readonly logger: Logger,
  ) {}

  // ── Личность ──────────────────────────────────────────────────────────────

  /**
   * Узнать, кто пришёл. Возвращает `true`, если вход закрыт вовсе.
   *
   * Зовётся из миддлвары, а не из `handleConnection`, и разница не
   * стилистическая: миддлвара отрабатывает ДО того, как сокет считается
   * подключённым, и до неё клиент физически не может ничего прислать. Узнавай
   * мы личность в обработчике подключения (он синхронный, а запрос в базу —
   * нет), первые сообщения успели бы пройти как «безымянные» — то есть ровно
   * те, которыми открывают канал и здороваются.
   *
   * Неудача не рвёт соединение: без личности живут гость по инвайту и клиент,
   * ещё не прошедший челлендж. Их имена остаются самоназванными, и это честно —
   * ручается за них не ключ, а токен приглашения.
   */
  async recognize(socket: AppSocket): Promise<boolean> {
    try {
      const speaker = await this.identities.fromCookie(socket.handshake.headers.cookie);
      if (speaker) {
        socket.data.identity = speaker;
        // Власть над инсталляцией выясняется здесь же и один раз: её спрашивает
        // каждая рассылка реестра, а меняется она перевыпуском ссылки
        // владельца — событием со своим обработчиком (см. `resyncOwner`).
        socket.data.owner = await this.owner.isOwner(speaker.id);
        const rights = await this.roles.rightsOf(speaker.id);
        socket.data.bannedFrom = rights.bannedFrom;
        socket.data.banned = rights.banned;
      }
    } catch (e) {
      this.logger.error(`не удалось узнать личность сокета: ${e}`);
    }
    return socket.data.banned === true;
  }

  /**
   * Власть сменилась — пересобрать её у живых сокетов. Иначе бывший хозяин ещё
   * часами удалял бы чужие серверы с уже недействительным правом.
   */
  async resyncOwner(): Promise<void> {
    const ownerId = await this.owner.ownerId();
    for (const socket of this.serverOf()?.sockets.sockets.values() ?? []) {
      socket.data.owner = !!ownerId && socket.data.identity?.id === ownerId;
    }
  }

  /** Личность этого сокета — или `undefined`: гость, старый клиент, чужой ключ. */
  speaker(client: AppSocket): Speaker | undefined {
    return client.data.identity;
  }

  /**
   * Кто спрашивает, с точки зрения прав: устройство, личность за ним и власть
   * над инсталляцией. Собирается из того, что уже лежит на сокете, — в базу за
   * этим не ходят: правами интересуется каждая рассылка реестра, а меняются они
   * считанные разы за жизнь инсталляции (см. `resyncOwner`).
   */
  claimant(client: AppSocket): Claimant {
    return {
      clientId: client.data.clientId,
      identityId: this.speaker(client)?.id,
      owner: this.isOwner(client),
    };
  }

  /** Есть ли у сокета власть над инсталляцией. */
  isOwner(client: AppSocket): boolean {
    return client.data.owner === true;
  }

  /** Серверы, с которых этот сокет забанен. Обычный случай — пустое множество. */
  bannedFrom(client: AppSocket): Set<string> | undefined {
    return client.data.bannedFrom;
  }

  /** Забанен ли этот сокет с этого сервера. */
  isBannedFrom(client: AppSocket, serverId: string | undefined): boolean {
    return !!serverId && this.bannedFrom(client)?.has(serverId) === true;
  }

  /**
   * Пометить сокет забаненным с сервера, не дожидаясь его переподключения:
   * права узнаются один раз, при подключении, — без этого забаненный говорил
   * бы в канал до тех пор, пока не переподключится сам.
   */
  noteBannedFrom(sock: AppSocket, serverId: string): void {
    (sock.data.bannedFrom ??= new Set()).add(serverId);
  }

  /** Все сокеты этой личности: имя и права принадлежат ей, а не устройству. */
  socketsOf(identityId: string): AppSocket[] {
    const out: AppSocket[] = [];
    for (const sock of this.serverOf()?.sockets.sockets.values() ?? []) {
      if (this.speaker(sock)?.id === identityId) out.push(sock);
    }
    return out;
  }

  /** Сокеты этого устройства — по ним отзывается доступ отозванному ключу. */
  socketsOfDevice(deviceId: string): AppSocket[] {
    const out: AppSocket[] = [];
    for (const sock of this.serverOf()?.sockets.sockets.values() ?? []) {
      if (this.speaker(sock)?.deviceId === deviceId) out.push(sock);
    }
    return out;
  }

  // ── Гости ─────────────────────────────────────────────────────────────────

  /** Впустить гостя по инвайту: он пришит к одному каналу и на всю сессию. */
  admit(client: AppSocket, pass: GuestPass): void {
    client.data.guest = true;
    client.data.guestRoom = pass.slug;
    // Право говорить приезжает подписанным в токене (см. handleInviteCreate):
    // канал закрытого сервера зовёт слушателем. Сокет запоминает это один раз
    // и на всю сессию — переспрашивать клиента не о чем.
    client.data.guestListen = pass.listen;
  }

  /**
   * Гость по инвайту: разрешён только эфир своей комнаты (join/leave/сигналинг/
   * media-update/rename) — остальные обработчики выходят на этом гарде.
   */
  isGuest(client: AppSocket): boolean {
    return client.data.guest === true;
  }

  /**
   * Слушатель: гость, позванный в канал закрытого сервера. Слышит комнату, но
   * своего медиа не отдаёт. Держится это не на кнопке в интерфейсе — она лишь
   * не врёт человеку, — а на двух настоящих заслонах: пропуск в медиасервер
   * уходит с клеймом `listen` (produce получит отказ), а в прямых звонках
   * входящий звук слушателя отбрасывают сами собеседники по флагу в presence.
   */
  isListener(client: AppSocket): boolean {
    return client.data.guestListen === true;
  }

  /** Единственная комната, куда гостю можно, — или `undefined`, если он не гость. */
  guestRoom(client: AppSocket): string | undefined {
    return this.isGuest(client) ? client.data.guestRoom : undefined;
  }

  /** Ключ отлучения: комната + устройство (а если оно не назвалось — адрес). */
  private banKey(client: AppSocket, room: string): string {
    const device = client.data.clientId || `ip:${clientIp(client.handshake)}`;
    // Разделитель — NUL, записанный escape-последовательностью: сырой байт
    // делает весь файл двоичным для grep и file. Ни в имени комнаты, ни в id
    // устройства он встретиться не может, поэтому склейка однозначна.
    return `${room}\0${device}`;
  }

  /**
   * Выгнать гостя: дверь по той же ссылке закрыта на час. Заодно подметаем
   * истёкшие — карта живёт всю жизнь процесса, а заводить таймер ради десятка
   * записей незачем.
   */
  banGuest(client: AppSocket, room: string): void {
    const now = Date.now();
    for (const [key, until] of this.guestBans) {
      if (until <= now) this.guestBans.delete(key);
    }
    this.guestBans.set(this.banKey(client, room), now + Perimeter.GUEST_BAN_MS);
  }

  /** Закрыта ли дверь этому гостю прямо сейчас. */
  guestBanned(client: AppSocket, room: string): boolean {
    const until = this.guestBans.get(this.banKey(client, room));
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.guestBans.delete(this.banKey(client, room));
    return false;
  }

  // ── Замки ─────────────────────────────────────────────────────────────────

  /**
   * Завести набор разблокировок на подключении. `??=` — чтобы восстановление
   * сессии (CSR) не сбросило уже введённые пароли.
   */
  ensureUnlocked(client: AppSocket): void {
    client.data.unlocked ??= new Set<string>();
  }

  /**
   * Разблокировки этого сокета — набор id закрытых серверов, чьи пароли он ввёл.
   * Набор заводится на подключении, а читают и пополняют его ТОЛЬКО методы
   * контура: сырой доступ расползался по обработчикам, и каждая копия сама
   * решала, что делать с его отсутствием.
   */
  unlockedOf(client: AppSocket): Set<string> | undefined {
    return client.data.unlocked;
  }

  /** Пароль сервера принят — запоминаем разблокировку на этом сокете. */
  markUnlocked(client: AppSocket, serverId: string): void {
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
  restoreUnlocked(client: AppSocket): void {
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

  /**
   * Открыт ли сервер этому сокету: открытый — всем, закрытый — только тому,
   * кто ввёл пароль. Право на сам сервер, не на его каналы (те — `canSee`).
   */
  isOpenTo(client: AppSocket, server: ServerEntry): boolean {
    if (this.isBannedFrom(client, server.id)) return false;
    return !server.passwordHash || this.unlockedOf(client)?.has(server.id) === true;
  }

  /** Видит ли сокет этот канал: закрытый сервер — только после ввода пароля. */
  canSee(client: AppSocket, channel: Channel): boolean {
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
  mayEnter(client: AppSocket, room: string): boolean {
    const channel = this.registry.channels.find((c) => c.type === 'voice' && c.slug === room);
    return !channel || this.canSee(client, channel);
  }

  /** Голосовые каналы, видимые этому сокету, — срез presence режется по ним. */
  visibleVoiceSlugs(client: AppSocket): Set<string> {
    const visible = new Set<string>();
    for (const c of this.registry.channels) {
      if (c.type === 'voice' && this.canSee(client, c)) visible.add(c.slug);
    }
    return visible;
  }

  // ── Проверка пароля ───────────────────────────────────────────────────────

  /**
   * Этот адрес уже отстрелялся неудачами по этому серверу — до конца простоя
   * даже не считаем хэш. Проверка ДО scrypt — она же и есть то, что не даёт
   * перебору забить пул: сам семафор только ограничивает ущерб.
   */
  unlockBlocked(client: AppSocket, serverId: string): boolean {
    return !!this.unlockAttempts.blockedUntil(clientIp(client.handshake), serverId);
  }

  /**
   * Подходит ли пароль. Уже проверенные не пересчитываем: авто-разблокировка
   * после реконнекта иначе была бы пересчётом scrypt на каждого вернувшегося.
   */
  async passwordFits(storedHash: string, password: string): Promise<boolean> {
    return this.unlockCache.has(this.unlockCacheId(storedHash, password))
      ? true
      : verifyServerPassword(password, storedHash);
  }

  /** Неудачная попытка: её номер и конец простоя — оба идут в лог. */
  noteUnlockFailure(client: AppSocket, serverId: string): { count: number; until: number } {
    return this.unlockAttempts.fail(clientIp(client.handshake), serverId);
  }

  /**
   * Пароль подошёл: снимаем счётчик неудач и запоминаем проверку. Кэш держим
   * ограниченным — ключей ровно столько, сколько разных паролей предъявили, а
   * вытесняем самый старый (Map хранит порядок вставки).
   */
  noteUnlockSuccess(
    client: AppSocket,
    serverId: string,
    storedHash: string,
    password: string,
  ): void {
    this.unlockAttempts.succeed(clientIp(client.handshake), serverId);
    const key = this.unlockCacheId(storedHash, password);
    if (this.unlockCache.has(key)) return;
    if (this.unlockCache.size >= Perimeter.UNLOCK_CACHE_MAX) {
      const oldest = this.unlockCache.keys().next().value;
      if (oldest) this.unlockCache.delete(oldest);
    }
    this.unlockCache.set(key, true);
  }

  /** Сервер удалён — забыть его счётчики: id могут занять заново. */
  forgetServer(serverId: string): void {
    this.unlockAttempts.forgetServer(serverId);
  }

  // Ключ вяжем к самому хэшу, а не к id сервера: id можно освободить удалением и
  // занять заново с другим паролем — тогда запись из кэша пустила бы по старому.
  private unlockCacheId(storedHash: string, password: string): string {
    return createHmac('sha256', this.unlockCacheKey)
      .update(storedHash + '\0' + password)
      .digest('base64url');
  }

  // ── Лимитер ───────────────────────────────────────────────────────────────

  /** Списываем токен; `false` → бакет пуст (флуд), обработчик молча выходит. */
  allow(client: AppSocket): boolean {
    return this.spend(client, 'rl', Perimeter.RL_CAPACITY, Perimeter.RL_REFILL_PER_SEC);
  }

  /** Бакет диагностических вех — свой, чтобы телеметрия не съедала звонок. */
  allowDiag(client: AppSocket): boolean {
    return this.spend(client, 'rlDiag', Perimeter.DIAG_CAPACITY, Perimeter.DIAG_REFILL_PER_SEC);
  }

  private spend(
    client: AppSocket,
    key: 'rl' | 'rlDiag',
    capacity: number,
    refillPerSec: number,
  ): boolean {
    const now = Date.now();
    const bucket: TokenBucket = client.data[key] ?? { tokens: capacity, ts: now };
    const elapsed = (now - bucket.ts) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.ts = now;
    client.data[key] = bucket;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

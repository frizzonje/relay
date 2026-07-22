import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server, Socket } from 'socket.io';
import { isAuthorized, issueGuestToken, verifyGuestToken } from '../auth/auth';
import { issueSfuToken, sfuSecret } from '../sfu/sfu-token';
import { Attachment, UploadsService } from '../uploads';

interface JoinPayload {
  room?: unknown;
  name?: unknown;
  clientId?: unknown;
}

interface SignalPayload {
  to?: unknown;
  sdp?: unknown;
  candidate?: unknown;
}

interface ChatPayload {
  room?: unknown;
  name?: unknown;
  text?: unknown;
  uploadId?: unknown;
}

interface ChatReactPayload {
  id?: unknown;
  emoji?: unknown;
}

type ReactionMap = Record<string, string[]>;

// Реестр направлений (api намеренно не тянет @relay/shared — типы дублируем, как и
// прочие константы здесь; формат совпадает с Channel/Server из packages/shared).
type ChannelType = 'text' | 'voice';
// Транспорт голосового канала: p2p (mesh, каждый каждому) или sfu (через
// медиасервер). Отсутствие поля = p2p — старые registry.json читаются как есть.
type VoiceMode = 'p2p' | 'sfu';
// Реестровый сервер (гильдия). Имя ServerEntry, чтобы не столкнуться с socket.io
// `Server` (WebSocketServer) выше. Формат совпадает с Server из packages/shared.
interface ServerEntry {
  id: string;
  name: string;
  emoji?: string;
  removable: boolean;
  // Хэш пароля закрытого сервера (`salt:hash` hex, scrypt). Клиенту НЕ отдаём —
  // наружу уходит только флаг `locked`. Персистится в registry.json.
  passwordHash?: string;
}
interface Channel {
  id: string;
  serverId: string;
  type: ChannelType;
  name: string;
  slug: string;
  removable: boolean;
  // Только для type: 'voice'. Меняется через channel-mode, права — как у
  // channel-delete: дефолтные каналы (removable: false) остаются на p2p.
  mode?: VoiceMode;
}
interface ServerCreatePayload {
  id?: unknown;
  name?: unknown;
  emoji?: unknown;
  password?: unknown;
}
interface ServerDeletePayload {
  id?: unknown;
}
interface ChannelCreatePayload {
  serverId?: unknown;
  type?: unknown;
  name?: unknown;
  mode?: unknown;
}
interface ChannelModePayload {
  id?: unknown;
  mode?: unknown;
}
interface ChannelDeletePayload {
  id?: unknown;
}
interface ServerUnlockPayload {
  id?: unknown;
  password?: unknown;
}
interface InviteCreatePayload {
  room?: unknown;
}
// Ответ invite-create (ack) — формат совпадает с InviteCreateResult из shared.
type InviteCreateResult =
  | { ok: true; token: string; exp: number }
  | { ok: false; error: 'not-found' | 'forbidden' };
interface SfuTokenPayload {
  room?: unknown;
  name?: unknown;
}

// Ответ sfu-token (ack) — формат совпадает с SfuTokenResult из shared.
type SfuTokenResult =
  | { ok: true; token: string; exp: number; url: string }
  | { ok: false; error: 'forbidden' | 'unavailable' | 'not-in-room' | 'not-sfu' };

// Пароль сервера храним как `salt:hash` hex (scrypt) — не обратимо, соль на
// каждый сервер своя. Проверка за постоянное время (timingSafeEqual).
function hashServerPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyServerPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface ChatMessage {
  id?: string;
  name: string;
  text: string;
  ts: number;
  attachment?: Attachment;
  system?: boolean;
  reactions?: ReactionMap;
}

const CHAT_PREFIX = 'chat:';
const HISTORY_LIMIT = 50;
const MAX_CHANNELS = 50;
const MAX_SERVERS = 20;

// Главный сервер relay — неудаляем; его id носят все каналы по умолчанию.
const MAIN_SERVER_ID = 'relay-main';

// Серверы по умолчанию — только главный. Участники добавляют свои через «+» в
// рейке. Клиент держит такой же сид (lib/constants).
const DEFAULT_SERVERS: ServerEntry[] = [{ id: MAIN_SERVER_ID, name: 'relay', removable: false }];

// Каналы по умолчанию главного сервера. Их нельзя удалить; участники лишь
// добавляют свои. Клиент держит такой же сид (lib/constants) — id/slug совпадают.
const DEFAULT_CHANNELS: Channel[] = [
  {
    id: 'text-general',
    serverId: MAIN_SERVER_ID,
    type: 'text',
    name: 'general',
    slug: 'general',
    removable: false,
  },
  {
    id: 'text-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'text',
    name: 'общий',
    slug: 'obshchii',
    removable: false,
  },
  {
    id: 'voice-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'voice',
    name: 'Общий',
    slug: 'voice-obshchii',
    removable: false,
  },
];

// Реестр серверов/каналов переживает рестарт: пишем его в JSON.
// Куда: DATA_DIR из env, иначе `<cwd>/data` — в дев/превью процесс запускается с
// `-w /app/apps/api` на bind-примонтированном репозитории, так что `apps/api/data/`
// ложится на ХОСТ и переживает пересоздание контейнера без всяких доп-монтирований.
// В проде DATA_DIR задаём явно на persistent-том uploads (см. docker-compose.yml).
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const REGISTRY_FILE = join(DATA_DIR, 'registry.json');

interface PersistedRegistry {
  servers?: ServerEntry[];
  channels?: Channel[];
}

// Читаем сохранённый реестр (или {} — файла ещё нет / битый). Диск не источник
// правды по дефолтам: их всегда подмешиваем поверх (mergeById), поэтому даже
// пустой/повреждённый файл безопасен — вернёмся к сидам.
function loadRegistry(): PersistedRegistry {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as PersistedRegistry;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Дефолты — источник правды: копируем их первыми, затем добавляем сохранённые
// записи с новыми id (созданные пользователями). Так дефолты всегда актуальны,
// а их изменение между версиями не перетирается старым файлом.
function mergeById<T extends { id: string }>(defaults: T[], saved: T[] | undefined): T[] {
  const out = defaults.map((d) => ({ ...d }));
  const seen = new Set(out.map((d) => d.id));
  for (const item of saved ?? []) {
    if (item && typeof item.id === 'string' && !seen.has(item.id)) {
      out.push(item);
      seen.add(item.id);
    }
  }
  return out;
}

// Слаг направления из произвольного ввода: строчные, пробелы → дефис, только
// буквы/цифры/дефис/подчёркивание (кириллица сохраняется), схлопываем дубли, 32.
function slugifyChannel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// Разрешённый набор реакций — дублирует REACTION_EMOJIS из @relay/shared
// (api намеренно не зависит от пакета, как и прочие константы здесь).
const REACTION_EMOJIS = new Set(['👍', '👎', '❤️', '😂', '🔥', '🫡', '🤡', '😭']);

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

  constructor(private readonly uploads: UploadsService) {
    // Поднимаем сохранённый реестр и подмешиваем дефолты. Каналы «сирот» (сервер
    // которых не существует) отбрасываем — иначе повиснут вне рейки.
    const saved = loadRegistry();
    this.servers = mergeById(DEFAULT_SERVERS, saved.servers);
    const serverIds = new Set(this.servers.map((s) => s.id));
    this.channels = mergeById(DEFAULT_CHANNELS, saved.channels).filter((c) =>
      serverIds.has(c.serverId),
    );
  }

  // Сохраняем реестр на диск атомарно (temp + rename), чтобы рестарт не потерял
  // серверы/каналы пользователей. Вызываем после каждого изменения. Диск-ошибку
  // не роняем на пользователя — только логируем: живой реестр в памяти важнее.
  private persist() {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = REGISTRY_FILE + '.tmp';
      const data = JSON.stringify({ servers: this.servers, channels: this.channels });
      writeFileSync(tmp, data);
      renameSync(tmp, REGISTRY_FILE);
    } catch (e) {
      console.error('[registry] не удалось сохранить реестр:', e);
    }
  }

  // Последние сообщения по каждому текстовому каналу — новичку показываем контекст
  private readonly chatHistory = new Map<string, ChatMessage[]>();

  // Реестр серверов (гильдий, общий на весь сервер). Раздаём на подключении и
  // рассылаем всем при создании/удалении — как серверы в Discord. Наполняется в
  // конструкторе из сохранённого файла + дефолтов; переживает рестарт.
  private readonly servers: ServerEntry[];

  // Реестр направлений (общий на весь сервер). Тоже грузится из файла в
  // конструкторе и сохраняется при каждом изменении.
  private readonly channels: Channel[];

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
  // Слаг текстового канала — произвольный ввод клиента; ограничиваем число
  // каналов, по которым держим историю, чтобы реестр не рос без предела.
  private static readonly MAX_CHAT_ROOMS = 200;

  // ── Токен-бакет на сокет ────────────────────────────────────────────────
  // Гасим флуд событий, каждое из которых иначе вызывает рассылку на весь
  // сервер (presence/чат/реестр) — O(n) обход+emit на всех. Живому человеку
  // 20 действий/с с запасом хватает (join, мут, сообщения — единицы в минуту),
  // бот на тысячах/с упрётся в пустой бакет. Заодно тормозит перебор пароля
  // закрытого сервера (server-unlock). Негоциацию (offer/answer/ice) НЕ трогаем:
  // она бывает легитимно бурстовой и релеится 1:1, дёшево.
  private static readonly RL_CAPACITY = 40;
  private static readonly RL_REFILL_PER_SEC = 20;

  // Presence меняется пачками (заход нескольких, серия media-update) —
  // коалесцируем рассылку в один emit за короткое окно вместо O(n) обхода+emit
  // на каждое событие. 80 мс незаметны на индикаторах мута/эфира.
  private static readonly PRESENCE_DEBOUNCE_MS = 80;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Списываем токен; false → бакет пуст (флуд), обработчик молча выходит.
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
    client.emit('servers', this.publicServers());
    client.emit('channels', this.channelsFor(client));
    client.emit('voice-presence', this.buildVoicePresence());
  }

  // Гость по инвайту: разрешён только эфир своей комнаты (join/leave/сигналинг/
  // media-update/rename) — остальные обработчики выходят на этом гарде.
  private isGuest(client: Socket): boolean {
    return client.data.guest === true;
  }

  // Публичная форма реестра серверов: без хэша пароля, с флагом `locked`.
  private publicServers() {
    return this.servers.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.emoji ? { emoji: s.emoji } : {}),
      removable: s.removable,
      ...(s.passwordHash ? { locked: true } : {}),
    }));
  }

  // Каналы, видимые сокету: из закрытых серверов — только если он их разблокировал.
  private channelsFor(client: Socket): Channel[] {
    const unlocked = (client.data.unlocked as Set<string>) ?? new Set<string>();
    const lockedIds = new Set(this.servers.filter((s) => s.passwordHash).map((s) => s.id));
    return this.channels.filter((c) => !lockedIds.has(c.serverId) || unlocked.has(c.serverId));
  }

  private broadcastServers() {
    this.server.emit('servers', this.publicServers());
  }

  // Каналы рассылаем персонально: у каждого свой набор (скрытые закрытые серверы).
  private broadcastChannels() {
    for (const sock of this.server.sockets.sockets.values()) {
      sock.emit('channels', this.channelsFor(sock));
    }
  }

  // ===== Реестр серверов =====

  @SubscribeMessage('server-create')
  handleServerCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ServerCreatePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    // id генерирует клиент — принимаем как есть (санитизируем длину), чтобы он мог
    // сразу открыть новый сервер и создавать в нём каналы, не дожидаясь ответа.
    const id = typeof payload?.id === 'string' ? payload.id.trim().slice(0, 64) : '';
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 32) : '';
    if (!id || !name) return;
    if (this.servers.length >= MAX_SERVERS) return;
    // Повторный create с тем же id — не плодим дубликаты (напр. ретрай сокета).
    if (this.servers.some((s) => s.id === id)) return;
    const emoji =
      typeof payload?.emoji === 'string' && payload.emoji.trim()
        ? payload.emoji.trim().slice(0, 8)
        : undefined;
    // Пароль (если задан) → сервер закрытый. Хэшируем, храним только хэш.
    const password = typeof payload?.password === 'string' ? payload.password : '';
    const passwordHash = password ? hashServerPassword(password) : undefined;

    this.servers.push({ id, name, emoji, removable: true, passwordHash });
    // Создатель знает пароль — сразу разблокируем сервер для его сокета.
    if (passwordHash) (client.data.unlocked as Set<string>)?.add(id);
    this.broadcastServers();
    // Раздаём каналы заново: у создателя новый сервер уже разблокирован.
    this.broadcastChannels();
    this.persist();
  }

  @SubscribeMessage('server-unlock')
  handleServerUnlock(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ServerUnlockPayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const password = typeof payload?.password === 'string' ? payload.password : '';
    const srv = this.servers.find((s) => s.id === id);
    if (!srv) {
      client.emit('server-unlock-result', { id, ok: false });
      return;
    }
    // Открытый сервер — доступен и так; считаем разблокировку успешной.
    if (!srv.passwordHash) {
      client.emit('server-unlock-result', { id, ok: true });
      return;
    }
    const ok = verifyServerPassword(password, srv.passwordHash);
    if (ok) {
      (client.data.unlocked as Set<string>)?.add(id);
      // Пароль подошёл — теперь этому сокету видны каналы сервера.
      client.emit('channels', this.channelsFor(client));
    }
    client.emit('server-unlock-result', { id, ok });
  }

  @SubscribeMessage('server-delete')
  handleServerDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ServerDeletePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) return;
    const idx = this.servers.findIndex((s) => s.id === id && s.removable);
    if (idx === -1) return;
    // Закрытый сервер удалить может только тот, кто ввёл пароль (разблокировал).
    const srv = this.servers[idx];
    if (srv.passwordHash && !(client.data.unlocked as Set<string>)?.has(id)) return;
    this.servers.splice(idx, 1);
    this.broadcastServers();

    // Каналы удалённого сервера уходят вместе с ним — иначе повиснут сиротами.
    const before = this.channels.length;
    for (let i = this.channels.length - 1; i >= 0; i--) {
      if (this.channels[i].serverId === id) this.channels.splice(i, 1);
    }
    if (this.channels.length !== before) this.broadcastChannels();
    this.persist();
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
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : MAIN_SERVER_ID;
    const srv = this.servers.find((s) => s.id === serverId);
    if (!srv) return;
    // В закрытый сервер канал создаёт только разблокировавший его сокет.
    if (srv.passwordHash && !(client.data.unlocked as Set<string>)?.has(serverId)) return;
    const rawName = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 32) : '';
    const slug = slugifyChannel(rawName);
    if (!slug) return;
    if (this.channels.length >= MAX_CHANNELS) return;
    // Слаг уникален глобально (комнаты голоса/чата ключуются по нему) — один слаг
    // на тип по всем серверам, повторное создание не плодит дубликаты.
    if (this.channels.some((c) => c.type === type && c.slug === slug)) return;

    const channel: Channel = {
      id: randomUUID(),
      serverId,
      type,
      name: rawName,
      slug,
      removable: true,
      // Режим — только у голосовых; p2p по умолчанию не пишем, отсутствие поля
      // и есть p2p (реестр не распухает, старые записи читаются одинаково).
      ...(type === 'voice' && payload?.mode === 'sfu' ? { mode: 'sfu' as const } : {}),
    };
    this.channels.push(channel);
    this.broadcastChannels();
    this.persist();
  }

  // Смена транспорта голосового канала. Права те же, что у channel-delete:
  // трогать можно только созданные участниками каналы (removable), дефолтные
  // остаются на p2p — они обязаны работать и без поднятого медиасервера.
  @SubscribeMessage('channel-mode')
  handleChannelMode(@ConnectedSocket() client: Socket, @MessageBody() payload: ChannelModePayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const mode: VoiceMode | null =
      payload?.mode === 'sfu' ? 'sfu' : payload?.mode === 'p2p' ? 'p2p' : null;
    if (!id || !mode) return;
    const channel = this.channels.find((c) => c.id === id && c.removable && c.type === 'voice');
    if (!channel) return;
    const next = mode === 'sfu' ? 'sfu' : undefined;
    if (channel.mode === next) return;
    if (next) channel.mode = next;
    else delete channel.mode;
    this.broadcastChannels();
    // Отдельно — тем, кто прямо сейчас в этом канале: им нужно переехать на
    // другой транспорт. Реестра каналов для этого мало — гость по инвайту его
    // не получает, а переезжать обязан вместе со всеми.
    this.server.to(channel.slug).emit('voice-mode', { room: channel.slug, mode });
    this.persist();
  }

  @SubscribeMessage('channel-delete')
  handleChannelDelete(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChannelDeletePayload,
  ) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) return;
    const idx = this.channels.findIndex((c) => c.id === id && c.removable);
    if (idx === -1) return;
    this.channels.splice(idx, 1);
    this.broadcastChannels();
    this.persist();
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
    const slug = typeof payload?.room === 'string' ? payload.room.trim().slice(0, 32) : '';
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
  handleSfuToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SfuTokenPayload,
  ): SfuTokenResult {
    if (!this.allow(client)) return { ok: false, error: 'forbidden' };
    const url = (process.env.SFU_URL ?? '').trim();
    if (!url || !sfuSecret()) return { ok: false, error: 'unavailable' };
    // Комната приходит в запросе: клиенту нужно знать транспорт ДО `join`,
    // иначе он пропустит ответный `peers`. Секрета в ней нет — войти в любой
    // голосовой канал он и так вправе, а `peerId` по-прежнему берётся из
    // сокета, так что назваться чужим id нельзя.
    const asked = typeof payload?.room === 'string' ? payload.room.trim().slice(0, 32) : '';
    const room = asked || (typeof client.data.room === 'string' ? client.data.room : '');
    if (!room) return { ok: false, error: 'not-in-room' };
    // Гость «пришит» к своему каналу — чужую комнату не спросит.
    if (this.isGuest(client) && room !== client.data.guestRoom) {
      return { ok: false, error: 'forbidden' };
    }
    // Режим канала — не декорация: пропуск выдаём только тем каналам, что
    // помечены sfu. Дефолтные (всегда p2p) отсюда уходят ни с чем.
    const channel = this.channels.find((c) => c.type === 'voice' && c.slug === room);
    if (!channel || channel.mode !== 'sfu') return { ok: false, error: 'not-sfu' };
    // Имя берём из запроса: пропуск спрашивают ДО `join`, и client.data.name в
    // этот момент ещё пуст (заполнен он только при пере-выдаче во время звонка).
    // Лимит — тот же, что у `join`.
    const askedName = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : '';
    const name =
      askedName || (typeof client.data.name === 'string' ? client.data.name : '');
    const { token, exp } = issueSfuToken({ room, peerId: client.id, name });
    return { ok: true, token, exp, url };
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: Socket, @MessageBody() payload: JoinPayload) {
    if (!this.allow(client)) return;
    const room = typeof payload?.room === 'string' ? payload.room.trim().slice(0, 32) : '';
    if (!room) return;
    // Гость «пришит» к каналу из своего токена — другие комнаты недоступны.
    if (this.isGuest(client) && room !== client.data.guestRoom) return;
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : undefined;
    const clientId =
      typeof payload?.clientId === 'string' ? payload.clientId.trim().slice(0, 64) : '';

    // Повторный join без leave (например, после обрыва) — сначала выходим из старой комнаты
    this.leaveRoom(client);

    // Выгоняем «призрака»: прошлый сокет того же устройства, ещё висящий в этой
    // комнате (перезагрузка страницы = новый id, старый уйдёт лишь по грейсу).
    // Так участника не двоит у остальных. Делаем ДО сбора списка пиров.
    if (clientId) this.evictGhost(clientId, client.id);
    client.data.clientId = clientId || undefined;

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
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : '';
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
    const slug = typeof payload?.room === 'string' ? payload.room.trim().slice(0, 32) : '';
    if (!slug) return;
    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 20) : '';

    // Уже сидел в другом текстовом канале — сначала выходим
    this.leaveChatRoom(client);

    const room = CHAT_PREFIX + slug;
    client.join(room);
    client.data.chatRoom = room;
    client.data.chatName = name || 'Аноним';

    // Новичку — история канала.
    client.emit('chat-history', this.chatHistory.get(room) ?? []);
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
    const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, 500) : '';

    // Вложение берём из доверенного реестра по id (клиент не задаёт url/mime сам)
    const uploadId = typeof payload?.uploadId === 'string' ? payload.uploadId : undefined;
    const attachment = this.uploads.get(uploadId);

    // Пустое сообщение без вложения — игнорируем
    if (!text && !attachment) return;

    const msg: ChatMessage = {
      id: randomUUID(),
      name: (client.data.chatName as string) || 'Аноним',
      text,
      ts: Date.now(),
      ...(attachment ? { attachment } : {}),
    };

    const history = this.chatHistory.get(room) ?? [];
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history.shift();
    this.rememberHistory(room, history);

    this.server.to(room).emit('chat', msg);
  }

  // Тогл реакции на сообщение: тег добавляется/снимается из набора по эмодзи.
  // Состояние храним в истории канала и рассылаем всем читающим — как и сами сообщения.
  @SubscribeMessage('chat-react')
  handleChatReact(@ConnectedSocket() client: Socket, @MessageBody() payload: ChatReactPayload) {
    if (!this.allow(client) || this.isGuest(client)) return;
    const room = client.data.chatRoom as string | undefined;
    if (!room) return;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const emoji = typeof payload?.emoji === 'string' ? payload.emoji : '';
    if (!id || !REACTION_EMOJIS.has(emoji)) return;

    const msg = this.chatHistory.get(room)?.find((m) => m.id === id);
    if (!msg) return;

    const name = (client.data.chatName as string) || 'Аноним';
    const reactions: ReactionMap = msg.reactions ?? (msg.reactions = {});
    const list = reactions[emoji] ?? [];
    if (list.includes(name)) {
      const next = list.filter((n) => n !== name);
      if (next.length) reactions[emoji] = next;
      else delete reactions[emoji];
    } else {
      reactions[emoji] = [...list, name];
    }

    this.server.to(room).emit('chat-reaction', { id, reactions: msg.reactions });
  }

  // Кладём историю канала, удерживая число каналов в пределах MAX_CHAT_ROOMS: слаг
  // задаёт клиент, поэтому самые старые каналы вытесняем (кроме текущего).
  private rememberHistory(room: string, history: ChatMessage[]) {
    this.chatHistory.set(room, history);
    if (this.chatHistory.size <= SignalingGateway.MAX_CHAT_ROOMS) return;
    for (const key of this.chatHistory.keys()) {
      if (key === room) continue;
      this.chatHistory.delete(key);
      if (this.chatHistory.size <= SignalingGateway.MAX_CHAT_ROOMS) break;
    }
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

  private leaveRoom(client: Socket) {
    const room = client.data.room as string | undefined;
    if (room) {
      client.to(room).emit('peer-left', { id: client.id });
      client.leave(room);
      client.data.room = undefined;
      const clientId = client.data.clientId as string | undefined;
      if (clientId && this.voiceMembers.get(clientId)?.id === client.id) {
        this.voiceMembers.delete(clientId);
      }
      this.broadcastVoicePresence();
    }
  }

  // Кто сейчас в каких голосовых каналах —
  // { имя_канала: [{ id, name, micOn, deafened, guest? }] }
  private buildVoicePresence(): Record<
    string,
    { id: string; name: string; micOn: boolean; deafened: boolean; guest?: boolean }[]
  > {
    const presence: Record<
      string,
      { id: string; name: string; micOn: boolean; deafened: boolean; guest?: boolean }[]
    > = {};
    for (const [id, sock] of this.server.sockets.sockets) {
      const room = sock.data.room as string | undefined;
      if (!room) continue;
      (presence[room] ??= []).push({
        id,
        name: (sock.data.name as string) || 'Аноним',
        micOn: sock.data.micOn !== false,
        deafened: sock.data.deafened === true,
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
          sock.emit('voice-presence', presence);
        }
      }
    }, SignalingGateway.PRESENCE_DEBOUNCE_MS);
    this.presenceTimer.unref?.();
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

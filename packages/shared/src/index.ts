/**
 * Единый контракт фронт↔бэк relay.
 *
 * Источник правды для socket-событий, REST DTO, типов вложений/ICE и общих
 * констант. Импортируется и web (Next), и api (Nest). Намеренно не зависит от
 * lib.dom: вместо RTCSessionDescriptionInit/RTCIceCandidateInit используем
 * структурно-совместимые типы, чтобы пакет компилировался и на стороне Node.
 */

// ─────────────────────────────────────────────────────────────────────────
// Общее
// ─────────────────────────────────────────────────────────────────────────

export const APP_NAME = 'relay';

// Пропуск-кука и проверка HMAC-токена (подпись завязана на SITE_PASSWORD).
// Единый формат для Next (middleware) и Nest — см. ./auth.
export { AUTH_COOKIE, TOKEN_TTL_MS, issueToken, verifyToken, parseCookies } from './auth';

// Гостевой инвайт-токен: подписанная ссылка на конкретный войс-канал (24 часа),
// без хранения на сервере. Гость по ней попадает только в этот эфир.
export {
  GUEST_TOKEN_TTL_MS,
  issueGuestToken,
  verifyGuestToken,
  type GuestTokenPayload,
} from './auth';

/** Лимит размера загружаемого файла — 25 МБ. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Сколько последних сообщений канала сервер хранит и отдаёт новичку. */
export const CHAT_HISTORY_LIMIT = 50;

/** Префикс socket.io-комнаты текстового канала. */
export const CHAT_PREFIX = 'chat:';

/** Максимум каналов в реестре (сервер отбрасывает создание сверх лимита). */
export const MAX_CHANNELS = 50;

/** Серверные ограничения на длину полей (усечение на бэке). */
export const LIMITS = {
  /** Слаг комнаты (голосовой/текстовой). */
  room: 32,
  /** Отображаемое имя участника. */
  name: 20,
  /** Длина текста сообщения. */
  chatText: 500,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Вложения
// ─────────────────────────────────────────────────────────────────────────

/** Как клиент рисует вложение: картинка инлайн, mp3 — плеером, прочее — карточкой. */
export type AttachmentKind = 'image' | 'audio' | 'file';

export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
}

// ─────────────────────────────────────────────────────────────────────────
// Чат
// ─────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  /** Стабильный id сообщения — нужен для реакций. Системные могут быть без него. */
  id?: string;
  /** Имя автора (для системных — служебное). */
  name?: string;
  text: string;
  ts: number;
  attachment?: Attachment;
  /** Системное сообщение (вход/выход) — рисуется иначе. */
  system?: boolean;
  /** Реакции на сообщение: эмодзи → теги тех, кто его поставил. */
  reactions?: ReactionMap;
}

/** Реакции сообщения: эмодзи → список тегов. Пустые ключи сервер удаляет. */
export type ReactionMap = Record<string, string[]>;

/**
 * Разрешённый набор реакций. Сервер валидирует входящий эмодзи по этому списку,
 * клиент рисует тот же набор в пикере — один источник правды.
 */
export const REACTION_EMOJIS = ['👍', '👎', '❤️', '😂', '🔥', '🫡', '🤡', '😭'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

// ─────────────────────────────────────────────────────────────────────────
// Каналы (реестр направлений)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сервер (гильдия) — верхний уровень над каналами: своя иконка в левой рейке,
 * внутри свои текстовые и голосовые каналы. Как и каналы, реестр серверов общий:
 * сервер раздаёт его на подключении и рассылает всем при изменениях, так что
 * созданный сервер сразу видят все участники. Главный (relay) неудаляем.
 */
export interface Server {
  /** Стабильный id (генерирует создатель; нужен для группировки каналов). */
  id: string;
  /** Отображаемое имя сервера. */
  name: string;
  /** Эмодзи-иконка; если пусто — клиент рисует инициалы на градиенте. */
  emoji?: string;
  /** Главный сервер удалить нельзя; созданные участниками — можно. */
  removable: boolean;
  /**
   * Сервер под паролем: виден всем в рейке (с замком), но его каналы приходят
   * только после ввода пароля (server-unlock). Сам пароль/хэш клиенту не шлём —
   * только этот флаг.
   */
  locked?: boolean;
}

export interface ServerCreatePayload {
  /** id генерирует клиент (crypto.randomUUID) — чтобы сразу открыть новый сервер. */
  id: string;
  name: string;
  emoji?: string;
  /** Необязательный пароль: если задан — сервер становится закрытым (locked). */
  password?: string;
}

export interface ServerDeletePayload {
  id: string;
}

/** Ввод пароля для доступа к закрытому серверу. */
export interface ServerUnlockPayload {
  id: string;
  password: string;
}

/** Ответ сервера на попытку разблокировки: подошёл пароль или нет. */
export interface ServerUnlockResult {
  id: string;
  ok: boolean;
}

/** Тип канала: текстовый (лента сообщений) или голосовой (эфир). */
export type ChannelType = 'text' | 'voice';

/**
 * Транспорт голосового канала:
 * - `p2p` — mesh, все шлют медиа друг другу напрямую. Ниже задержка, ноль
 *   нагрузки на сервер, но аплинк растёт линейно — потолок ~3 человека с видео;
 * - `sfu` — через медиасервер: каждый отдаёт свой поток один раз. Требует
 *   поднятого сервиса `sfu` (см. `ConfigResponse.sfu.available`).
 *
 * Отсутствие поля = `p2p`: старые записи реестра читаются без миграции.
 */
export type VoiceMode = 'p2p' | 'sfu';

/**
 * Направление в реестре сервера. Сервер держит список в памяти, раздаёт его
 * каждому подключившемуся и рассылает всем при изменениях — так созданные каналы
 * видят сразу все, даже пустыми (как в Discord).
 */
export interface Channel {
  /** Стабильный id (нужен для удаления и React-ключей). */
  id: string;
  /** id сервера-владельца — канал показывается только в его сайдбаре. */
  serverId: string;
  type: ChannelType;
  /** Отображаемое имя, напр. «general». */
  name: string;
  /** Слаг комнаты: текст → chat-room, голос → voice-room. Уникален глобально. */
  slug: string;
  /** Каналы по умолчанию удалять нельзя; созданные участниками — можно. */
  removable: boolean;
  /**
   * Транспорт голосового канала. Только для `type: 'voice'`; отсутствует = p2p.
   * Менять можно лишь у `removable`-каналов — там же, где разрешено удаление.
   */
  mode?: VoiceMode;
}

export interface ChannelCreatePayload {
  serverId: string;
  type: ChannelType;
  name: string;
  /** Режим для голосового канала; у текстовых игнорируется. */
  mode?: VoiceMode;
}

export interface ChannelDeletePayload {
  id: string;
}

/** Смена транспорта голосового канала (только `removable`). */
export interface ChannelModePayload {
  id: string;
  mode: VoiceMode;
}

// ─────────────────────────────────────────────────────────────────────────
// ICE / конфиг
// ─────────────────────────────────────────────────────────────────────────

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ConfigResponse {
  iceServers: IceServer[];
  /**
   * Медиасервер (профиль `sfu` в compose). Поднят не у всех: self-host без него
   * обязан работать полностью на p2p, поэтому фронт спрашивает заранее — чтобы
   * не предлагать режим, которого нет, и знать, что делать при фолбэке.
   */
  sfu?: { available: boolean };
}

// ─────────────────────────────────────────────────────────────────────────
// WebRTC-сигналинг (структурно совместимо с DOM-типами)
// ─────────────────────────────────────────────────────────────────────────

/** Структурно совместимо с RTCSessionDescriptionInit. */
export interface SdpPayload {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** Структурно совместимо с RTCIceCandidateInit. */
export interface IceCandidatePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Участник голосового канала. */
export interface VoicePeer {
  id: string;
  name?: string;
  /** Микрофон включён; undefined — состояние ещё не приходило (считаем включённым). */
  micOn?: boolean;
  /** Заглушил себе звук (deafen) — не слышит канал; микрофон при этом тоже выключен. */
  deafened?: boolean;
  /** Гость по инвайт-ссылке (доступ только к этому каналу). */
  guest?: boolean;
}

/** Состав всех голосовых каналов: { имя_канала: участники }. */
export type VoicePresence = Record<string, VoicePeer[]>;

// ─────────────────────────────────────────────────────────────────────────
// Socket-события: client → server
// ─────────────────────────────────────────────────────────────────────────

export interface JoinPayload {
  room: string;
  name?: string;
  // Стабильный id устройства (localStorage). По нему сервер выгоняет «призрака» —
  // прошлый сокет того же клиента, ещё висящий в комнате после перезагрузки.
  clientId?: string;
}

export interface OfferPayload {
  to: string;
  sdp: SdpPayload;
}

export interface AnswerPayload {
  to: string;
  sdp: SdpPayload;
}

export interface IcePayload {
  to: string;
  candidate: IceCandidatePayload;
}

export interface ChatJoinPayload {
  room: string;
  name?: string;
}

export interface ChatMessagePayload {
  text?: string;
  uploadId?: string;
}

/** Тогл реакции: повторная отправка того же эмодзи снимает её. */
export interface ChatReactPayload {
  id: string;
  emoji: string;
}

export interface MediaUpdatePayload {
  camOn: boolean;
  screenOn: boolean;
  /** Микрофон включён (индикатор мута в составе канала). */
  micOn?: boolean;
  /** Звук заглушён кнопкой (deafen) — микрофон при этом тоже выключается. */
  deafened?: boolean;
}

export interface MediaUpdateRelay {
  from: string;
  camOn: boolean;
  screenOn: boolean;
  micOn?: boolean;
  deafened?: boolean;
}

/** Смена тега на лету — сервер обновляет presence/ростер и оповещает комнату. */
export interface RenamePayload {
  name: string;
}

/** Оповещение голосовой комнаты: участник сменил тег. */
export interface PeerRenamedRelay {
  id: string;
  name: string;
}

/** Запрос инвайт-ссылки на войс-канал (room — его слаг). */
export interface InviteCreatePayload {
  room: string;
}

/** Ответ на invite-create (ack): токен для ссылки `/invite/<token>` или отказ. */
export type InviteCreateResult =
  | { ok: true; token: string; exp: number }
  | { ok: false; error: 'not-found' | 'forbidden' };

/** Карта событий, отправляемых клиентом серверу. */
export interface ClientToServerEvents {
  join: (payload: JoinPayload) => void;
  leave: () => void;
  offer: (payload: OfferPayload) => void;
  answer: (payload: AnswerPayload) => void;
  'ice-candidate': (payload: IcePayload) => void;
  'chat-join': (payload: ChatJoinPayload) => void;
  'chat-leave': () => void;
  'chat-message': (payload: ChatMessagePayload) => void;
  'chat-react': (payload: ChatReactPayload) => void;
  'media-update': (payload: MediaUpdatePayload) => void;
  rename: (payload: RenamePayload) => void;
  'server-create': (payload: ServerCreatePayload) => void;
  'server-delete': (payload: ServerDeletePayload) => void;
  'server-unlock': (payload: ServerUnlockPayload) => void;
  'channel-create': (payload: ChannelCreatePayload) => void;
  'channel-delete': (payload: ChannelDeletePayload) => void;
  'channel-mode': (payload: ChannelModePayload) => void;
  'invite-create': (payload: InviteCreatePayload, cb: (res: InviteCreateResult) => void) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Socket-события: server → client
// ─────────────────────────────────────────────────────────────────────────

export interface PeerJoinedPayload {
  id: string;
  name?: string;
  /** Гость по инвайт-ссылке. */
  guest?: boolean;
}

export interface PeerLeftPayload {
  id: string;
}

export interface OfferRelay {
  from: string;
  name?: string;
  sdp: SdpPayload;
}

export interface AnswerRelay {
  from: string;
  sdp: SdpPayload;
}

export interface IceRelay {
  from: string;
  candidate: IceCandidatePayload;
}

/** Карта событий, отправляемых сервером клиенту. */
export interface ServerToClientEvents {
  peers: (peers: VoicePeer[]) => void;
  'peer-joined': (payload: PeerJoinedPayload) => void;
  'peer-left': (payload: PeerLeftPayload) => void;
  offer: (payload: OfferRelay) => void;
  answer: (payload: AnswerRelay) => void;
  'ice-candidate': (payload: IceRelay) => void;
  'voice-presence': (presence: VoicePresence) => void;
  chat: (message: ChatMessage) => void;
  'chat-history': (messages: ChatMessage[]) => void;
  'chat-roster': (names: string[]) => void;
  'chat-reaction': (payload: ChatReactionRelay) => void;
  'media-update': (payload: MediaUpdateRelay) => void;
  /** Участник голосовой комнаты сменил тег (обновить подпись плитки). */
  'peer-renamed': (payload: PeerRenamedRelay) => void;
  /** Полный реестр серверов — на подключении и при каждом изменении. */
  servers: (servers: Server[]) => void;
  /** Результат попытки разблокировки закрытого сервера паролем. */
  'server-unlock-result': (result: ServerUnlockResult) => void;
  /** Полный реестр каналов — на подключении и при каждом изменении. */
  channels: (channels: Channel[]) => void;
}

/** Обновлённый набор реакций конкретного сообщения — рассылается всем в канале. */
export interface ChatReactionRelay {
  id: string;
  reactions: ReactionMap;
}

// ─────────────────────────────────────────────────────────────────────────
// REST DTO
// ─────────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  ok: true;
}

/** Ответ POST /api/upload: метаданные вложения + id в доверенном реестре. */
export type UploadResponse = Attachment & { id: string };

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
  /** Спойлер: клиент рисует вложение заблюренным до клика («показать»). */
  spoiler?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Чат
// ─────────────────────────────────────────────────────────────────────────

/**
 * Снимок сообщения, на которое отвечают (reply). Храним копией, а не ссылкой:
 * исходное могут отредактировать или удалить, а цитата в ответе должна остаться
 * той, что видел автор в момент ответа. `text` — уже усечённая выжимка.
 */
export interface ReplyRef {
  id: string;
  name: string;
  text: string;
}

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
  /** Цитата сообщения, на которое это — ответ (снимок на момент ответа). */
  replyTo?: ReplyRef;
  /** Метка последнего редактирования (проставляется на сервере при chat-edit). */
  editedTs?: number;
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
  /**
   * Запись под управлением ЭТОГО клиента: её создало это устройство (clientId
   * из handshake) либо у неё нет владельца вовсе (создана до правила владения).
   * Ровно то условие, которое проверяет сервер, — клиент рисует по нему кнопки
   * и не предлагает действий, которые получат отказ.
   *
   * Считается на сервере для каждого сокета отдельно; сам clientId владельца
   * наружу не уходит никогда — иначе выдать себя за него стоило бы одной
   * копипасты (audit B2).
   */
  mine?: boolean;
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

/**
 * Итог удаления сервера (ack), по образцу ChannelDeleteResult:
 * - `not-owner` — сервер создан другим устройством (владелец — по clientId из
 *   handshake, см. `Server.mine`);
 * - `occupied` — в голосовых каналах сервера кто-то есть; `occupants` — сколько
 *   именно. Удаление сервера уносит его каналы, а выбрасывать людей из
 *   разговора нельзя и здесь — правило то же, что у `channel-delete`;
 * - `forbidden` — сервер по умолчанию либо закрытый без введённого пароля.
 */
export type ServerDeleteResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not-found' | 'forbidden' | 'not-owner' | 'occupied';
      occupants?: number;
    };

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
  /**
   * Каналы по умолчанию неприкосновенны: их нельзя ни удалить, ни
   * переименовать, ни перевести на другой транспорт. Созданные участниками —
   * можно всё это. Набор главного сервера состоит только из первых, поэтому и
   * создавать в нём новые каналы нельзя (см. `ChannelCreatePayload`).
   */
  removable: boolean;
  /**
   * Транспорт голосового канала. Только для `type: 'voice'`; отсутствует = p2p.
   * Менять можно лишь у `removable`-каналов — там же, где разрешено удаление.
   */
  mode?: VoiceMode;
  /**
   * Канал под управлением ЭТОГО клиента — переименовать, удалить и сменить
   * транспорт может только он. Считается на сервере под каждый сокет, как у
   * `Server.mine`; id владельца наружу не уходит.
   */
  mine?: boolean;
  /**
   * Время последнего сообщения текстового канала — снимок активности для
   * «непрочитано». Только для `type: 'text'` и только если в канале вообще
   * что-то писали. Клиент сравнивает его с сохранённой отметкой чтения, поэтому
   * точки горят сразу после загрузки страницы, а не только по живым пингам
   * `chat-activity` (см. web/stores/unread).
   */
  lastTs?: number;
}

/**
 * Создание канала. Только в своих серверах: набор главного (`relay`) фиксирован
 * — там ровно три канала по умолчанию, и сервер отклоняет попытку добавить
 * четвёртый, кто бы её ни прислал.
 */
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

/**
 * Итог удаления (ack). Отказ — не «ничего не произошло»: интерфейс обязан
 * сказать, почему канал остался на месте.
 * - `occupied` — в голосовом канале кто-то есть; `occupants` — сколько именно;
 * - `not-owner` — канал создан другим устройством;
 * - `forbidden` — канал по умолчанию (или сервер под паролем не разблокирован).
 */
export type ChannelDeleteResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'occupied' | 'not-owner'; occupants?: number };

/**
 * Переименование канала. Меняется только отображаемое имя — `slug` остаётся
 * прежним: по нему ключуются комната эфира, история чата и «непрочитано», так
 * что смена имени не рвёт ни живой звонок, ни переписку.
 */
export interface ChannelRenamePayload {
  id: string;
  name: string;
}

export type ChannelRenameResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'bad-name' | 'not-owner' };

/** Смена транспорта голосового канала (только своего `removable`). */
export interface ChannelModePayload {
  id: string;
  mode: VoiceMode;
}

export interface ChannelStatsPayload {
  id: string;
}

/**
 * Живой срез канала для подтверждения удаления: сколько человек в нём прямо
 * сейчас и сколько сообщений хранит сервер. Спрашиваем в момент открытия
 * диалога — рассылать это всем постоянно незачем.
 */
export type ChannelStatsResult = { ok: true; occupants: number; messages: number } | { ok: false };

export interface ServerStatsPayload {
  id: string;
}

/**
 * Живой срез сервера для подтверждения удаления: сколько каналов и сколько
 * сообщений во всех его текстовых каналах исчезнет вместе с ним и сколько
 * человек прямо сейчас сидит в его эфирах (пока сидят — сервер не удаляется,
 * как и занятый канал).
 */
export type ServerStatsResult =
  | { ok: true; channels: number; messages: number; occupants: number }
  | { ok: false };

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
// Состояние машины (GET /api/metrics)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Нагрузка на железо, где стоит инсталляция: цифры хоста, а не контейнера
 * (`/proc` в docker общий с хостом, диск меряется по тому с данными relay).
 *
 * За гейтом пропуска: сколько на сервере памяти и насколько забит диск —
 * не то, что раздают анониму. `null` означает «здесь померить не вышло»
 * (не Linux, нет прав на путь) — рисовать это надо прочерком, а не нулём.
 */
export interface MetricsResponse {
  cpu: {
    /** Ядер у хоста. */
    cores: number;
    /** Занятость 0..1 за окно замера; `null` — первая выборка ещё не готова. */
    usage: number | null;
    /** Средняя нагрузка за минуту (Linux); `null` — недоступна. */
    load1: number | null;
  };
  /** Байты. `used` = total − MemAvailable, то есть «занято по-настоящему». */
  mem: { total: number; used: number };
  /**
   * Том с данными relay (загрузки + реестр). `used` считается как
   * total − доступно_непривилегированному, то есть совпадает с тем, что
   * показывает `df` в столбце Use%. `null` — файловую систему не опросить.
   */
  disk: { total: number; used: number } | null;
  /** Аптайм хоста в секундах. */
  uptimeSec: number;
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
  /**
   * Гость-слушатель: позван в канал закрытого сервера, слышит комнату, но
   * своего медиа не отдаёт (пароля, на котором держится этот канал, ссылка не
   * раздаёт). Микрофона у него нет вовсе, поэтому `micOn` у такого участника
   * всегда false — но «выключил микрофон» и «не вправе говорить» это разные
   * вещи, и в интерфейсе они подписаны по-разному.
   */
  listen?: boolean;
  /**
   * Каким транспортом участник реально звонит. Сообщает он сам в `join`:
   * сервер этого знать не может — решение принимает клиент, и оно может
   * разойтись с режимом канала (медиасервер не поднялся, старый клиент его
   * вовсе не умеет). Поле отсутствует у клиентов, которые о нём не знают, —
   * такие всегда в p2p. Разъехавшись в транспортах, участники друг друга не
   * слышат вообще, поэтому это не декорация, а то, что видно в интерфейсе.
   */
  transport?: VoiceTransportKind;
}

/** Транспорт звонка: напрямую между участниками или через медиасервер. */
export type VoiceTransportKind = 'p2p' | 'sfu';

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
  //
  // Место этого id — `auth`-поле handshake (см. Server.mine): там он объявляется
  // один раз и оттуда же решает владение записями реестра. Здесь он оставлен
  // ради клиентов, которые в handshake молчат, — им иначе нечем опознать свою
  // же прошлую вкладку. Названное в handshake сильнее: перебить его join'ом
  // нельзя.
  clientId?: string;
  /**
   * Транспорт, которым мы фактически звоним. Сервер раздаёт его остальным в
   * presence: разъехавшись, участники друг друга не слышат, и знать об этом
   * должны все. Не указан — считается p2p.
   */
  transport?: VoiceTransportKind;
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
  /** id сообщения, на которое отвечаем — сервер вложит его снимок в replyTo. */
  replyTo?: string;
  /** Пометить вложение спойлером (сервер выставит attachment.spoiler). */
  spoiler?: boolean;
}

/** Правка своего сообщения — по id, новый текст. Автор проверяется по тегу. */
export interface ChatEditPayload {
  id: string;
  text: string;
}

/** Удаление своего сообщения — по id. Автор проверяется по тегу. */
export interface ChatDeletePayload {
  id: string;
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

/**
 * Ответ на invite-create (ack): токен для ссылки `/invite/<token>` или отказ.
 * `listen` — гость по этой ссылке сможет только слушать (канал закрытого
 * сервера). Решает это сервер, не клиент: приглашающий раздаёт не больше того,
 * что имеет сам, а пароля он не отдавал.
 */
export type InviteCreateResult =
  | { ok: true; token: string; exp: number; listen: boolean }
  | { ok: false; error: 'not-found' | 'forbidden' };

/** Кого выгоняем из эфира: socket-id гостя (он же id его плитки и presence). */
export interface GuestKickPayload {
  id: string;
}

/** Ответ на guest-kick (ack): not-found — гость уже вышел сам. */
export type GuestKickResult = { ok: true } | { ok: false; error: 'not-found' | 'forbidden' };

/**
 * Запрос пропуска. Комнату спрашивают ДО `join` — иначе транспорт не выбрать.
 * Имя тоже едет здесь: `join` в этот момент ещё не случился, и без него сервер
 * вписал бы в пропуск пустое имя — плитки у остальных звались бы «Участник».
 */
export interface SfuTokenPayload {
  room: string;
  name?: string;
}

/**
 * Диагностическая веха звонка (выбор транспорта, фолбэк в p2p, обрыв) — сервер
 * пишет её в свой лог. Клиентская консоль умирает вместе с вкладкой, а «телефон
 * в канале, но не слышно» разбирают назавтра — по серверному логу.
 */
export interface VoiceDiagPayload {
  event: string;
  detail?: string;
}

/**
 * Ответ на sfu-token (ack): короткоживущий пропуск в медиасервер и его адрес.
 * `peerId` внутри токена сервер берёт из сокета, подделать его нельзя.
 */
export type SfuTokenResult =
  | { ok: true; token: string; exp: number; url: string }
  | { ok: false; error: 'forbidden' | 'unavailable' | 'not-in-room' | 'not-sfu' };

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
  'chat-edit': (payload: ChatEditPayload) => void;
  'chat-delete': (payload: ChatDeletePayload) => void;
  /** «Печатает…» — клиент шлёт с троттлингом, серверу тело не нужно. */
  'chat-typing': () => void;
  'chat-react': (payload: ChatReactPayload) => void;
  'media-update': (payload: MediaUpdatePayload) => void;
  rename: (payload: RenamePayload) => void;
  'server-create': (payload: ServerCreatePayload) => void;
  'server-delete': (payload: ServerDeletePayload, cb: (res: ServerDeleteResult) => void) => void;
  'server-stats': (payload: ServerStatsPayload, cb: (res: ServerStatsResult) => void) => void;
  'server-unlock': (payload: ServerUnlockPayload) => void;
  'channel-create': (payload: ChannelCreatePayload) => void;
  'channel-delete': (payload: ChannelDeletePayload, cb: (res: ChannelDeleteResult) => void) => void;
  'channel-rename': (payload: ChannelRenamePayload, cb: (res: ChannelRenameResult) => void) => void;
  'channel-stats': (payload: ChannelStatsPayload, cb: (res: ChannelStatsResult) => void) => void;
  'channel-mode': (payload: ChannelModePayload) => void;
  'invite-create': (payload: InviteCreatePayload, cb: (res: InviteCreateResult) => void) => void;
  /** Выгнать гостя из эфира — вправе любой НЕ-гость, кому виден этот канал. */
  'guest-kick': (payload: GuestKickPayload, cb: (res: GuestKickResult) => void) => void;
  'sfu-token': (payload: SfuTokenPayload, cb: (res: SfuTokenResult) => void) => void;
  'voice-diag': (payload: VoiceDiagPayload) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Socket-события: server → client
// ─────────────────────────────────────────────────────────────────────────

export interface PeerJoinedPayload {
  id: string;
  name?: string;
  /** Гость по инвайт-ссылке. */
  guest?: boolean;
  /** Гость-слушатель: своего медиа не отдаёт (см. VoicePeer.listen). */
  listen?: boolean;
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
  /** Сообщение отредактировали — обновить текст и показать пометку «изменено». */
  'chat-edited': (payload: ChatEditRelay) => void;
  /** Сообщение удалили — убрать из ленты по id. */
  'chat-deleted': (payload: ChatDeleteRelay) => void;
  /** Кто-то печатает в открытом канале (кроме тебя) — показать индикатор. */
  'chat-typing': (payload: ChatTypingRelay) => void;
  /**
   * Лёгкий пинг активности любого текстового канала (только слаг и время, без
   * содержимого) — всем клиентам. По нему сайдбар зажигает «непрочитано» на
   * каналах, которые сейчас не открыты. Контент за это не утекает.
   */
  'chat-activity': (payload: ChatActivityRelay) => void;
  /**
   * Текстовый канал закрылся под тобой (его удалили). Сервер уже выписал тебя
   * из комнаты — клиенту остаётся закрыть ленту, чтобы не осталось канала-призрака.
   */
  'chat-closed': (payload: ChatClosedRelay) => void;
  'media-update': (payload: MediaUpdateRelay) => void;
  /** Участник голосовой комнаты сменил тег (обновить подпись плитки). */
  'peer-renamed': (payload: PeerRenamedRelay) => void;
  /** Полный реестр серверов — на подключении и при каждом изменении. */
  servers: (servers: Server[]) => void;
  /** Результат попытки разблокировки закрытого сервера паролем. */
  'server-unlock-result': (result: ServerUnlockResult) => void;
  /** Полный реестр каналов — на подключении и при каждом изменении. */
  channels: (channels: Channel[]) => void;
  /**
   * Голосовому каналу сменили транспорт прямо во время звонка — тем, кто в нём
   * сидит, пора переехать. Летит В КОМНАТУ, а не только владельцам реестра:
   * гость по инвайту `channels` не получает вовсе, а переезжать ему нужно
   * вместе со всеми, иначе он останется на другом транспорте и без звука.
   */
  'voice-mode': (payload: VoiceModeRelay) => void;
  /**
   * Гостя выгнали из эфира (или он пытается вернуться, пока не вышла пауза).
   * Летит только ему самому: остальные видят обычный уход участника.
   */
  kicked: (payload: KickedRelay) => void;
}

/** Гостя выгнали из этой комнаты. */
export interface KickedRelay {
  room: string;
}

/** Голосовому каналу сменили режим; `room` — его slug. */
export interface VoiceModeRelay {
  room: string;
  mode: VoiceMode;
}

/** Обновлённый набор реакций конкретного сообщения — рассылается всем в канале. */
export interface ChatReactionRelay {
  id: string;
  reactions: ReactionMap;
}

/** Правка сообщения — новый текст и время правки, всем в канале. */
export interface ChatEditRelay {
  id: string;
  text: string;
  editedTs: number;
}

/** Удаление сообщения — id, всем в канале. */
export interface ChatDeleteRelay {
  id: string;
}

/** «Печатает…»: тег того, кто печатает (себе сервер это событие не шлёт). */
export interface ChatTypingRelay {
  name: string;
}

/** Пинг активности текстового канала: слаг и время последнего сообщения. */
export interface ChatActivityRelay {
  slug: string;
  ts: number;
}

/** Канал закрылся: его слаг (проверить, что закрыли именно открытый у тебя). */
export interface ChatClosedRelay {
  slug: string;
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

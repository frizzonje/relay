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

// Личность на ключах: кодирование, отпечаток и текст подписываемого сообщения.
// Считается одним кодом на обеих сторонах — см. ./identity.
export {
  FINGERPRINT_GROUPS,
  NICK_MAX,
  OWNER_TOKEN_BYTES,
  OWNER_TOKEN_CHARS,
  PAIR_CODE_DIGITS,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  SIGN_ALGORITHM,
  authMessage,
  certificateMessage,
  fingerprint,
  formatPairCode,
  fromBase64Url,
  isOwnerToken,
  isPairCode,
  isPublicKey,
  isSignature,
  ownerLink,
  pairLink,
  readOwnerToken,
  readPairCode,
  sanitizeNick,
  toBase64Url,
} from './identity';

/** Лимит размера загружаемого файла — 25 МБ. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Размер страницы ленты: столько реплик приходит при входе в канал и столько
 * же — за одну подгрузку вверх. С 1.0 это уже не потолок хранения: канал
 * помнит всё, что не съела ретенция.
 */
export const CHAT_PAGE_SIZE = 50;

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
  /**
   * Отпечаток ключа автора: лицо рядом с репликой и единственный способ
   * отличить двух одинаковых «Ань». Пусто у гостя по инвайту и у всего, что
   * писалось до 1.0, — реплику без лица клиент обязан показать как обычную.
   */
  fingerprint?: string;
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
  /** Кого назвали в реплике. Пусто — никого, и ключа в реплике нет. */
  mentions?: MentionRef[];
  /**
   * Реплика закреплена. Видно это прямо в ленте, а не только в списке
   * закреплённого, потому что закрепление — единственное исключение из
   * ретенции: человеку положено знать, какая строка переживёт четырнадцать
   * дней, а какая исчезнет.
   */
  pinned?: true;
}

/**
 * Названный в реплике: отпечаток ключа (это и есть адресат — ники свободные и
 * не уникальные) и ник, как он был написан. По нику клиент находит в тексте то
 * самое слово и рисует его упоминанием; человек к этому времени мог
 * переименоваться, но сказанное вчера от этого не меняется.
 */
export interface MentionRef {
  fingerprint: string;
  nick: string;
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
  /**
   * Этот сервер модерируешь ты: удаляешь чужие сообщения, банишь, видишь список
   * забаненных. Отдельный флаг, а не `mine`, и разница не косметическая: `mine`
   * истинно и у записей без создателя — у главного сервера, например, — где
   * управлять реестром может каждый, а вот удалять чужие слова не должен никто.
   */
  moderated?: boolean;
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

/** Чей потолок кончился: личный, этого сервера или всей инсталляции. */
export type QuotaScope = 'person' | 'server' | 'install';

/**
 * Итог заведения сервера (ack). Раньше отказ был молчанием: диалог закрывался,
 * рейка переключалась на сервер, которого сервер не завёл, и человек оставался
 * в пустом месте без единого слова о том, почему (audit S2).
 *
 * `limit` со `scope` — два разных разговора. «У тебя уже столько серверов»
 * человек чинит сам, удалив свой; «на инсталляции больше нельзя» может починить
 * только тот, у кого ssh к машине, — и путать эти два ответа значит советовать
 * невозможное.
 *
 * `limit` — само число, а не только факт: «серверов не больше пяти» человек
 * понимает, «больше нельзя» — нет.
 *
 * `token` — пропуск в только что созданный закрытый сервер: пароль создатель
 * знает и так, а держать его у себя в браузере клиенту незачем (audit S5).
 */
export type ServerCreateResult =
  | { ok: true; token?: string }
  | {
      ok: false;
      error: 'forbidden' | 'bad-name' | 'exists' | 'limit';
      scope?: QuotaScope;
      limit?: number;
    };

/** Ввод пароля для доступа к закрытому серверу. */
/** Кого банить: сообщение, а `everywhere` — вся инсталляция вместо сервера. */
export interface ModerationBanPayload {
  id: string;
  /** Только владельцу инсталляции. Без него бан действует на текущем сервере. */
  everywhere?: boolean;
}

/** Охват: сервер, а пустой — вся инсталляция (её списки видит только владелец). */
export interface ModerationBansPayload {
  server?: string;
}

export interface ModerationUnbanPayload {
  fingerprint: string;
  server?: string;
}

export type ModerationResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'unknown' };

/**
 * «Дочитал этот канал до этого момента». Время — серверное: клиент возвращает
 * то, что сам получил в `chat-activity` или в снимке каналов, а свои часы в этой
 * арифметике не участвуют вовсе (см. web/stores/unread).
 */
export interface ReadMarkPayload {
  slug: string;
  ts: number;
}

/**
 * Настройка, принадлежащая человеку, а не устройству. Ключи закрытым списком
 * держит сервер; значение он не разбирает.
 */
export interface PrefsSetPayload {
  key: PrefKey;
  value: unknown;
}

/**
 * Что едет с личностью, а что остаётся в этом браузере.
 *
 * Граница проходит по вопросу «это про людей или про эту машину»: громкость
 * собеседника и звук канала — про людей и каналы, они одинаковы на телефоне и
 * на десктопе. Микрофон, наушники, горячие клавиши и push-to-talk — про эту
 * клавиатуру и эти наушники; синхронизировать выбранный микрофон между
 * устройствами значит сломать оба.
 */
export type PrefKey = 'sound' | 'volume';

/** Отметки чтения: снимок на подключении и точечные правки с других устройств. */
export interface ReadsRelay {
  /** Слаг канала → время, до которого он дочитан. Отметка только растёт. */
  marks: Record<string, number>;
  /**
   * Это весь список, а не правка одного канала. Различие клиенту нужно ровно
   * для одного: по снимку он догоняет сервер тем, что успел прочитать без
   * личности (в этом браузере, до первого захода), а по правке — просто
   * гасит точку. Разослать своё локальное в ответ на каждую чужую правку
   * значило бы устроить двум устройствам вечную переписку.
   */
  full?: boolean;
}

/** Непрочитанные упоминания: слаг канала → сколько раз там позвали. */
export interface MentionsRelay {
  counts: Record<string, number>;
}

/** Тебя назвали: в каком канале и когда. */
export interface MentionRelay {
  slug: string;
  ts: number;
}

/** Настройки: снимок на подключении и правки, сделанные на другом устройстве. */
export interface PrefsRelay {
  values: Partial<Record<PrefKey, unknown>>;
  /** Как и у отметок: снимок, по которому клиент отдаёт своё ненесённое. */
  full?: boolean;
}

/** Забаненный так, как его показывают модератору: лицо, имя и след. */
export interface BanEntry {
  fingerprint: string;
  nick: string;
  /** Когда забанен, ISO. */
  at: string;
  /** Ник забанившего; пусто — его личности уже нет. */
  by: string | null;
}

export type ModerationBansResult =
  | { ok: true; bans: BanEntry[] }
  | { ok: false; error: 'forbidden' };

export interface ServerUnlockPayload {
  id: string;
  password: string;
}

/** Ответ сервера на попытку разблокировки: подошёл пароль или нет. */
export interface ServerUnlockResult {
  id: string;
  ok: boolean;
  /**
   * Подписанный пропуск: клиент предъявляет его в handshake и остаётся
   * разблокированным после реконнекта, не храня у себя пароль. Есть только при
   * `ok` и только у сервера, который действительно заперт.
   */
  token?: string;
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
 * Итог заведения канала (ack). `slug` — адрес комнаты, и считает его сервер:
 * клиенту, который хочет тут же войти в созданное, узнать его больше неоткуда.
 */
export type ChannelCreateResult =
  | { ok: true; slug: string }
  | {
      ok: false;
      error: 'not-found' | 'forbidden' | 'bad-name' | 'exists' | 'limit';
      scope?: QuotaScope;
      limit?: number;
    };

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
  /**
   * Сколько дней живёт переписка (`RETENTION_DAYS`), когда она живёт днями.
   * Клиенту нужен, чтобы объяснить край ленты: «выше начало канала» и «выше
   * уже удалено» — разные вещи, и человек имеет право знать, какая из них
   * перед ним. При `forever` и `ephemeral` дней нет — смотри `retentionMode`.
   */
  retentionDays?: number;
  /**
   * Чем именно кончается история. Отдельно от числа, потому что «хранится без
   * срока» и «не хранится вовсе» — противоположные обещания, а числом они
   * различались бы только по договорённости, которой человек не знает.
   * Сервер прошлой версии поля не пришлёт: тогда судим по дням, как раньше.
   */
  retentionMode?: RetentionMode;
  /**
   * Версия сервера — номер релиза, под которым собран образ api. Пустая строка
   * у инсталляции, собранной из исходников: номера у неё нет, и придумывать его
   * нельзя. Клиент сверяет её со своей, чтобы заметить вкладку, оставшуюся
   * открытой через обновление.
   */
  version?: string;
}

/** Что инсталляция делает с историей. Зеркало `Retention` в api. */
export type RetentionMode = 'days' | 'forever' | 'ephemeral';

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
  /**
   * Отпечаток ключа участника — из него рисуется лицо (см. lib/identicon).
   * Пусто у гостя по инвайту и у клиента, который ещё не стал личностью: имя
   * такого участника самоназванное, и лица у него нет по существу, а не по
   * недосмотру.
   */
  fingerprint?: string;
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
  /**
   * Кого имел в виду отправитель — отпечатками ключей выбранных им людей.
   * Именами нельзя: они не уникальны, и «@Аня» в инсталляции с двумя Анями
   * звало бы наугад. Сервер оставит из присланного тех, чьё имя в тексте и
   * правда написано.
   */
  mentions?: string[];
}

/** Правка своего сообщения — по id, новый текст. Автор проверяется по тегу. */
export interface ChatEditPayload {
  id: string;
  text: string;
  /** Упоминания новой редакции — тем же порядком, что и при отправке. */
  mentions?: string[];
}

/** Кого предложить после набранного `@`. Пустой префикс — «покажи всех». */
export interface MentionSuggestPayload {
  prefix?: string;
}

/**
 * Кого можно назвать в этом канале. `online` — человек сейчас на связи; такие
 * идут первыми: для них упоминание не запись в историю, а обращение.
 */
export type MentionSuggestResult = {
  ok: true;
  people: { fingerprint: string; nick: string; online: boolean }[];
};

/**
 * Кто сейчас в текстовом канале. Не строка с именем, а человек: имена в relay
 * свободные и не уникальные, и список из одних имён не отличает двух «Ань» —
 * ни на глаз, ни в коде. Отпечаток даёт лицо (см. web/lib/identicon) и заодно
 * служит ключом: одна личность, вошедшая с двух устройств, — одна строка.
 *
 * У гостя по инвайту отпечатка нет: ключа ему не выдавали. Такой стоит в списке
 * сам по себе, лицом ему остаётся градиент по имени.
 */
export interface RosterPerson {
  nick: string;
  fingerprint?: string;
}

/** Удаление своего сообщения — по id. Автор проверяется по тегу. */
export interface ChatDeletePayload {
  id: string;
}

/**
 * Закрепить (`on: true`) или открепить реплику. Состояние называется явно, а не
 * выводится сервером из текущего: лента клиента бывает старше действительности
 * на одно чужое действие, и «переключить» сняло бы то, что человек ставил.
 */
export interface ChatPinPayload {
  id: string;
  on: boolean;
}

/**
 * Ответ на закрепление. `limit` — единственный отказ, с которым человеку есть
 * что делать: открепить лишнее. `forbidden` — канал не свой: закрепление меняет
 * канал для всех и вынимает реплику из-под ретенции, а это модерация.
 */
export type ChatPinResult =
  | { ok: true; pinned: boolean; count: number }
  | { ok: false; error: 'forbidden' | 'not-found' | 'limit' };

/**
 * За закреплённым какого канала пришли. Слаг — не адрес (сервер отвечает про ту
 * комнату, в которой сокет и так сидит), а сверка: ответ бывает медленнее
 * человека, и чужой список, подставленный в открытый канал, читался бы как его
 * собственный.
 */
export interface ChatPinsPayload {
  slug: string;
}

/**
 * Закреплённое канала целиком: их не больше потолка, страниц не нужно. Слаг в
 * ответе говорит, чей это список.
 */
export type ChatPinsResult = { ok: true; slug: string; pins: ChatMessage[] } | { ok: false };

/**
 * Сколько реплик можно закрепить в одном канале — потолок сервера, клиент
 * знает его, чтобы объяснить отказ до того, как получит его от сервера.
 *
 * Число здесь не про место на диске: закрепление — единственный способ оставить
 * сказанное жить дольше ретенции, и без потолка четырнадцать дней стали бы
 * пожеланием.
 */
export const PIN_LIMIT = 50;

/** Тогл реакции: повторная отправка того же эмодзи снимает её. */
export interface ChatReactPayload {
  id: string;
  emoji: string;
}

/**
 * Курсор подгрузки ленты вверх: время и id самой верхней реплики, которую
 * клиент уже держит. Пары достаточно, а «страница номер N» разъезжалась бы —
 * снизу всё это время приходит новое.
 */
export interface ChatHistoryMorePayload {
  beforeTs: number;
  beforeId: string;
}

/**
 * Страница истории. `more` — «выше есть ещё»: без него клиент не отличает
 * начало канала от края, срезанного ретенцией, и рисует одно вместо другого.
 */
export interface ChatHistoryPage {
  /** Чей это кусок ленты: ответ мог обогнать смену канала. */
  slug: string;
  messages: ChatMessage[];
  more: boolean;
  /**
   * Сколько в канале закреплено. Число едет со страницей, а сам список — по
   * запросу: шапке нужно только оно, а полсотни реплик, которых, может, и не
   * откроют, — груз на каждый вход в канал.
   */
  pins?: number;
}

export type ChatHistoryMoreResult = { ok: true; messages: ChatMessage[]; more: boolean };

/**
 * Кусок ленты из середины истории — то, что видно после перехода из поиска. От
 * обычной страницы отличается тем, что у него есть низ: пока лента читалась
 * сверху вниз, «дальше» всегда значило вверх, а из поиска человек попадает в
 * прошлое, и под ним остаётся весь остальной канал.
 */
export type ChatWindowResult = {
  ok: true;
  messages: ChatMessage[];
  more: boolean;
  moreAfter: boolean;
};

/** Курсор подгрузки вниз: время и id самой нижней реплики, которую держит клиент. */
export interface ChatHistoryAfterPayload {
  afterTs: number;
  afterId: string;
}

/** Какую реплику показать в контексте её канала (переход из результатов поиска). */
export interface ChatAroundPayload {
  id: string;
}

/**
 * Где ищем. Канал — открытый прямо сейчас; сервер — все его текстовые каналы,
 * которые человеку видно. Дальше сервера поиск не идёт намеренно: общий список
 * «по всему» смешал бы разговоры из мест, которые человек держит раздельно.
 */
export type SearchScope = 'channel' | 'server';

/** Запрос поиска. Курсор — как у ленты: время и id последней показанной находки. */
export interface ChatSearchPayload {
  query: string;
  scope: SearchScope;
  beforeTs?: number;
  beforeId?: string;
}

/** Находка: реплика и канал, где она сказана (в поиске по серверу — любой). */
export interface SearchHit {
  slug: string;
  message: ChatMessage;
}

export type ChatSearchResult = {
  ok: true;
  hits: SearchHit[];
  more: boolean;
  /**
   * Слова, по которым искали на самом деле. Ими клиент подсвечивает найденное:
   * разбери он запрос второй раз, своими правилами, — подсветил бы не то, что
   * нашлось.
   */
  terms: string[];
};

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
  /** Закрепить или открепить реплику — право модератора сервера. */
  'chat-pin': (payload: ChatPinPayload, cb: (res: ChatPinResult) => void) => void;
  /** Список закреплённого открытого канала — спрашивается, когда его открывают. */
  'chat-pins': (payload: ChatPinsPayload, cb: (res: ChatPinsResult) => void) => void;
  /**
   * Подгрузить страницу выше уже показанной. Курсор — время и id самой верхней
   * реплики на экране; сервер по нему ничего не хранит.
   */
  'chat-history-more': (
    payload: ChatHistoryMorePayload,
    cb: (res: ChatHistoryMoreResult) => void,
  ) => void;
  /**
   * Подгрузить страницу НИЖЕ показанной. Спрашивается только после перехода из
   * поиска: у живого конца канала ниже ничего нет по определению.
   */
  'chat-history-after': (
    payload: ChatHistoryAfterPayload,
    cb: (res: ChatWindowResult) => void,
  ) => void;
  /** Показать реплику в контексте: окно вокруг неё вместо последней страницы. */
  'chat-around': (payload: ChatAroundPayload, cb: (res: ChatWindowResult) => void) => void;
  /** Поиск по истории — канала или всего сервера, в котором открыт канал. */
  'chat-search': (payload: ChatSearchPayload, cb: (res: ChatSearchResult) => void) => void;
  'media-update': (payload: MediaUpdatePayload) => void;
  rename: (payload: RenamePayload) => void;
  'server-create': (payload: ServerCreatePayload, cb: (res: ServerCreateResult) => void) => void;
  'server-delete': (payload: ServerDeletePayload, cb: (res: ServerDeleteResult) => void) => void;
  'server-stats': (payload: ServerStatsPayload, cb: (res: ServerStatsResult) => void) => void;
  'server-unlock': (payload: ServerUnlockPayload) => void;
  'channel-create': (payload: ChannelCreatePayload, cb: (res: ChannelCreateResult) => void) => void;
  'channel-delete': (payload: ChannelDeletePayload, cb: (res: ChannelDeleteResult) => void) => void;
  'channel-rename': (payload: ChannelRenamePayload, cb: (res: ChannelRenameResult) => void) => void;
  'channel-stats': (payload: ChannelStatsPayload, cb: (res: ChannelStatsResult) => void) => void;
  'channel-mode': (payload: ChannelModePayload) => void;
  'invite-create': (payload: InviteCreatePayload, cb: (res: InviteCreateResult) => void) => void;
  /** Выгнать гостя из эфира — вправе любой НЕ-гость, кому виден этот канал. */
  'guest-kick': (payload: GuestKickPayload, cb: (res: GuestKickResult) => void) => void;
  /**
   * Забанить автора сообщения. Целью служит сказанное, а не имя: имена не
   * уникальны, а реплика однозначно указывает на своего автора.
   */
  'moderation-ban': (payload: ModerationBanPayload, cb: (res: ModerationResult) => void) => void;
  'moderation-unban': (
    payload: ModerationUnbanPayload,
    cb: (res: ModerationResult) => void,
  ) => void;
  'moderation-bans': (
    payload: ModerationBansPayload,
    cb: (res: ModerationBansResult) => void,
  ) => void;
  'sfu-token': (payload: SfuTokenPayload, cb: (res: SfuTokenResult) => void) => void;
  'voice-diag': (payload: VoiceDiagPayload) => void;
  /**
   * Канал дочитан. Ответа нет намеренно: точка у человека уже погашена, и
   * держать индикатор в зависимости от того, дошёл ли пакет, незачем.
   */
  'read-mark': (payload: ReadMarkPayload) => void;
  /** Настройка человека — с этого устройства на все остальные. */
  'prefs-set': (payload: PrefsSetPayload) => void;
  /** Кого предложить после набранного `@` — список собирает сервер. */
  'mention-suggest': (
    payload: MentionSuggestPayload,
    cb: (res: MentionSuggestResult) => void,
  ) => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Socket-события: server → client
// ─────────────────────────────────────────────────────────────────────────

export interface PeerJoinedPayload {
  id: string;
  name?: string;
  /** Отпечаток ключа: лицо на плитке (см. VoicePeer.fingerprint). */
  fingerprint?: string;
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
  'chat-history': (page: ChatHistoryPage) => void;
  'chat-roster': (people: RosterPerson[]) => void;
  'chat-reaction': (payload: ChatReactionRelay) => void;
  /** Сообщение отредактировали — обновить текст и показать пометку «изменено». */
  'chat-edited': (payload: ChatEditRelay) => void;
  /** Сообщение удалили — убрать из ленты по id. */
  'chat-deleted': (payload: ChatDeleteRelay) => void;
  /** Реплику закрепили или открепили — обновить пометку и число в шапке. */
  'chat-pinned': (payload: ChatPinnedRelay) => void;
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
  /**
   * Тебя забанили на всей инсталляции — сокет сейчас закроется, и обратно его
   * не пустят. Событие без тела: сказать тут больше нечего, а показать экран
   * вместо молчащего приложения обязательно.
   */
  banned: () => void;
  /**
   * Отметки чтения: полным снимком на подключении и правкой, когда человек
   * дочитал канал на другом своём устройстве. Без личности не приходит вовсе —
   * непрочитанное такого клиента остаётся его личным делом.
   */
  reads: (payload: ReadsRelay) => void;
  /** Настройки: тем же порядком — снимок на входе, правки с других устройств. */
  prefs: (payload: PrefsRelay) => void;
  /**
   * Человек сменил имя на другом своём устройстве. Имя живёт у личности, а не
   * у вкладки, — и вкладка, которая об этом не узнала, до перезахода
   * подписывает его реплики прежним именем.
   */
  renamed: (payload: RenamePayload) => void;
  /**
   * Непрочитанные упоминания по каналам — снимком, на подключении и после
   * разблокировки закрытого сервера. Считает их сервер: пережить рестарт и
   * переезд на другое устройство счётчик «тебя звали» обязан.
   */
  mentions: (payload: MentionsRelay) => void;
  /**
   * Тебя назвали прямо сейчас. Летит на все устройства человека, кроме тех,
   * с которых он написал это сам.
   */
  mention: (payload: MentionRelay) => void;
  /**
   * Вход в голосовой канал закрытого сервера не разрешён: пароль не предъявлен
   * или пропуск истёк. Летит только тому, кому отказали.
   *
   * Молчать здесь нельзя. Отказ на `join` клиент никак не отличает от входа,
   * прошедшего успешно: он считает себя в канале, остальные его не видят, и
   * разбирается это уже по серверному логу. Хуже того, второй участник в это
   * время сидит в SFU, а отказанный съезжает в mesh — комната расщепляется по
   * транспортам, и тишина оказывается взаимной.
   */
  'voice-locked': (payload: VoiceLockedRelay) => void;
}

/** Вход в этот голосовой канал закрыт: нужен пароль сервера. */
export interface VoiceLockedRelay {
  room: string;
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
  /**
   * Упоминания новой редакции целиком, а не разница: имя могли и дописать, и
   * убрать, и клиенту проще заменить список, чем складывать из правок то, что
   * сервер уже сложил.
   */
  mentions?: MentionRef[];
}

/** Удаление сообщения — id, всем в канале. */
export interface ChatDeleteRelay {
  id: string;
}

/**
 * Реплику закрепили или открепили — всем в канале. `count` присылается готовым,
 * а не выводится клиентом сложением: иначе число в шапке пришлось бы держать
 * верным у того, кто ленту и не открывал, — и оно бы разъезжалось.
 */
export interface ChatPinnedRelay {
  id: string;
  pinned: boolean;
  count: number;
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
  /**
   * Почему лента закрылась. Пусто — канал удалили, и так было всегда. `banned`
   * — тебя забанили на сервере, которому канал принадлежит: канал цел, ушёл
   * ты. Разные вещи, и говорить о них одним тостом значит соврать одному из
   * двоих — тому, кто пойдёт искать удалённый канал, которого никто не удалял.
   */
  reason?: 'banned';
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

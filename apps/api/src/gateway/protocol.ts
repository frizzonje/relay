import type { Attachment } from '../uploads';

/**
 * Форма сообщений сигналинга: что приходит от клиента и что уходит ack'ом.
 *
 * Всё, что клиент прислал, объявлено как `unknown`, и это не поза: тело
 * сообщения socket.io не проверяет никто, а обработчик обязан считать его
 * враньём до первой проверки. Типы здесь описывают ФОРМУ разговора, а не
 * гарантию — гарантию даёт разбор в обработчике.
 *
 * Ответы (`*Result`) совпадают по форме с одноимёнными типами из
 * `@relay/shared`: api намеренно не зависит от пакета фронта, поэтому
 * контракт держится совпадением, а не общим импортом.
 *
 * Здесь же — единственный способ читать эти тела (`str`/`trimmed`/`optional`) и
 * потолки полей (`LIMIT`). Раньше разбор был написан тридцать три раза одной и
 * той же строкой с числом внутри, и одно поле в разных обработчиках резалось
 * по-разному просто потому, что копии писались в разные дни.
 */

// ── Как это читать ──────────────────────────────────────────────────────────

/**
 * Потолки полей, приходящих от клиента. Названы по смыслу, а не по месту: тег
 * участника — это двадцать символов в `join`, в `rename` и в `chat-join`, и
 * расходиться эти три числа не должны.
 */
export const LIMIT = {
  /** id сервера — его придумывает клиент, чтобы не ждать ответа. */
  id: 64,
  /** Имя сервера или канала. */
  name: 32,
  /** Тег участника. */
  tag: 20,
  /** Слаг канала, он же имя комнаты. */
  slug: 32,
  /** Значок сервера. */
  emoji: 8,
  /** Реплика чата. */
  message: 500,
  /** Поисковый запрос — заведомо длиннее любого осмысленного и короче реплики. */
  search: 100,
  /** Отпечаток ключа: адресат упоминания и цель разбана. */
  fingerprint: 64,
  /**
   * Сколько имён носит одна реплика. Восемь — это уже не разговор с людьми, а
   * рассылка; больше принимать незачем, и лишнее просто не доедет.
   */
  mentions: 8,
  /** Диагностическая веха звонка и её пояснение — только в лог. */
  diagEvent: 48,
  diagDetail: 200,
} as const;

/**
 * Подпись того, кто не назвался. Сервер пишет её в историю чата и в presence,
 * то есть она уезжает клиентам готовой строкой и локалью веба не переводится —
 * английский интерфейс увидит её по-русски. Чинится это не здесь: подпись
 * перестанет быть текстом с сервера, когда участник станет личностью (слой 2
 * плана 1.0), — а до тех пор пусть будет хотя бы в одном месте, а не в семи.
 */
export const ANON_NAME = 'Аноним';

/** Строка из тела как есть. Не строка — пустая строка, а не `undefined`. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Строка из тела, обрезанная по краям и по длине. Не строка — пустая. */
export function trimmed(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * То же, но «поля не было» отличается от «пришло пустым»: `join` кладёт имя на
 * сокет, и там пустая строка и отсутствие имени — разные вещи.
 */
export function optional(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.trim().slice(0, limit) : undefined;
}

// ── Что присылает клиент ────────────────────────────────────────────────────

export interface JoinPayload {
  room?: unknown;
  name?: unknown;
  clientId?: unknown;
  transport?: unknown;
}

export interface SignalPayload {
  to?: unknown;
  sdp?: unknown;
  candidate?: unknown;
}

export interface ChatPayload {
  room?: unknown;
  name?: unknown;
  text?: unknown;
  uploadId?: unknown;
  replyTo?: unknown;
  spoiler?: unknown;
  /**
   * Кого имел в виду отправитель — отпечатками ключей, а не именами: имена
   * свободные и не уникальные, и «@Аня» в инсталляции с двумя Анями адресовало
   * бы обеих или наугад одну. Клиент называет их, выбрав из подсказки, а сервер
   * сверяет, что названный и правда назван в тексте (см. `mentionedIn`).
   */
  mentions?: unknown;
}

/**
 * Курсор подгрузки ленты вверх: время и id самой верхней реплики, которую
 * клиент уже держит. Пары достаточно и она честнее «страницы номер N» —
 * страницы разъезжаются, когда снизу приходит новое.
 */
export interface ChatHistoryMorePayload {
  beforeTs?: unknown;
  beforeId?: unknown;
}

/** Тот же курсор, но вниз: время и id самой нижней реплики на экране. */
export interface ChatHistoryAfterPayload {
  afterTs?: unknown;
  afterId?: unknown;
}

/** Какую реплику показать в контексте её канала — переход из поиска. */
export interface ChatAroundPayload {
  id?: unknown;
}

/**
 * Запрос поиска. Область приходит от клиента, но набор каналов по ней собирает
 * сервер: «по этому серверу» значит «по тем его каналам, которые видно этому
 * сокету», и решать, что кому видно, клиенту не дают нигде.
 */
export interface ChatSearchPayload {
  query?: unknown;
  scope?: unknown;
  beforeTs?: unknown;
  beforeId?: unknown;
}

export interface ChatEditPayload {
  id?: unknown;
  text?: unknown;
  /** Правка переписывает и упоминания: имя в тексте могло появиться или уйти. */
  mentions?: unknown;
}

/** Кого предложить после набранного `@`. Пустой префикс — «покажи всех». */
export interface MentionSuggestPayload {
  prefix?: unknown;
}

export interface ChatDeletePayload {
  id?: unknown;
}

export interface ChatReactPayload {
  id?: unknown;
  emoji?: unknown;
}

/**
 * Закрепить или открепить реплику. `on` приходит явно, а не выводится из
 * текущего состояния: клиент решает по своей копии ленты, а она бывает старше
 * действительности на одно чужое действие, — и тогда «переключить» сняло бы то,
 * что человек хотел поставить.
 */
export interface ChatPinPayload {
  id?: unknown;
  on?: unknown;
}

/**
 * За закреплённым какого канала пришли. Слаг здесь — не адрес (сервер отвечает
 * про ту комнату, в которой сокет и сидит), а сверка: ответ бывает медленнее
 * человека, и список чужого канала, подставленный в открытый, выглядел бы как
 * чужие закрепления.
 */
export interface ChatPinsPayload {
  slug?: unknown;
}

/**
 * Модерация. Целью бана служит СООБЩЕНИЕ, а не человек: id личности в протоколе
 * не появляется вовсе (см. ./ownership), а список участников — это имена, среди
 * которых бывают тёзки. Сообщение же однозначно указывает на своего автора, и
 * банят в жизни именно за сказанное, глядя на него.
 *
 * `everywhere` — бан на всю инсталляцию вместо бана со своего сервера. Такой
 * ставит только владелец, и спрашивается он явно: молча расширить охват до
 * инсталляции, когда человек хотел выгнать со своего сервера, нельзя.
 */
export interface ModerationBanPayload {
  id?: unknown;
  everywhere?: unknown;
}

/** Разбан и список забаненных — по охвату: сервер или, если пусто, инсталляция. */
export interface ModerationBansPayload {
  server?: unknown;
}

export interface ModerationUnbanPayload {
  fingerprint?: unknown;
  server?: unknown;
}

/**
 * «Дочитал этот канал до этого момента». Канал зовётся слагом — тем же, что и
 * везде в протоколе; в базе отметка живёт по id канала, чтобы переименование
 * не объявляло его непрочитанным заново.
 *
 * Время — серверное: клиент возвращает то, что сам получил в `chat-activity`
 * или в снимке каналов. Свои часы он здесь не спрашивает вовсе, иначе на
 * спешащем устройстве точка не загоралась бы, а на отстающем не гасла.
 */
export interface ReadMarkPayload {
  slug?: unknown;
  ts?: unknown;
}

/**
 * Настройка человека: ключ из закрытого списка (см. `identity/prefs.service`) и
 * значение, о смысле которого сервер не осведомлён.
 */
export interface PrefsSetPayload {
  key?: unknown;
  value?: unknown;
}

export interface ServerCreatePayload {
  id?: unknown;
  name?: unknown;
  emoji?: unknown;
  password?: unknown;
}

export interface ServerDeletePayload {
  id?: unknown;
}

export interface ServerStatsPayload {
  id?: unknown;
}

export interface ServerUnlockPayload {
  id?: unknown;
  password?: unknown;
}

export interface ChannelCreatePayload {
  serverId?: unknown;
  type?: unknown;
  name?: unknown;
  mode?: unknown;
}

export interface ChannelModePayload {
  id?: unknown;
  mode?: unknown;
}

export interface ChannelDeletePayload {
  id?: unknown;
}

export interface ChannelRenamePayload {
  id?: unknown;
  name?: unknown;
}

export interface ChannelStatsPayload {
  id?: unknown;
}

export interface InviteCreatePayload {
  room?: unknown;
}

/** Кого выгоняем: socket-id гостя (он же его id в presence и на плитке). */
export interface GuestKickPayload {
  id?: unknown;
}

export interface SfuTokenPayload {
  room?: unknown;
  name?: unknown;
}

/** Диагностическая веха звонка от клиента — уходит в серверный лог как есть. */
export interface VoiceDiagPayload {
  event?: unknown;
  detail?: unknown;
}

// ── Что уходит ack'ом ───────────────────────────────────────────────────────
// Отказ обязан быть внятным: интерфейс объясняет, почему канал остался на
// месте, вместо молчаливого «ничего не произошло».

/**
 * Итог заведения сервера. До 1.0 отказ был молчанием: интерфейс закрывал
 * диалог, рисовал новый сервер активным — и человек оставался стоять в
 * несуществующем месте, не зная, что произошло (audit S2).
 *
 * `limit` со `scope` — два разных разговора: «у тебя уже столько» человек
 * чинит сам, «на инсталляции больше нельзя» может починить только тот, у кого
 * ssh к машине, — и путать их значит советовать невозможное.
 *
 * `token` — пропуск в только что созданный закрытый сервер (audit S5).
 */
export type ServerCreateResult =
  | { ok: true; token?: string }
  | {
      ok: false;
      error: 'forbidden' | 'bad-name' | 'exists' | 'limit';
      scope?: QuotaScope;
      limit?: number;
    };

/** Чей потолок кончился: личный, этого сервера или всей инсталляции. */
export type QuotaScope = 'person' | 'server' | 'install';

/**
 * Итог заведения канала. `slug` возвращается не для красоты: адрес комнаты
 * считает сервер, и клиент, который хочет тут же в неё войти, узнаёт его
 * отсюда.
 */
export type ChannelCreateResult =
  | { ok: true; slug: string }
  | {
      ok: false;
      error: 'not-found' | 'forbidden' | 'bad-name' | 'exists' | 'limit';
      scope?: QuotaScope;
      limit?: number;
    };

export type ChannelDeleteResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'occupied' | 'not-owner'; occupants?: number };

export type ChannelRenameResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'bad-name' | 'not-owner' };

export type ChannelStatsResult = { ok: true; occupants: number; messages: number } | { ok: false };

/**
 * Страница истории. `more` — «выше есть ещё»: без него клиент не отличает
 * начало истории от её края, срезанного ретенцией, и рисует одно вместо
 * другого.
 */
export interface ChatHistoryPage {
  messages: ChatMessage[];
  more: boolean;
}

export type ChatHistoryMoreResult = { ok: true } & ChatHistoryPage;

/**
 * Окно ленты вокруг точки: у него, в отличие от страницы, есть низ. Пока лента
 * читалась только сверху вниз, «дальше» всегда значило вверх; из поиска человек
 * попадает в середину истории, и под ним остаётся весь остальной канал.
 */
export type ChatWindowResult = { ok: true } & ChatHistoryPage & { moreAfter: boolean };

/** Ответ поиска: находки, есть ли ещё и слова, по которым искали. */
export type ChatSearchResult = {
  ok: true;
  hits: { slug: string; message: ChatMessage }[];
  more: boolean;
  /**
   * Разобранные слова запроса. Возвращаем их, чтобы подсветку в найденном
   * рисовали ровно по тому, по чему искали: свой разбор на клиенте — это второе
   * место с правилами, и оно неизбежно разъедется с первым.
   */
  terms: string[];
};

/**
 * Кого можно назвать здесь. `online` — человек сейчас на связи; такие идут
 * первыми, потому что упоминание для них — не запись в историю, а обращение,
 * которое они увидят сейчас.
 */
export type MentionSuggestResult = {
  ok: true;
  people: { fingerprint: string; nick: string; online: boolean }[];
};

/**
 * Ответ на закрепление. `limit` — единственный отказ, о котором человеку есть
 * что сделать: открепить лишнее. `not-found` — реплики уже нет, `forbidden` —
 * канал не свой (закрепление меняет канал для всех, значит это модерация).
 */
export type ChatPinResult =
  | { ok: true; pinned: boolean; count: number }
  | { ok: false; error: 'forbidden' | 'not-found' | 'limit' };

/**
 * Закреплённое канала — целиком: их не больше `PIN_LIMIT`, страниц не нужно.
 * Слаг в ответе — чей это список: по нему клиент отличает свой ответ от
 * доехавшего после смены канала.
 */
export type ChatPinsResult = { ok: true; slug: string; pins: ChatMessage[] } | { ok: false };

export type ServerDeleteResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not-found' | 'forbidden' | 'not-owner' | 'occupied';
      occupants?: number;
    };

export type ServerStatsResult =
  | { ok: true; channels: number; messages: number; occupants: number }
  | { ok: false };

export type InviteCreateResult =
  | { ok: true; token: string; exp: number; listen: boolean }
  | { ok: false; error: 'not-found' | 'forbidden' };

/**
 * Отказ в «выгнать» тоже обязан быть внятным: not-found — гость уже вышел сам
 * (частый случай: кнопку жмут вдогонку), forbidden — канал этому сокету не
 * виден либо он сам гость.
 */
export type GuestKickResult = { ok: true } | { ok: false; error: 'not-found' | 'forbidden' };

/**
 * Отказ модератору. `not-found` — сообщения уже нет (удалили, вышло за
 * ретенцию) либо у него нет автора-личности: гостя по инвайту банить нечем,
 * его выгоняют из эфира. `forbidden` — не твой сервер, не ты владелец или это
 * попытка забанить владельца.
 */
export type ModerationResult =
  | { ok: true }
  | { ok: false; error: 'not-found' | 'forbidden' | 'unknown' };

export interface BanEntry {
  fingerprint: string;
  nick: string;
  at: string;
  by: string | null;
}

export type ModerationBansResult =
  | { ok: true; bans: BanEntry[] }
  | { ok: false; error: 'forbidden' };

export type SfuTokenResult =
  | { ok: true; token: string; exp: number; url: string }
  | { ok: false; error: 'forbidden' | 'unavailable' | 'not-in-room' | 'not-sfu' };

// ── Что живёт в состоянии ───────────────────────────────────────────────────

export type ReactionMap = Record<string, string[]>;

/**
 * Снимок цитируемого сообщения (reply) — копией, а не ссылкой: исходное могут
 * отредактировать или удалить, цитата остаётся прежней.
 */
export interface ReplyRef {
  id: string;
  name: string;
  text: string;
}

/**
 * Названный в реплике: отпечаток его ключа и ник, как он был написан. Ник тут
 * не украшение — по нему клиент находит в тексте то самое слово и рисует его
 * упоминанием; текущее имя человека к этому моменту может быть уже другим.
 */
export interface MentionRef {
  fingerprint: string;
  nick: string;
}

/**
 * Кто сейчас в текстовом канале. Человек, а не сокет и не строка с именем:
 * имена свободные и не уникальные, а одна личность может сидеть с двух
 * устройств — склеивает их отпечаток (см. `emitRoster`). У гостя по инвайту
 * отпечатка нет, ключа ему не выдавали.
 */
export interface RosterPerson {
  nick: string;
  fingerprint?: string;
}

export interface ChatMessage {
  id?: string;
  name: string;
  /**
   * Отпечаток ключа автора: по нему рисуется лицо в ленте и по нему же двух
   * одинаковых «Ань» видно, что они разные. Пусто у гостя по инвайту и у всего,
   * что писалось до 1.0, — поле необязательное именно поэтому, а не «на всякий
   * случай»: клиент обязан уметь показать реплику без лица.
   */
  fingerprint?: string;
  text: string;
  ts: number;
  attachment?: Attachment;
  system?: boolean;
  reactions?: ReactionMap;
  replyTo?: ReplyRef;
  editedTs?: number;
  /** Кого в ней назвали. Пусто — не назвали никого, и ключа в реплике нет. */
  mentions?: MentionRef[];
  /**
   * Реплика закреплена. Это не украшение: закрепление — единственное исключение
   * из ретенции, и человек вправе видеть в самой ленте, какая строка переживёт
   * четырнадцать дней, а какая нет.
   */
  pinned?: true;
}

/**
 * Участник голосового канала в presence. `transport` называет сам клиент в
 * `join`: разъехавшись в транспортах, люди друг друга не слышат вовсе, и знать
 * об этом должны все.
 */
export interface VoicePresenceEntry {
  id: string;
  name: string;
  /** Отпечаток ключа: лицо на плитке. Пусто у гостя по инвайту (см. ChatMessage). */
  fingerprint?: string;
  micOn: boolean;
  deafened: boolean;
  transport: 'p2p' | 'sfu';
  guest?: boolean;
  /** Гость-слушатель: канал под паролем, право говорить ссылка не раздаёт. */
  listen?: boolean;
}

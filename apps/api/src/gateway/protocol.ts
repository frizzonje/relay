import type { Attachment } from '../uploads';
import type { SettingGroup, SettingSpec, SettingValue } from '../settings/catalog';
import type { RetentionMode } from '../db/retention.policy';

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

/**
 * Версия контракта сигналинга. Копия числа из `@relay/shared` — api намеренно
 * не зависит от пакета фронта, и совпадение проверяет контрактный тест.
 *
 * Клиент называет её в handshake, сервер сверяет и не пускает несовпавших:
 * отставший клиент до 1.0 выглядел не устаревшим, а сломанным.
 */
export const PROTOCOL_VERSION = 1;

// ── Как это читать ──────────────────────────────────────────────────────────

/**
 * Потолки полей, приходящих от клиента. Названы по смыслу, а не по месту: тег
 * участника — это двадцать символов в `join`, в `rename` и в `chat-join`, и
 * расходиться эти три числа не должны.
 *
 * Три из них с этапа C стали умолчаниями настроек — `name`
 * (`spaces.channelNameMaxLength`), `message` (`messages.maxLength`) и
 * `mentions` (`moderation.maxMentionsPerMessage`): действующее число
 * спрашивает обработчик, а здесь остаётся то, с чем инсталляция живёт, пока
 * панель не открывали. Оно же уезжает клиенту контрактом (`LIMITS` в
 * `@relay/shared`), поэтому менять его тут нельзя в одиночку.
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
  /** Строка поиска собеседника в `dm-people`: отпечаток и ник короче. */
  dmQuery: 64,
  /** Поиск человека в панели: ищут и по нику, и по отпечатку целиком. */
  adminQuery: 64,
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

/** Кому пишем: отпечаток ключа, а не ник — ники не уникальны. */
export interface DmOpenPayload {
  fingerprint?: unknown;
}

/** В ленту какой беседы садимся — тот же слаг, что вернул `dm-open`. */
export interface DmJoinPayload {
  slug?: unknown;
}

/** Поиск по списку собеседников: нику или отпечатку. Пусто — весь список. */
export interface DmPeoplePayload {
  query?: unknown;
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

/**
 * Итог открытия беседы. `unknown` — такой личности инсталляция не знает,
 * `self` — попытка открыть беседу с собой, `forbidden` — ЛС не для тебя
 * (гость по инвайту, отсутствие личности).
 */
export type DmOpenResult =
  | { ok: true; conversation: DmConversation }
  | { ok: false; error: 'unknown' | 'self' | 'forbidden' };

/**
 * Итог входа в ленту беседы. `unknown` — такого адреса нет вовсе,
 * `forbidden` — адрес существует, но сокет не одна из двух сторон.
 */
export type DmJoinResult = { ok: true } | { ok: false; error: 'unknown' | 'forbidden' };

export type DmListResult =
  | { ok: true; conversations: DmConversation[] }
  | { ok: false; error: 'forbidden' };

export type DmPeopleResult = { ok: true; people: DmPerson[] } | { ok: false; error: 'forbidden' };

// ── Что живёт в состоянии ───────────────────────────────────────────────────

/** Кто поставил реакцию: отпечаток ключа и ник на тот момент (audit S1). */
export interface Reactor {
  fingerprint?: string;
  nick: string;
}

export type ReactionMap = Record<string, Reactor[]>;

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
 * Почему реплика не принята.
 *
 * События ленты (`chat-message`, `chat-edit`, `chat-delete`, `chat-react`)
 * ответа не ждут — ack'а у них нет и заводить его поздно, — поэтому отказ
 * уезжает отдельным событием тому, кому отказали. Молчать здесь нельзя: до
 * этапа C всякий отказ в ленте выглядел одинаково — «нажал, и ничего не
 * произошло», — а теперь у него появились причины, которые человек может
 * устранить сам (убрать ссылку, дождаться конца обслуживания, не повторять
 * слово). Это тот же выбор, что у `voice-locked` и `chat-closed`.
 *
 * Причины разные намеренно: «правку выключили» и «правка протухла» человек
 * чинит по-разному, а один общий отказ советовал бы невозможное.
 */
export type ChatRefusal =
  | 'read-only'
  | 'rate'
  | 'banned-word'
  | 'links-off'
  | 'attachments-off'
  | 'edit-off'
  | 'edit-window'
  | 'delete-off'
  | 'reactions-off'
  | 'search-off'
  | 'too-new'
  | 'spoiler-off';

export interface ChatRefusedRelay {
  reason: ChatRefusal;
}

/**
 * Почему в голосе отказали.
 *
 * Событие отдельное по той же причине, что и `chat-refused`: ни `join`, ни
 * `media-update` ответа не ждут, а `join` вдобавок неотличим для клиента от
 * удавшегося — без этого выключенная камера выглядела бы сломанной кнопкой, а
 * полный канал — тишиной. Урок этапа A прямым текстом.
 *
 * `room-full` и `guests-full` разделены намеренно: первое человек переждёт,
 * второе значит, что ссылка своё отработала и звать надо иначе.
 */
export type VoiceRefusal = 'video-off' | 'screen-share-off' | 'room-full' | 'guests-full';

/** Отказ в голосе — тому, кому отказали. */
export interface VoiceRefusedRelay {
  reason: VoiceRefusal;
}

/**
 * Снимок действующих настроек, каким его видит браузер: то, что отдаёт
 * `SettingsService.snapshot()`, — без единого секрета (каталог заменяет их
 * признаком «задано»).
 *
 * Тип объявлен здесь, а не выведен из каталога, по общей конвенции контракта:
 * api не зависит от `@relay/shared`, и совпадение половин держит тест, а не
 * общий импорт. Уезжает снимок двумя дорогами — полем `settings` в
 * `GET /api/config` и событием `settings` в сокете.
 */
export type SettingsSnapshot = Record<string, SettingValue>;

/**
 * Что случилось — так, как это называет журнал.
 *
 * Список закрыт намеренно: панель подбирает по этому имени подпись строки, и
 * незнакомое действие она нарисовала бы пустотой. Имя строкой, а не числом, —
 * журнал переживает и обновления, и правки каталога, и читают его глазами.
 *
 * Сегодня пишутся первые шесть. Остальные заведёт тот код, который их
 * совершает: смена пароля инсталляции и действия вкладки «Обслуживание».
 * Объявлены заранее не для красоты — панель показывает журнал целиком, и
 * добавлять действие вместе с обработчиком дешевле, чем гадать, почему строка
 * без подписи.
 */
export type AuditAction =
  | 'setting-changed'
  | 'settings-reset'
  | 'ban'
  | 'unban'
  | 'owner-claimed'
  | 'owner-link-issued'
  | 'password-changed'
  | 'retention-run'
  | 'files-swept'
  | 'sessions-revoked'
  | 'device-revoked'
  | 'settings-imported';

/**
 * Ник в системной записи — той, у которой автора-человека нет вовсе (ссылку
 * владельца печатает `relay owner-link` с машины, ретенция ходит по таймеру).
 * Колонка ника не пустует: строка «кто-то закрыл регистрацию» без имени
 * читается хуже, чем строка с честным «system».
 *
 * Узнавать систему ПО ЭТОМУ ТЕКСТУ нельзя — для этого есть `system`.
 */
export const SYSTEM_ACTOR_NICK = 'system';

/**
 * Ник, когда автор известен отпечатком, а имени не нашлось: личность успела
 * исчезнуть между действием и записью. Случай редкий до невозможности, но
 * терять из-за него саму запись нельзя — «действие было» важнее, чем «мы знаем,
 * как его звали».
 */
export const UNKNOWN_ACTOR_NICK = 'unknown';

/** Курсор страницы журнала: время и id последней показанной строки. */
export interface AuditCursor {
  at: number;
  id: string;
}

/**
 * Строка журнала, как её читает панель.
 *
 * `actorNick` — снимок имени НА МОМЕНТ ДЕЙСТВИЯ, как в цитатах и упоминаниях:
 * человек переименуется, а «Ким закрыл регистрацию» обязано остаться читаемым.
 *
 * `actor` — отпечаток ключа: лицо в списке. Его нет у системной записи и у той,
 * чья личность с тех пор удалена. Различает эти два случая `system`, и только
 * он: узнавать систему по тексту ника нельзя — человек, назвавшийся так же,
 * подделал бы системную запись.
 */
export interface AuditEntry {
  id: string;
  /** Когда, миллисекундами. Он же половина курсора страницы. */
  at: number;
  actor?: string;
  actorNick: string;
  /** Действовала машина, а не человек. */
  system?: true;
  action: AuditAction;
  /** На кого подействовали: ключ настройки, группа, отпечаток забаненного. */
  target?: string;
  /** Подробности: «было/стало» у настройки, имя и охват у бана. */
  detail: Record<string, unknown>;
}

/**
 * Тебя забанили. Тело появилось у события, у которого его не было: владелец
 * может объяснить причину словами (`moderation.banNotice`), и объяснение
 * обязано доехать до того, кого выгнали, — иначе он узнаёт только факт.
 *
 * Поле необязательное, и пустой текст настройки НЕ уезжает пустой строкой:
 * событие остаётся ровно таким, каким было, пока владелец ничего не написал.
 */
export interface BannedRelay {
  notice?: string;
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

/** Собеседник в ЛС: лицо рисуется по отпечатку, подпись — ником. */
export interface DmPeer {
  fingerprint: string;
  nick: string;
}

/** Человек в списке выбора собеседника: тот же собеседник и когда его видели. */
export interface DmPerson extends DmPeer {
  lastSeenTs: number;
}

/** Строка раздела ЛС — беседа со своим адресом и превью последней реплики. */
export interface DmConversation {
  slug: string;
  peer: DmPeer;
  lastTs: number;
  preview: string;
  previewMine: boolean;
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

// ── Админ-панель ────────────────────────────────────────────────────────────

/**
 * Протокол панели владельца — половина сервера; половина клиента живёт в
 * `packages/shared/src/admin.ts`, и совпадение половин держит тест.
 *
 * Тела, как и везде здесь, объявлены `unknown`: панель шлёт их тем же
 * socket.io, что и всё остальное, и «это же наш собственный экран» проверкой
 * не считается.
 *
 * ПАНЕЛЬ ТОЛЬКО ДЛЯ ВЛАДЕЛЬЦА, и владение проверяет каждый обработчик сам —
 * см. `admin.handlers.ts`.
 */

/** Действие панели — то, что делают кнопкой, а не полем. */
export type AdminAction =
  | 'owner-link'
  | 'retention-run'
  | 'files-sweep'
  | 'revoke-sessions'
  | 'revoke-device'
  | 'ban'
  | 'unban'
  | 'export'
  | 'import';

/**
 * Почему панели отказали. Шесть причин посередине — причины каталога
 * (`SettingError`), и они обязаны входить сюда целиком: обработчик возвращает
 * их как есть, и седьмая причина каталога не соберётся, пока её не назовут и
 * здесь.
 *
 * Список общий на все события панели: отказ она показывает одним и тем же
 * способом, и второй перечень разошёлся бы с первым.
 */
export type AdminRefusal =
  | 'forbidden'
  | 'needs-confirm'
  | 'unknown-key'
  | 'read-only'
  | 'wrong-type'
  | 'out-of-range'
  | 'not-an-option'
  | 'too-long'
  | 'secret-path'
  | 'not-found'
  | 'unsupported';

export interface AdminSetPayload {
  key?: unknown;
  value?: unknown;
  confirm?: unknown;
}

export interface AdminResetPayload {
  group?: unknown;
  confirm?: unknown;
}

export interface AdminPeoplePayload {
  query?: unknown;
  cursor?: unknown;
}

export interface AdminAuditPayload {
  cursor?: unknown;
}

export interface AdminActionPayload {
  action?: unknown;
  target?: unknown;
  confirm?: unknown;
  values?: unknown;
}

/**
 * Смена пароля инсталляции. Своё событие, а не поле в `admin-set` и не
 * действие: пароль — единственный параметр, который одновременно секрет,
 * хэшируется и отзывает всё выданное, и ехать ему в теле, общем с баном и
 * импортом, незачем.
 */
export interface AdminPasswordPayload {
  password?: unknown;
  confirm?: unknown;
}

/** Политика хранения так, как её показывает сводка. */
export interface AdminRetention {
  mode: RetentionMode;
  days?: number;
}

/** Сводка: то, что владелец видит первым. Считается запросами, а не счётчиками. */
export interface AdminOverview {
  people: number;
  online: number;
  bans: number;
  messages: number;
  servers: number;
  channels: number;
  storageBytes: number;
  storageQuotaBytes: number;
  retention: AdminRetention;
  directRetention: AdminRetention | null;
  version: string;
}

/** Устройство человека — так, как его видит владелец в таблице людей. */
export interface AdminDevice {
  id: string;
  name: string;
  lastSeenAt: number | null;
  revoked: boolean;
}

/**
 * Человек в таблице людей. Id личности наружу не уходит: в протоколе человека
 * называет отпечаток, он же ручка для бана (см. `gateway/ownership`).
 */
export interface AdminPerson {
  fingerprint: string;
  nick: string;
  createdAt: number;
  lastSeenAt: number | null;
  devices: AdminDevice[];
  banned: boolean;
  owner: boolean;
}

/** Выгрузка настроек. Секретов в ней нет вовсе — ни значением, ни признаком. */
export interface AdminExport {
  protocol: number;
  at: number;
  values: SettingsSnapshot;
}

export interface AdminImportRejection {
  key: string;
  reason: AdminRefusal;
}

export type AdminStateResult =
  | {
      ok: true;
      catalog: SettingSpec[];
      values: SettingsSnapshot;
      overview: AdminOverview;
    }
  | { ok: false; error: AdminRefusal };

export type AdminSetResult =
  | { ok: true; key: string; changed: boolean; value: SettingValue }
  | { ok: false; error: AdminRefusal };

export type AdminResetResult =
  | { ok: true; group: SettingGroup; changed: string[]; values: SettingsSnapshot }
  | { ok: false; error: AdminRefusal };

export type AdminPeopleResult =
  | { ok: true; people: AdminPerson[]; cursor?: string }
  | { ok: false; error: AdminRefusal };

export type AdminBansResult = { ok: true; bans: BanEntry[] } | { ok: false; error: AdminRefusal };

export type AdminAuditResult =
  | { ok: true; entries: AuditEntry[]; more: boolean }
  | { ok: false; error: AdminRefusal };

export type AdminActionResult =
  | {
      ok: true;
      action: AdminAction;
      /** Ключ владельца — единственный раз, когда он существует в читаемом виде. */
      link?: { token: string; expiresAt: number };
      settings?: AdminExport;
      imported?: { applied: string[]; rejected: AdminImportRejection[] };
      count?: number;
    }
  | { ok: false; error: AdminRefusal };

export type AdminPasswordResult =
  | { ok: true; set: boolean; changed: boolean; count: number }
  | { ok: false; error: AdminRefusal };

/** Настройку поменяли из другой сессии владельца — только его собственным сокетам. */
export interface AdminChangedRelay {
  keys: string[];
  values: SettingsSnapshot;
}

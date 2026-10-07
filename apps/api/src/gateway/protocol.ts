import { LIMITS } from '@relay/shared';
import type * as wire from '@relay/shared';
import type { Untrusted } from '@relay/shared';

/**
 * Форма сообщений сигналинга со стороны сервера.
 *
 * Контракт один — `@relay/shared`. Ответы и рассылки (`*Result`, `*Relay`)
 * сервер отдаёт ровно в тех типах, что читает клиент, и берёт их оттуда же.
 *
 * Тела, которые присылает клиент (`*Payload`), здесь те же по форме, но с
 * `unknown` в каждом поле (`Untrusted`): тело события socket.io не проверяет
 * никто, и обработчик обязан считать его враньём до первой проверки. Тип
 * говорит, какие поля бывают, а гарантию даёт разбор (`str`/`trimmed`/
 * `optional`).
 */

export { PROTOCOL_VERSION, SYSTEM_ACTOR_NICK, UNKNOWN_ACTOR_NICK } from '@relay/shared';

export type {
  Untrusted,
  AdminAction,
  AdminActionResult,
  AdminAuditResult,
  AdminBansResult,
  AdminChangedRelay,
  AdminDevice,
  AdminExport,
  AdminImportRejection,
  AdminOverview,
  AdminPasswordResult,
  AdminPeopleResult,
  AdminPerson,
  AdminRefusal,
  AdminResetResult,
  AdminRetention,
  AdminSetResult,
  AdminStateResult,
  AuditAction,
  AuditCursor,
  AuditEntry,
  BanEntry,
  BannedRelay,
  CallEndedRelay,
  CallIncomingRelay,
  CallMark,
  CallPerson,
  CallRefusal,
  CallReplyResult,
  CallStartResult,
  CallStateRelay,
  ChannelCreateResult,
  ChannelDeleteResult,
  ChannelRenameResult,
  ChannelStatsResult,
  ChatHistoryMoreResult,
  ChatHistoryPage,
  ChatMessage,
  ChatPinResult,
  ChatPinsResult,
  ChatRefusal,
  ChatRefusedRelay,
  ChatSearchResult,
  ChatWindowResult,
  DmConversation,
  DmJoinResult,
  DmListResult,
  DmOpenResult,
  DmPeer,
  DmPeopleResult,
  DmPerson,
  GuestKickResult,
  InviteCreateResult,
  MentionRef,
  MentionSuggestResult,
  ModerationBansResult,
  ModerationResult,
  QuotaScope,
  ReactionMap,
  Reactor,
  ReplyRef,
  RosterPerson,
  ServerCreateResult,
  ServerDeleteResult,
  ServerStatsResult,
  SettingsSnapshot,
  SfuTokenResult,
  VoiceRefusal,
  VoiceRefusedRelay,
} from '@relay/shared';

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
 * панель не открывали. Числа, которые знает и клиент, берутся из `LIMITS`
 * контракта — у него поле участника зовётся `name`, а у слага `room`.
 */
export const LIMIT = {
  /** id сервера — его придумывает клиент, чтобы не ждать ответа. */
  id: 64,
  /** Имя сервера или канала. */
  name: 32,
  /** Тег участника. */
  tag: LIMITS.name,
  /** Слаг канала, он же имя комнаты. */
  slug: LIMITS.room,
  /**
   * Имя голосовой комнаты: слаг канала — либо адрес комнаты беседы, который
   * длиннее (`voice:` плюс двадцать семь знаков адреса — тридцать три).
   *
   * Отдельное число, а не поднятый `slug`: вокруг `slug` считается сам слаг
   * канала (`channelSlug` режет по нему имя и метку сервера), и подняв его, мы
   * удлинили бы имена каналов заодно. А обрежь мы комнату беседы по слагу —
   * принятый вызов сажал бы двоих в комнату с оторванным последним знаком,
   * которой в списке открытых нет.
   */
  room: 40,
  /** Значок сервера. */
  emoji: 8,
  /** Реплика чата. */
  message: LIMITS.chatText,
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

export type AdminActionPayload = Untrusted<wire.AdminActionPayload>;
export type AdminAuditPayload = Untrusted<wire.AdminAuditPayload>;
export type AdminPasswordPayload = Untrusted<wire.AdminPasswordPayload>;
export type AdminPeoplePayload = Untrusted<wire.AdminPeoplePayload>;
export type AdminResetPayload = Untrusted<wire.AdminResetPayload>;
export type AdminSetPayload = Untrusted<wire.AdminSetPayload>;
export type CallRingPayload = Untrusted<wire.CallRingPayload>;
export type CallStartPayload = Untrusted<wire.CallStartPayload>;
export type ChannelCreatePayload = Untrusted<wire.ChannelCreatePayload>;
export type ChannelDeletePayload = Untrusted<wire.ChannelDeletePayload>;
export type ChannelModePayload = Untrusted<wire.ChannelModePayload>;
export type ChannelRenamePayload = Untrusted<wire.ChannelRenamePayload>;
export type ChannelStatsPayload = Untrusted<wire.ChannelStatsPayload>;
export type ChatAroundPayload = Untrusted<wire.ChatAroundPayload>;
export type ChatDeletePayload = Untrusted<wire.ChatDeletePayload>;
export type ChatEditPayload = Untrusted<wire.ChatEditPayload>;
export type ChatHistoryAfterPayload = Untrusted<wire.ChatHistoryAfterPayload>;
export type ChatHistoryMorePayload = Untrusted<wire.ChatHistoryMorePayload>;
export type ChatPinPayload = Untrusted<wire.ChatPinPayload>;
export type ChatPinsPayload = Untrusted<wire.ChatPinsPayload>;
export type ChatReactPayload = Untrusted<wire.ChatReactPayload>;
export type ChatSearchPayload = Untrusted<wire.ChatSearchPayload>;
export type DmJoinPayload = Untrusted<wire.DmJoinPayload>;
export type DmOpenPayload = Untrusted<wire.DmOpenPayload>;
export type DmPeoplePayload = Untrusted<wire.DmPeoplePayload>;
export type GuestKickPayload = Untrusted<wire.GuestKickPayload>;
export type InviteCreatePayload = Untrusted<wire.InviteCreatePayload>;
export type JoinPayload = Untrusted<wire.JoinPayload>;
export type MentionSuggestPayload = Untrusted<wire.MentionSuggestPayload>;
export type ModerationBanPayload = Untrusted<wire.ModerationBanPayload>;
export type ModerationBansPayload = Untrusted<wire.ModerationBansPayload>;
export type ModerationUnbanPayload = Untrusted<wire.ModerationUnbanPayload>;
export type PrefsSetPayload = Untrusted<wire.PrefsSetPayload>;
export type ReadMarkPayload = Untrusted<wire.ReadMarkPayload>;
export type ServerCreatePayload = Untrusted<wire.ServerCreatePayload>;
export type ServerDeletePayload = Untrusted<wire.ServerDeletePayload>;
export type ServerStatsPayload = Untrusted<wire.ServerStatsPayload>;
export type ServerUnlockPayload = Untrusted<wire.ServerUnlockPayload>;
export type SfuTokenPayload = Untrusted<wire.SfuTokenPayload>;
export type VoiceDiagPayload = Untrusted<wire.VoiceDiagPayload>;
export type ChatJoinPayload = Untrusted<wire.ChatJoinPayload>;
export type ChatMessagePayload = Untrusted<wire.ChatMessagePayload>;
/** `offer`, `answer`, `ice-candidate` и `screen-watch` — один разбор на четыре события. */
export type SignalPayload = Untrusted<
  wire.OfferPayload & wire.AnswerPayload & wire.IcePayload & wire.ScreenWatchPayload
>;

// ── Что сервер рассылает сам ────────────────────────────────────────────────

/**
 * Участник голосового канала в presence — так, как его собирает сервер: у
 * клиента поля необязательны (старый сервер мог их не прислать), у сервера
 * они есть всегда.
 */
export type VoicePresenceEntry = wire.VoicePeer &
  Required<Pick<wire.VoicePeer, 'name' | 'micOn' | 'deafened' | 'transport'>>;

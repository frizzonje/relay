/** Карты socket-событий: что клиент шлёт серверу и что сервер шлёт клиенту. */

import type {
  AdminActionPayload,
  AdminActionResult,
  AdminAuditPayload,
  AdminAuditResult,
  AdminBansResult,
  AdminChangedRelay,
  AdminPasswordPayload,
  AdminPasswordResult,
  AdminPeoplePayload,
  AdminPeopleResult,
  AdminResetPayload,
  AdminResetResult,
  AdminSetPayload,
  AdminSetResult,
  AdminStateResult,
} from './admin';
import type {
  CallEndedRelay,
  CallIncomingRelay,
  CallOverRelay,
  CallReplyResult,
  CallRingPayload,
  CallStartPayload,
  CallStartResult,
  CallStateRelay,
} from './call';
import type {
  ChatActivityRelay,
  ChatAroundPayload,
  ChatClosedRelay,
  ChatDeletePayload,
  ChatDeleteRelay,
  ChatEditPayload,
  ChatEditRelay,
  ChatHistoryAfterPayload,
  ChatHistoryMorePayload,
  ChatHistoryMoreResult,
  ChatHistoryPage,
  ChatJoinPayload,
  ChatMessage,
  ChatMessagePayload,
  ChatPinnedRelay,
  ChatPinPayload,
  ChatPinResult,
  ChatPinsPayload,
  ChatPinsResult,
  ChatReactionRelay,
  ChatReactPayload,
  ChatRefusedRelay,
  ChatSearchPayload,
  ChatSearchResult,
  ChatTypingRelay,
  ChatWindowResult,
  MentionSuggestPayload,
  MentionSuggestResult,
} from './chat';
import type { PersonOrGuest } from './common';
import type {
  DmActivityRelay,
  DmJoinPayload,
  DmJoinResult,
  DmListResult,
  DmOpenPayload,
  DmOpenResult,
  DmPeoplePayload,
  DmPeopleResult,
} from './dm';
import type {
  BannedRelay,
  ModerationBanPayload,
  ModerationBansPayload,
  ModerationBansResult,
  ModerationResult,
  ModerationUnbanPayload,
} from './moderation';
import type { PresenceEntry } from './presence';
import type {
  Channel,
  ChannelCreatePayload,
  ChannelCreateResult,
  ChannelDeletePayload,
  ChannelDeleteResult,
  ChannelModePayload,
  ChannelRenamePayload,
  ChannelRenameResult,
  ChannelStatsPayload,
  ChannelStatsResult,
  MentionRelay,
  MentionsRelay,
  PrefsRelay,
  PrefsSetPayload,
  ReadMarkPayload,
  ReadsRelay,
  Server,
  ServerCreatePayload,
  ServerCreateResult,
  ServerDeletePayload,
  ServerDeleteResult,
  ServerStatsPayload,
  ServerStatsResult,
  ServerUnlockPayload,
  ServerUnlockResult,
} from './registry';
import type { SettingsSnapshot } from './settings';
import type {
  AnswerPayload,
  AnswerRelay,
  GuestKickPayload,
  GuestKickResult,
  IcePayload,
  IceRelay,
  InviteCreatePayload,
  InviteCreateResult,
  JoinPayload,
  KickedRelay,
  MediaUpdatePayload,
  MediaUpdateRelay,
  OfferPayload,
  OfferRelay,
  PeerJoinedPayload,
  PeerLeftPayload,
  PeerRenamedRelay,
  RenamePayload,
  ScreenWatchPayload,
  ScreenWatchRelay,
  SfuTokenPayload,
  SfuTokenResult,
  VoiceDiagPayload,
  VoiceLockedRelay,
  VoiceModeRelay,
  VoicePeer,
  VoicePresence,
  VoiceRefusedRelay,
} from './voice';

/** Карта событий, отправляемых клиентом серверу. */
export interface ClientToServerEvents {
  join: (payload: JoinPayload) => void;
  leave: () => void;
  offer: (payload: OfferPayload) => void;
  answer: (payload: AnswerPayload) => void;
  'ice-candidate': (payload: IcePayload) => void;
  'screen-watch': (payload: ScreenWatchPayload) => void;
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
  /** Позвонить человеку. Ack называет id вызова либо причину отказа. */
  'call-start': (payload: CallStartPayload, cb: (res: CallStartResult) => void) => void;
  /** Принять входящий — право только у того, кому звонят. */
  'call-accept': (payload: CallRingPayload, cb: (res: CallReplyResult) => void) => void;
  /** Отклонить входящий. */
  'call-decline': (payload: CallRingPayload, cb: (res: CallReplyResult) => void) => void;
  /** Отбой звонящего — передумал, не дождавшись ответа. */
  'call-cancel': (payload: CallRingPayload, cb: (res: CallReplyResult) => void) => void;
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
  /** Открыть (или найти) переписку с этим отпечатком. */
  'dm-open': (payload: DmOpenPayload, cb: (res: DmOpenResult) => void) => void;
  /** Мои переписки — спрашивается при входе в раздел. */
  'dm-list': (cb: (res: DmListResult) => void) => void;
  /**
   * Сесть в ленту беседы. Отдельная дверь от `chat-join`: канал пускает по
   * видимости в реестре, беседа — по членству в паре.
   */
  'dm-join': (payload: DmJoinPayload, cb: (res: DmJoinResult) => void) => void;
  /** Кого инсталляция видела — список для выбора собеседника. */
  'dm-people': (payload: DmPeoplePayload, cb: (res: DmPeopleResult) => void) => void;
  /**
   * События админ-панели. Все с ack и все только для владельца: каждое
   * проверяет владение само, и «не владелец» — это `forbidden`, а не молчание.
   *
   * Их набор обязан совпадать с тем, что подписывает сервер
   * (`@SubscribeMessage('admin-…')` в `signaling.gateway.ts`): событие,
   * объявленное здесь и не заведённое там, — это кнопка, ждущая ответа, который
   * не придёт; заведённое там и не объявленное здесь — дверь, о которой не
   * знает ни один тест двери. Совпадение держит контрактный тест.
   */
  'admin-state': (cb: (res: AdminStateResult) => void) => void;
  'admin-set': (payload: AdminSetPayload, cb: (res: AdminSetResult) => void) => void;
  'admin-reset': (payload: AdminResetPayload, cb: (res: AdminResetResult) => void) => void;
  'admin-people': (payload: AdminPeoplePayload, cb: (res: AdminPeopleResult) => void) => void;
  'admin-bans': (cb: (res: AdminBansResult) => void) => void;
  'admin-audit': (payload: AdminAuditPayload, cb: (res: AdminAuditResult) => void) => void;
  'admin-action': (payload: AdminActionPayload, cb: (res: AdminActionResult) => void) => void;
  /** Пароль инсталляции — своя дорога: хэш, отзыв пропусков и разрыв сокетов. */
  'admin-password': (payload: AdminPasswordPayload, cb: (res: AdminPasswordResult) => void) => void;
}

/** Карта событий, отправляемых сервером клиенту. */
export interface ServerToClientEvents {
  peers: (peers: VoicePeer[]) => void;
  'peer-joined': (payload: PeerJoinedPayload) => void;
  'peer-left': (payload: PeerLeftPayload) => void;
  offer: (payload: OfferRelay) => void;
  answer: (payload: AnswerRelay) => void;
  'ice-candidate': (payload: IceRelay) => void;
  'screen-watch': (payload: ScreenWatchRelay) => void;
  'voice-presence': (presence: VoicePresence) => void;
  /**
   * Кто сейчас на связи во всей инсталляции — снимок на подключении. Приходит
   * только тому, кто предъявил личность: гостю по инвайту присутствия нет ни
   * одной стороной.
   */
  presence: (people: PresenceEntry[]) => void;
  /**
   * Изменившиеся записи присутствия — дельтой, а не снимком: картина на большой
   * инсталляции длиннее любого изменения в ней, а меняется она на каждый вход,
   * выход и звонок. Рассылка коалесцируется, поэтому в одном событии приезжает
   * пачка.
   */
  'presence-update': (changed: PresenceEntry[]) => void;
  /**
   * Тебе звонят — на все твои устройства сразу. Тост, а не модалка: вызов
   * должно быть можно проигнорировать, не бросая того, чем занят.
   */
  'call-incoming': (payload: CallIncomingRelay) => void;
  /**
   * Вызов жив: звонит (у звонящего) либо принят (у обоих). Принятие им же
   * гасит входящий на тех устройствах собеседника, которые не отвечали.
   */
  'call-state': (payload: CallStateRelay) => void;
  /**
   * Вызов кончился, не став разговором. Уходит ОБЕИМ сторонам: «не ответили»
   * собеседник обязан узнать не меньше звонившего — иначе у него просто молча
   * пропадает входящий.
   */
  'call-ended': (payload: CallEndedRelay) => void;
  /**
   * Разговор кончился: собеседник вышел из комнаты беседы — или разговор
   * переехал на другое устройство человека. Из комнаты сервер уже вывел; это
   * событие говорит вкладке снять экран звонка и отпустить микрофон.
   */
  'call-over': (payload: CallOverRelay) => void;
  chat: (message: ChatMessage) => void;
  'chat-history': (page: ChatHistoryPage) => void;
  /**
   * Кто сейчас в текстовом канале. Люди, а не имена: список из одних имён не
   * отличает двух «Ань». Отпечаток заодно ключ строки — одна личность с двух
   * устройств стоит одной строкой; гость без ключа — сам по себе.
   */
  'chat-roster': (people: PersonOrGuest[]) => void;
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
  /**
   * Сказанное не принято, и вот почему. Летит только отказанному: события ленты
   * ответа не ждут, и без этого «нажал, и ничего не произошло» было бы всем,
   * что человек узнаёт о выключенной правке или о слове из чёрного списка.
   */
  'chat-refused': (payload: ChatRefusedRelay) => void;
  'media-update': (payload: MediaUpdateRelay) => void;
  /** Участник голосовой комнаты сменил тег (обновить подпись плитки). */
  'peer-renamed': (payload: PeerRenamedRelay) => void;
  /**
   * Действующие настройки инсталляции — на подключении и при каждом изменении,
   * всем сокетам одинаково.
   *
   * Снимком целиком, а не правкой одного ключа, по той же причине, что у
   * реестра серверов: вкладка, пережившая обрыв, обязана получить действующее
   * состояние, а не догонять пропущенные патчи. Настройка, доезжающая только
   * после перезагрузки, — половина настройки.
   */
  settings: (snapshot: SettingsSnapshot) => void;
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
   * не пустят. Показать экран вместо молчащего приложения обязательно.
   *
   * Тело необязательное: владелец мог объяснить причину словами
   * (`moderation.banNotice`), а мог и не объяснять — и тогда событие приходит
   * таким же пустым, каким приходило всегда.
   */
  banned: (payload?: BannedRelay) => void;
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
  /**
   * В голосе отказали, и вот почему: канал полон, гостей по ссылке больше не
   * пускают, камера или демонстрация экрана выключены владельцем. Летит только
   * отказанному — событиям голоса ответа не положено, а `join` без этого
   * неотличим от удавшегося.
   */
  'voice-refused': (payload: VoiceRefusedRelay) => void;
  /** В одной из моих переписок написали. Только двоим участникам. */
  'dm-activity': (payload: DmActivityRelay) => void;
  /**
   * Настройку поменяли из ДРУГОЙ сессии владельца. Летит только его сокетам:
   * панель, открытая на втором устройстве, обязана обновиться, иначе она
   * сохранит поверх свежей правки то, что показывала минуту назад.
   */
  'admin-changed': (payload: AdminChangedRelay) => void;
}

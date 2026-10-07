/** Голос: WebRTC-сигналинг mesh, медиа-состояние, гости, отказы. */

import type { VoiceMode } from './registry';

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

/** Прямой канал: смотрю ли я трансляцию адресата («Смотреть» / «Перестать»). */
export interface ScreenWatchPayload {
  to: string;
  on: boolean;
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

export interface ScreenWatchRelay {
  from: string;
  on: boolean;
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
 *
 * `not-in-call` — комната беседы: разговор двоих, и спрашивающий не один из
 * них (либо разговора уже нет вовсе). Два этих случая нарочно отвечают
 * одинаково: разбери их сервер по-разному, посторонний узнавал бы, что беседа
 * с таким адресом существует.
 */
export type VoiceRefusal =
  | 'video-off'
  | 'screen-share-off'
  | 'room-full'
  | 'guests-full'
  | 'not-in-call';

/** Отказ в голосе — тому, кому отказали. */
export interface VoiceRefusedRelay {
  reason: VoiceRefusal;
}

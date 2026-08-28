/**
 * Все настройки инсталляции — одним списком.
 *
 * Списком, а не набором полей на экране, ровно по одной причине: параметров
 * почти сотня, и у каждого есть тип, границы и вопрос «когда подействует».
 * Разметить это руками в интерфейсе значит завести сотню мест, где проверка
 * значения и само значение разъедутся, — причём разъедутся молча, потому что
 * ошибётся здесь не программа, а человек, дописавший сто первое поле.
 *
 * Поэтому каталог — контракт. Сервер по нему проверяет запись, панель по нему
 * же рисует контролы и подписи, журнал берёт из него имя параметра, а
 * импорт-экспорт — список того, что вообще бывает. Добавить параметр — значит
 * добавить сюда строку; больше нигде ничего дописывать не нужно.
 *
 * Умолчание каждого параметра равно тому, как relay вёл себя до появления
 * панели. Инсталляция, где владелец не открывал её ни разу, обязана работать
 * ровно как прежде, и это проверяется тестом, а не обещанием: числа в
 * `fallback` сверены с константами кода (NICK_MAX, LIMITS.chatText,
 * MAX_UPLOAD_BYTES и прочими), а не переписаны из плана на глаз.
 *
 * Проверка (`validateSetting`) — чистая функция: ни базы, ни `process.env`, ни
 * времени. Её зовут и сервер перед записью, и браузер перед отправкой, и тест;
 * загляни она хоть раз в окружение — три ответа разъехались бы на четвёртый.
 */

import type { AttachmentKind } from './index';

/**
 * Вид значения. От него зависит и контрол в панели, и правила проверки.
 *
 * `bytes` — то же число, но показывается человеческими «25 МБ»; выделен, чтобы
 * панель не гадала по имени ключа. `secret` — значение, которое наружу не
 * уходит никогда: панель видит только признак «задано».
 */

export type SettingKind =
  | 'boolean'
  | 'number'
  | 'bytes'
  | 'text'
  | 'multiline'
  | 'select'
  | 'list'
  | 'secret';

/** Группа = вкладка панели. Порядок здесь — порядок вкладок. */
export type SettingGroup =
  | 'access'
  | 'people'
  | 'moderation'
  | 'messages'
  | 'files'
  | 'direct'
  | 'spaces'
  | 'voice'
  | 'invites'
  | 'appearance'
  | 'notifications'
  | 'maintenance';

/**
 * Когда правка подействует. Разметка честная и видна рядом с полем: молчаливое
 * «настройка сохранена», после которого ничего не изменилось до перезапуска, —
 * худший вид вранья, потому что человек идёт искать поломку не там.
 */
export type SettingApplies = 'now' | 'new' | 'restart' | 'env';

export type SettingValue = boolean | number | string | string[];

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  fallback: SettingValue;
  applies: SettingApplies;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** Значение никогда не уходит наружу — только признак «задано». */
  secret?: boolean;
  /** Правка просит подтверждения. */
  danger?: boolean;
  /** Откуда берётся начальное значение при первом старте. */
  env?: string;
  /** Значение живёт в окружении и в панели только показывается. */
  readOnly?: boolean;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  'access',
  'people',
  'moderation',
  'messages',
  'files',
  'direct',
  'spaces',
  'voice',
  'invites',
  'appearance',
  'notifications',
  'maintenance',
];

// Байты пишем степенями двойки и словами: «26214400» в столбце умолчаний не
// читается никем, а ошибку в нуле не видно даже при вычитке.
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

/**
 * Потолки ввода для текста. Это защита от мегабайта в поле, а не политика:
 * решение «сколько уместно» принимает владелец, а каталог лишь не даёт
 * положить в таблицу то, что потом не покажет ни один экран.
 */
const NOTICE_MAX = 2000;
const RULES_MAX = 8000;
const SECRET_MAX = 256;
const URL_MAX = 500;
/**
 * Виды вложений, какие существуют. Импорт типа (стирается при сборке, цикла с
 * `index.ts` не заводит) плюс `satisfies` — единственный способ не дать этому
 * списку разойтись с тем, что раскладывает по видам сервер.
 */
const ATTACHMENT_KINDS = ['image', 'audio', 'file'] as const satisfies readonly AttachmentKind[];

/** Столько слов помещается в фильтр и столько букв — в одно слово. */
const LIST_MAX = 500;
const LIST_ITEM_MAX = 100;

/**
 * Текст про приватность бесед — тот же, что этап A показывает в шапке ЛС
 * (ключ `dm.privacy`, apps/web/lib/i18n/messages/en.json). Владелец волен его
 * переписать, но умолчание обязано совпадать с тем, что человек видит сегодня:
 * обещание приватности, разъехавшееся с интерфейсом, хуже отсутствующего.
 */
const DM_PRIVACY_NOTICE =
  "Direct messages are addressed to one person, but they aren't hidden from the installation's owner.";

export const SETTINGS: readonly SettingSpec[] = [
  // ── access — доступ ──────────────────────────────────────────────────────
  /**
   * Пароль инсталляции. Хранится хэшем, наружу уходит признаком «задано»;
   * `.env` остаётся резервом на случай пустой таблицы (SITE_PASSWORD).
   * Значение — строка (новый пароль), а не флажок: флажком пароль не сменишь,
   * а «задано/не задано» панель считает сама из непустоты.
   */
  {
    key: 'access.sitePasswordSet',
    group: 'access',
    kind: 'secret',
    fallback: '',
    applies: 'now',
    max: SECRET_MAX,
    secret: true,
    danger: true,
    env: 'SITE_PASSWORD',
  },
  {
    key: 'access.sitePasswordEnabled',
    group: 'access',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'access.identityCreation',
    group: 'access',
    kind: 'select',
    fallback: 'open',
    applies: 'new',
    options: ['open', 'invite', 'closed'],
  },
  {
    key: 'access.maxDevicesPerIdentity',
    group: 'access',
    kind: 'number',
    fallback: 8,
    applies: 'now',
    min: 1,
    max: 64,
  },
  {
    key: 'access.deviceApprovalRequired',
    group: 'access',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Ровно TOKEN_TTL_MS (30 дней) — срок жизни пропуска сегодня.
  {
    key: 'access.sessionTtlDays',
    group: 'access',
    kind: 'number',
    fallback: 30,
    applies: 'new',
    min: 1,
    max: 365,
  },
  // Восемь — это FREE_FAILS в gateway/unlock.ts и MAX_ATTEMPTS в auth.controller.
  {
    key: 'access.unlockAttempts',
    group: 'access',
    kind: 'number',
    fallback: 8,
    applies: 'now',
    min: 1,
    max: 50,
  },
  // Пять минут — COOLDOWN_MAX_MS в gateway/unlock.ts: докуда сегодня растёт
  // простой после череды неудачных паролей.
  {
    key: 'access.unlockLockoutMinutes',
    group: 'access',
    kind: 'number',
    fallback: 5,
    applies: 'now',
    min: 1,
    max: 1440,
  },
  {
    key: 'access.loginRatePerMinute',
    group: 'access',
    kind: 'number',
    fallback: 20,
    applies: 'now',
    min: 1,
    max: 600,
  },
  {
    key: 'access.newIdentityQuietMinutes',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1440,
  },
  { key: 'access.guestsEnabled', group: 'access', kind: 'boolean', fallback: true, applies: 'now' },
  {
    key: 'access.blockNewIdentities',
    group: 'access',
    kind: 'boolean',
    fallback: false,
    applies: 'new',
  },

  // ── people — люди ────────────────────────────────────────────────────────
  {
    key: 'people.nickMinLength',
    group: 'people',
    kind: 'number',
    fallback: 1,
    applies: 'now',
    min: 1,
    max: 32,
  },
  // NICK_MAX = 20 и в @relay/shared, и в identity/crypto.ts сервера: длиннее
  // ник не помещается ни в ленту, ни в список участников.
  {
    key: 'people.nickMaxLength',
    group: 'people',
    kind: 'number',
    fallback: 20,
    applies: 'now',
    min: 1,
    max: 64,
  },
  {
    key: 'people.nickChangeCooldownMinutes',
    group: 'people',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1440,
  },
  {
    key: 'people.showFingerprints',
    group: 'people',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'people.lastSeenVisible',
    group: 'people',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Ноль — не чистить: сегодня личности не удаляются по бездействию вовсе.
  {
    key: 'people.pruneInactiveDays',
    group: 'people',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 3650,
  },

  // ── moderation — модерация ───────────────────────────────────────────────
  // Двадцать реплик в секунду и всплеск в сорок — это RL_REFILL_PER_SEC и
  // RL_CAPACITY общего лимитера (gateway/perimeter.ts): столько сервер
  // принимает от одного сокета сегодня. Потолок равен умолчанию по той же
  // причине, что и у размера загрузки: выше общий лимитер всё равно не пустит,
  // и поле, которое вверх не двигается, не должно этого обещать.
  {
    key: 'moderation.messageRatePerMinute',
    group: 'moderation',
    kind: 'number',
    fallback: 1200,
    applies: 'now',
    min: 1,
    max: 1200,
  },
  {
    key: 'moderation.messageBurst',
    group: 'moderation',
    kind: 'number',
    fallback: 40,
    applies: 'now',
    min: 1,
    max: 40,
  },
  {
    key: 'moderation.allowEdit',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Ноль — без предела: сегодня правка не протухает.
  {
    key: 'moderation.editWindowMinutes',
    group: 'moderation',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 10080,
  },
  {
    key: 'moderation.allowDelete',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'moderation.bannedWords',
    group: 'moderation',
    kind: 'list',
    fallback: [],
    applies: 'now',
    max: LIST_MAX,
  },
  {
    key: 'moderation.bannedWordsAction',
    group: 'moderation',
    kind: 'select',
    fallback: 'block',
    applies: 'now',
    options: ['block', 'flag'],
  },
  {
    key: 'moderation.linksAllowed',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Восемь — LIMIT.mentions в gateway/protocol.ts: больше сервер и сегодня не
  // принимает, лишние имена просто не доезжают.
  {
    key: 'moderation.maxMentionsPerMessage',
    group: 'moderation',
    kind: 'number',
    fallback: 8,
    applies: 'now',
    min: 0,
    max: 50,
  },
  {
    key: 'moderation.readOnlyMode',
    group: 'moderation',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
    danger: true,
  },
  {
    key: 'moderation.serverOwnersCanBan',
    group: 'moderation',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'moderation.banNotice',
    group: 'moderation',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
  },

  // ── messages — сообщения и хранение ──────────────────────────────────────
  /**
   * Режим хранения и число дней засеваются одной переменной `RETENTION_DAYS`
   * (её разбирает db/retention.service.ts): она задаёт и то, и другое сразу.
   * Повесь `env` только на режим — и инсталляция с `RETENTION_DAYS=30` после
   * обновления начала бы удалять переписку через четырнадцать дней.
   */
  {
    key: 'messages.retentionMode',
    group: 'messages',
    kind: 'select',
    fallback: 'days',
    applies: 'now',
    options: ['days', 'forever', 'ephemeral'],
    danger: true,
    env: 'RETENTION_DAYS',
  },
  {
    key: 'messages.retentionDays',
    group: 'messages',
    kind: 'number',
    fallback: 14,
    applies: 'now',
    min: 1,
    max: 3650,
    env: 'RETENTION_DAYS',
  },
  // LIMITS.chatText — столько сервер принимает от клиента сегодня.
  {
    key: 'messages.maxLength',
    group: 'messages',
    kind: 'number',
    fallback: 500,
    applies: 'now',
    min: 1,
    max: 8000,
  },
  {
    key: 'messages.pageSize',
    group: 'messages',
    kind: 'number',
    fallback: 50,
    applies: 'new',
    min: 10,
    max: 200,
  },
  {
    key: 'messages.pinLimit',
    group: 'messages',
    kind: 'number',
    fallback: 50,
    applies: 'now',
    min: 0,
    max: 500,
  },
  {
    key: 'messages.searchEnabled',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.reactionsEnabled',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.typingIndicator',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.systemMessages',
    group: 'messages',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'messages.replyPreviewLength',
    group: 'messages',
    kind: 'number',
    fallback: 120,
    applies: 'now',
    min: 20,
    max: 500,
  },

  // ── files — файлы ────────────────────────────────────────────────────────
  { key: 'files.uploadsEnabled', group: 'files', kind: 'boolean', fallback: true, applies: 'now' },
  // MAX_UPLOAD_BYTES = 25 МиБ, и это же потолок настройки: поле УЖИМАЕТ предел,
  // поднять его не может. Выше 25 МиБ не пустят двое, и оба — не эта проверка:
  // multer обрывает тело на своём `limits.fileSize`, заданном при разборе
  // декоратора (upload.controller.ts), а браузер отказывает ещё раньше по общей
  // константе. Поднять потолок — работа на обе стороны сразу; предложить здесь
  // гигабайт значило бы показать владельцу поле, которое вверх не двигается.
  {
    key: 'files.maxUploadBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 25 * MIB,
    applies: 'now',
    min: 1 * KIB,
    max: 25 * MIB,
  },
  // Виды — ровно те, что различает detectKind (apps/api/src/uploads.ts): картинка,
  // mp3 и всё остальное. Четвёртым тут стояло «video», которого в коде нет: ролик
  // сегодня приезжает как `file`, и снятая галочка «видео» не сделала бы ничего,
  // а снятая «файл» молча унесла бы с роликами и pdf. `satisfies` держит список
  // на замке: расширится AttachmentKind — не соберётся каталог.
  {
    key: 'files.allowedKinds',
    group: 'files',
    kind: 'list',
    fallback: [...ATTACHMENT_KINDS],
    applies: 'now',
    options: ATTACHMENT_KINDS,
    max: ATTACHMENT_KINDS.length,
  },
  { key: 'files.imagePreviews', group: 'files', kind: 'boolean', fallback: true, applies: 'now' },
  // Ноль — без квоты: сегодня никто ничего не считает.
  {
    key: 'files.perIdentityDailyBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1 * TIB,
  },
  {
    key: 'files.installQuotaBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1 * TIB,
  },
  {
    key: 'files.orphanSweepHours',
    group: 'files',
    kind: 'number',
    fallback: 24,
    applies: 'now',
    min: 1,
    max: 720,
  },
  {
    key: 'files.blockExecutables',
    group: 'files',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  { key: 'files.spoilerAllowed', group: 'files', kind: 'boolean', fallback: true, applies: 'now' },

  // ── direct — личные сообщения ────────────────────────────────────────────
  { key: 'direct.enabled', group: 'direct', kind: 'boolean', fallback: true, applies: 'now' },
  {
    key: 'direct.whoCanStart',
    group: 'direct',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'seen-together', 'nobody'],
  },
  // Ноль — без предела, как у квот на файлы: сегодня первых реплик никто не
  // считает, и умолчание обязано значить ровно это, а не «сотня в час». Счёт
  // идёт только по первым репликам незнакомцу — разговор с ответившим не
  // ограничен ничем. «Совсем нельзя писать первым» — это не ноль здесь, а
  // `direct.whoCanStart: nobody`; двух способов сказать одно и то же не нужно.
  {
    key: 'direct.firstMessagesPerHour',
    group: 'direct',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 100,
  },
  {
    key: 'direct.attachmentsAllowed',
    group: 'direct',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'direct.retentionMode',
    group: 'direct',
    kind: 'select',
    fallback: 'inherit',
    applies: 'now',
    options: ['inherit', 'days', 'forever', 'ephemeral'],
  },
  {
    key: 'direct.retentionDays',
    group: 'direct',
    kind: 'number',
    fallback: 14,
    applies: 'now',
    min: 1,
    max: 3650,
  },
  {
    key: 'direct.privacyNotice',
    group: 'direct',
    kind: 'multiline',
    fallback: DM_PRIVACY_NOTICE,
    applies: 'now',
    max: NOTICE_MAX,
  },
  {
    key: 'direct.blockFromBanned',
    group: 'direct',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },

  // ── spaces — серверы и каналы ────────────────────────────────────────────
  {
    key: 'spaces.creationAllowed',
    group: 'spaces',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'owner'],
  },
  // MAX_SERVERS_PER_PERSON = 5, MAX_SERVERS = 50, MAX_CHANNELS_PER_SERVER = 25
  // — потолки реестра (gateway/registry.service.ts). Ноль в личном потолке —
  // «своих серверов заводить нельзя».
  {
    key: 'spaces.maxServersPerIdentity',
    group: 'spaces',
    kind: 'number',
    fallback: 5,
    applies: 'now',
    min: 0,
    max: 100,
  },
  {
    key: 'spaces.maxServersInstall',
    group: 'spaces',
    kind: 'number',
    fallback: 50,
    applies: 'now',
    min: 1,
    max: 1000,
  },
  {
    key: 'spaces.maxChannelsPerServer',
    group: 'spaces',
    kind: 'number',
    fallback: 25,
    applies: 'now',
    min: 1,
    max: 500,
  },
  {
    key: 'spaces.lockedServersAllowed',
    group: 'spaces',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Канал, заведённый без явного режима, сегодня прямой (mode не проставлен).
  {
    key: 'spaces.defaultVoiceMode',
    group: 'spaces',
    kind: 'select',
    fallback: 'p2p',
    applies: 'new',
    options: ['p2p', 'sfu'],
  },
  {
    key: 'spaces.maxVoiceOccupants',
    group: 'spaces',
    kind: 'number',
    fallback: 20,
    applies: 'now',
    min: 2,
    max: 100,
  },
  // LIMIT.name = 32 — столько сервер принимает в имени сервера или канала.
  {
    key: 'spaces.channelNameMaxLength',
    group: 'spaces',
    kind: 'number',
    fallback: 32,
    applies: 'now',
    min: 1,
    max: 64,
  },

  // ── voice — голос и медиа ────────────────────────────────────────────────
  { key: 'voice.videoEnabled', group: 'voice', kind: 'boolean', fallback: true, applies: 'now' },
  {
    key: 'voice.screenShareEnabled',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // 128 кбит/с — MIC_AUDIO_MAX_BITRATE, 2500 — VIDEO_MAX_BITRATE
  // (apps/web/lib/voice/mesh/senders.ts): столько потоки берут сегодня.
  {
    key: 'voice.audioBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 128,
    applies: 'new',
    min: 8,
    max: 256,
  },
  {
    key: 'voice.videoBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 2500,
    applies: 'new',
    min: 100,
    max: 8000,
  },
  {
    key: 'voice.sfuThreshold',
    group: 'voice',
    kind: 'number',
    fallback: 4,
    applies: 'new',
    min: 2,
    max: 50,
  },
  {
    key: 'voice.noiseSuppressionDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'new',
  },
  {
    key: 'voice.pushToTalkDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: false,
    applies: 'new',
  },
  // Окно восстановления связи — RECOVER_WINDOW_MS в lib/voice/sfu/recovery.ts.
  {
    key: 'voice.iceRestartSeconds',
    group: 'voice',
    kind: 'number',
    fallback: 8,
    applies: 'new',
    min: 2,
    max: 60,
  },
  /**
   * Инфраструктура: адреса и секреты TURN и медиасервера. В панели показаны,
   * но не правятся, и это не осторожность, а правда — их читает не только api:
   * coturn и SFU поднимаются тем же `.env` рядом. Правка в таблице разошлась бы
   * с тем, что реально слушает порт, и это худший вид расхождения — звонок
   * собирается, а звука нет.
   */
  {
    key: 'voice.turnUrls',
    group: 'voice',
    kind: 'text',
    fallback: '',
    applies: 'env',
    max: URL_MAX,
    env: 'TURN_URLS',
    readOnly: true,
  },
  {
    key: 'voice.turnSecretSet',
    group: 'voice',
    kind: 'secret',
    fallback: '',
    applies: 'env',
    max: SECRET_MAX,
    secret: true,
    env: 'TURN_SECRET',
    readOnly: true,
  },
  {
    key: 'voice.sfuUrl',
    group: 'voice',
    kind: 'text',
    fallback: '',
    applies: 'env',
    max: URL_MAX,
    env: 'SFU_URL',
    readOnly: true,
  },
  {
    key: 'voice.sfuSecretSet',
    group: 'voice',
    kind: 'secret',
    fallback: '',
    applies: 'env',
    max: SECRET_MAX,
    secret: true,
    env: 'SFU_SECRET',
    readOnly: true,
  },

  // ── invites — приглашения и гости ────────────────────────────────────────
  { key: 'invites.enabled', group: 'invites', kind: 'boolean', fallback: true, applies: 'now' },
  // GUEST_TOKEN_TTL_MS — сутки.
  {
    key: 'invites.ttlHours',
    group: 'invites',
    kind: 'number',
    fallback: 24,
    applies: 'now',
    min: 1,
    max: 720,
  },
  {
    key: 'invites.whoCanInvite',
    group: 'invites',
    kind: 'select',
    fallback: 'everyone',
    applies: 'now',
    options: ['everyone', 'owner'],
  },
  {
    key: 'invites.maxGuestsPerChannel',
    group: 'invites',
    kind: 'number',
    fallback: 10,
    applies: 'now',
    min: 1,
    max: 100,
  },
  {
    key: 'invites.listenerByDefault',
    group: 'invites',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
  },
  // Час — GUEST_BAN_MS в gateway/perimeter.ts: столько выгнанный гость сегодня
  // не может вернуться по той же ссылке.
  {
    key: 'invites.guestKickCooldownMinutes',
    group: 'invites',
    kind: 'number',
    fallback: 60,
    applies: 'now',
    min: 1,
    max: 1440,
  },

  // ── appearance — вид инсталляции ─────────────────────────────────────────
  {
    key: 'appearance.installName',
    group: 'appearance',
    kind: 'text',
    fallback: 'relay',
    applies: 'now',
    max: 48,
  },
  {
    key: 'appearance.installEmoji',
    group: 'appearance',
    kind: 'text',
    fallback: '',
    applies: 'now',
    max: 8,
  },
  // Тёмная — историческая тема relay и единственная, которую ставит layout.tsx
  // до первого выбора человека (lib/theme.ts).
  {
    key: 'appearance.defaultTheme',
    group: 'appearance',
    kind: 'select',
    fallback: 'dark',
    applies: 'new',
    options: ['system', 'dark', 'light'],
  },
  {
    key: 'appearance.defaultLocale',
    group: 'appearance',
    kind: 'select',
    fallback: 'en',
    applies: 'new',
    options: ['en', 'ru'],
  },
  {
    key: 'appearance.loginNotice',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
  },
  {
    key: 'appearance.rulesText',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: RULES_MAX,
  },
  {
    key: 'appearance.showVersion',
    group: 'appearance',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },

  // ── notifications — уведомления ──────────────────────────────────────────
  {
    key: 'notifications.soundEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'notifications.desktopEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'notifications.mentionSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  {
    key: 'notifications.directSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },

  // ── maintenance — обслуживание ───────────────────────────────────────────
  {
    key: 'maintenance.mode',
    group: 'maintenance',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
    danger: true,
  },
  {
    key: 'maintenance.message',
    group: 'maintenance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
  },
  {
    key: 'maintenance.bannerText',
    group: 'maintenance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: 500,
  },
];

const BY_KEY = new Map<string, SettingSpec>(SETTINGS.map((spec) => [spec.key, spec]));

/** Описание параметра или `undefined`, если такого в каталоге нет. */
export function settingSpec(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * Снимок умолчаний. Каждый раз новый и со свежими копиями списков: снимок
 * уезжает в хранилище и в панель, и общий на всех массив кто-нибудь однажды
 * поправит на месте — а поправит он при этом сам каталог.
 */
export function defaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const spec of SETTINGS) {
    out[spec.key] = Array.isArray(spec.fallback) ? [...spec.fallback] : spec.fallback;
  }
  return out;
}

export type SettingError =
  | 'unknown-key'
  | 'read-only'
  | 'wrong-type'
  | 'out-of-range'
  | 'not-an-option'
  | 'too-long';

export type SettingCheck = { ok: true; value: SettingValue } | { ok: false; error: SettingError };

/** Число знаков, а не ячеек utf-16: эмодзи — один знак, а не два. */
function chars(text: string): number {
  return [...text].length;
}

/**
 * Проверка значения по каталогу: `ok` либо причина отказа.
 *
 * Причина возвращается разная не ради красоты сообщения: «не то» и «слишком
 * длинное» человек чинит по-разному, а «только чтение» не чинится вовсе, и
 * панели надо сказать об этом сразу, а не после сохранения.
 */
export function validateSetting(key: string, value: unknown): SettingCheck {
  const spec = settingSpec(key);
  if (!spec) return { ok: false, error: 'unknown-key' };
  // Инфраструктурное живёт в окружении. Отказ здесь, а не на экране: экран
  // легко забыть выключить, а мимо каталога запись не проходит.
  if (spec.readOnly) return { ok: false, error: 'read-only' };

  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'wrong-type' };

    case 'number':
    case 'bytes': {
      // Целое и конечное. `Number.isInteger` отсеивает и NaN, и бесконечность,
      // и «30» строкой — то есть ровно то, что приезжает из формы без разбора.
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, error: 'wrong-type' };
      }
      if (spec.min !== undefined && value < spec.min) return { ok: false, error: 'out-of-range' };
      if (spec.max !== undefined && value > spec.max) return { ok: false, error: 'out-of-range' };
      return { ok: true, value };
    }

    case 'select': {
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' };
      return spec.options?.includes(value)
        ? { ok: true, value }
        : { ok: false, error: 'not-an-option' };
    }

    case 'text':
    case 'multiline':
    case 'secret': {
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' };
      if (spec.max !== undefined && chars(value) > spec.max)
        return { ok: false, error: 'too-long' };
      return { ok: true, value };
    }

    case 'list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, error: 'wrong-type' };
      }
      const items = value as string[];
      if (spec.max !== undefined && items.length > spec.max)
        return { ok: false, error: 'too-long' };
      if (items.some((item) => chars(item) > LIST_ITEM_MAX))
        return { ok: false, error: 'too-long' };
      if (spec.options && items.some((item) => !spec.options?.includes(item))) {
        return { ok: false, error: 'not-an-option' };
      }
      // Копия: список уезжает в хранилище, а пришедший массив принадлежит
      // вызывающему и может измениться у него под руками.
      return { ok: true, value: [...items] };
    }
  }
}

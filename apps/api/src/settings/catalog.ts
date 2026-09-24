/**
 * Каталог настроек инсталляции — близнец `packages/shared/src/settings.ts`.
 *
 * Копия, а не общий импорт, по той же причине, по которой api держит своими
 * `PROTOCOL_VERSION` и `LIMIT` (см. `gateway/protocol.ts`), — только здесь у
 * причины есть ещё и механическая половина. `@relay/shared` отдаётся исходником
 * на ESM (`main: ./src/index.ts`), а api собирается tsc в commonjs с
 * `rootDir: ./src` и уезжает в образ одним `dist`: импорт оттуда не пережил бы
 * ни компиляцию (файл вне `rootDir`), ни запуск (`require` файла `.ts`, которого
 * в `pnpm deploy --prod` вдобавок и нет).
 *
 * Расхождение близнецов ловит не глаз, а тест: `packages/shared/src/settings.test.ts`
 * сверяет два файла слово в слово, начиная с первого объявления. Поэтому правка
 * каталога — это правка обоих файлов, и `diff` между ними обязан показывать
 * ровно эту шапку и строку импорта, ничего больше.
 *
 * Ниже — текст близнеца без единого изменения.
 */

import type { AttachmentKind } from '../uploads';

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
  | 'calls'
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
  /**
   * Из чего состоит список, когда его пункты — не свободный текст.
   *
   * `cidr` — адреса и маски: пункт разбирается, приводится к канонической
   * записи и отвергается с `bad-item`, если адресом не является. Разбор нужен
   * не ради красоты списка: маска, которую сервер не понял, выглядит на экране
   * настройкой, а не работает никак — то есть врёт молча.
   */
  items?: 'cidr';
  /** Значение никогда не уходит наружу — только признак «задано». */
  secret?: boolean;
  /** Правка просит подтверждения. */
  danger?: boolean;
  /** Откуда берётся начальное значение при первом старте. */
  env?: string;
  /** Значение живёт в окружении и в панели только показывается. */
  readOnly?: boolean;
  /**
   * Значение уезжает в браузер снимком (`SettingsService.snapshot`).
   *
   * Помечены им ровно те параметры, которыми клиент ПОЛЬЗУЕТСЯ: вид
   * инсталляции, звуки, умолчания микрофона, битрейты, пределы, по которым он
   * режет ввод. Всё остальное остаётся на сервере — не потому, что секретно
   * (секрет — это `secret`), а потому, что чужому браузеру незачем знать, как
   * инсталляция устроена изнутри. Список стоп-слов, розданный всем, — подсказка
   * тем, против кого он заведён; пороги блокировки, розданные всем, — карта для
   * подбора пароля.
   *
   * Владелец видит ВСЁ — своей дорогой, через панель (`public()`), а не через
   * этот снимок.
   */
  client?: boolean;
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
  'calls',
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
  // Дверей ровно две, потому что третьей в relay нет: приглашение здесь —
  // гостевая ссылка в один голосовой канал, личности она не заводит и завести
  // не может. Строка «по приглашению» отличалась бы от «закрыто» только словом,
  // а закрывала бы ровно то же самое — то же враньё, что вид вложения «видео».
  // Вернётся вместе с приглашениями, которые заводят личность.
  {
    key: 'access.identityCreation',
    group: 'access',
    kind: 'select',
    fallback: 'open',
    applies: 'new',
    options: ['open', 'closed'],
  },
  // Ноль — без предела, и это сегодняшнее поведение: связать с личностью можно
  // сколько угодно устройств. Восемь выглядели бы недостижимыми, но у человека
  // с девятью ключами девятый перестал бы связываться в день обновления.
  {
    key: 'access.maxDevicesPerIdentity',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 64,
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
  // Ноль — без предела. Дверь сегодня считает НЕУДАЧИ за окно
  // (`access.unlockAttempts`), а попыток в минуту не считает вовсе: поставь
  // сюда двадцать — и общий выход в интернет, за которым сидит десяток людей,
  // упёрся бы в предел, которого вчера не было.
  {
    key: 'access.loginRatePerMinute',
    group: 'access',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
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
  /**
   * Закрытые адреса — список масок, а не адресов поимённо.
   *
   * Бан по ключу останавливает происходящее ровно на секунду: личность в relay
   * рождается на устройстве без чьего-либо разрешения, и забаненный заводит
   * новую быстрее, чем владелец закрывает панель. Адрес сменить дороже — не
   * невозможно, но дороже, — и этой разницы хватает, чтобы «прекрати сейчас
   * же» стало исполнимым.
   *
   * Список НЕ уезжает клиенту (`client` не ставим): с кем воюет владелец — не
   * дело чужого браузера, и уж точно не гостевого. Пустой по умолчанию, то
   * есть до первой записи дверь открыта всем, как и была.
   */
  {
    key: 'access.blockedAddresses',
    group: 'access',
    kind: 'list',
    fallback: [],
    applies: 'now',
    max: LIST_MAX,
    items: 'cidr',
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
    client: true,
  },
  {
    key: 'people.lastSeenVisible',
    group: 'people',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
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
    client: true,
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
  // Выключены, потому что сегодня системных строк в ленте нет вовсе: колонка
  // `system` есть, лента её рисует, а писать в неё некому. Включённые по
  // умолчанию, они добавили бы в чужие каналы строку, которой там не было, —
  // это и есть «умолчание, близкое к прежнему поведению», а требуется равное.
  {
    key: 'messages.systemMessages',
    group: 'messages',
    kind: 'boolean',
    fallback: false,
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
  // Выключенные превью не запрещают картинку — они перестают её раскрывать в
  // ленте: файл приезжает карточкой, как pdf. Решает это клиент, потому что
  // «показывать» — вопрос экрана, а не сервера.
  {
    key: 'files.imagePreviews',
    group: 'files',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
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
  // 2 ГиБ — DEFAULT_MAX_TOTAL_BYTES (apps/api/src/uploads.ts): столько каталог
  // загрузок держит СЕГОДНЯ, и за этим потолком уже сегодня вытесняются самые
  // старые вложения. Ноль здесь пришлось бы читать как «без квоты», а это иное
  // поведение, чем вчерашнее, — поэтому умолчание равно константе, а ноль
  // остаётся тем, что владелец выбирает сам. Знающему свою машину по-прежнему
  // отвечает UPLOAD_MAX_TOTAL_BYTES: она засевается в таблицу на первом старте
  // (см. SEEDED_FROM_ENV) и больше нигде не читается.
  {
    key: 'files.installQuotaBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 2 * GIB,
    applies: 'now',
    min: 0,
    max: 1 * TIB,
    env: 'UPLOAD_MAX_TOTAL_BYTES',
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
  // Выключен, и это не осторожность, а правда: сегодня .exe проходит наравне с
  // pdf — вид у него `file`, и никакой другой проверки на пути нет. Включённый
  // по умолчанию, он запретил бы в день обновления то, что вчера носили.
  {
    key: 'files.blockExecutables',
    group: 'files',
    kind: 'boolean',
    fallback: false,
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
  // «Как у каналов» — это сегодняшнее поведение слово в слово: ретенция ходит
  // по всей таблице реплик и о том, что часть из них лежит в беседах, не знает.
  // Отдельный срок у переписки появляется ровно тогда, когда владелец его
  // выберет, — и `direct.retentionDays` до этого момента ни на что не влияет.
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
    client: true,
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
  // Ноль — без предела, как у квот на файлы и у первых реплик в ЛС: сегодня в
  // голосовой канал пускают всех, кто до него дошёл, и число здесь означало бы
  // запрет там, где вчера запрета не было.
  {
    key: 'spaces.maxVoiceOccupants',
    group: 'spaces',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
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
    client: true,
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
    client: true,
  },
  {
    key: 'voice.videoBitrateKbps',
    group: 'voice',
    kind: 'number',
    fallback: 2500,
    applies: 'new',
    min: 100,
    max: 8000,
    client: true,
  },
  {
    key: 'voice.noiseSuppressionDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: true,
    applies: 'new',
    client: true,
  },
  {
    key: 'voice.pushToTalkDefault',
    group: 'voice',
    kind: 'boolean',
    fallback: false,
    applies: 'new',
    client: true,
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
    client: true,
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

  // ── calls — дозвон один на один ──────────────────────────────────────────
  // Звонок человеку, а не вход в комнату: у этой группы своя дверь, свои часы и
  // свой предел, и ни один из них не выводится из голосовых. `voice.*` про то,
  // как звучит разговор; здесь — про то, дойдёт ли до него дело.
  //
  // `client: true` — веб решает по нему, рисовать ли кнопку звонка вообще:
  // выключенный дозвон не должен превращаться в кнопку, которая всегда
  // отвечает отказом (см. `apps/web/stores/ring.ts`, `useCallGate`).
  {
    key: 'calls.enabled',
    group: 'calls',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Сорок пять секунд — это про человека с телефоном в другой комнате: меньше
  // тридцати не хватает дойти, больше минуты никто не ждёт у гудка, и разница
  // между «не ответили» и «передумал звонить» смазывается. Потолок в три минуты
  // оставлен инсталляциям, где звонка ждут от дежурного, а не от приятеля; пол в
  // десять секунд — чтобы «выключить дозвон» делалось выключателем выше, а не
  // таймаутом в единицу.
  {
    key: 'calls.ringTimeoutSeconds',
    group: 'calls',
    kind: 'number',
    fallback: 45,
    applies: 'now',
    min: 10,
    max: 180,
  },
  // Умолчание строже, чем у первого сообщения (`direct.whoCanStart: everyone`), и
  // намеренно: непрошеное сообщение ждёт, пока его прочтут, а непрошеный звонок
  // звонит вслух прямо сейчас. «С кем есть переписка» — это заведённая беседа
  // (та же пара, что и в разделе ЛС), а не «виделись в одном канале»: второе
  // разрешило бы звонить любому, кто когда-либо написал в общий канал.
  // `client: true` — при `nobody` кнопка звонка обязана погаснуть заранее
  // (`aria-disabled` с объяснением, а не живая кнопка, которая всегда получит
  // `forbidden`); при `conversation` разрешение уже выполнено самим экраном
  // беседы, поэтому веб читает только значение `nobody`.
  {
    key: 'calls.whoCanCall',
    group: 'calls',
    kind: 'select',
    fallback: 'conversation',
    applies: 'now',
    options: ['everyone', 'conversation', 'nobody'],
    client: true,
  },
  // Камера в звонке. Спрашивается на дозвоне, а не в комнате: вызываемый обязан
  // знать, что звонок с камерой, ДО того как нажмёт «принять», — иначе кнопка
  // «принять» включает камеру, о которой человека не предупредили. Выключено —
  // запрос с видео становится обычным голосовым вызовом, а не отказом.
  // `client: true` — веб решает по нему, предлагать ли видео при наборе:
  // кнопка видеозвонка не рисуется вовсе, когда инсталляция его не пускает
  // (иначе нажатие тихо превращалось бы в голосовой, о чём человек не просил).
  {
    key: 'calls.videoAllowed',
    group: 'calls',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Отметка о пропущенном в переписке. Включена, потому что без неё звонок в
  // закрытую вкладку не оставляет следа вовсе: человек не узнаёт, что ему
  // звонили, ни в каком месте интерфейса.
  {
    key: 'calls.missedMarkEnabled',
    group: 'calls',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Сидящий в голосовом канале считается занятым. Включено, потому что дозвон до
  // человека, который сейчас говорит, кончится в лучшем случае «отклонён»:
  // входящий он либо не услышит за чужими голосами, либо услышит и бросит тех, с
  // кем разговаривает. Выключение оставлено тем, у кого голосовой канал —
  // фоновая комната, а не разговор.
  {
    key: 'calls.busyWhenInVoice',
    group: 'calls',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
  },
  // Тридцать в час — это предел на назойливость, а не на пользование: живой
  // человек за час звонит единицам, а тридцать раз подряд набирает только тот,
  // кому не хотят отвечать. Ноль — без предела, как у остальных почасовых квот
  // каталога; «совсем нельзя звонить» — это `calls.whoCanCall: nobody`, и двух
  // способов сказать одно и то же не нужно.
  {
    key: 'calls.maxRingsPerHour',
    group: 'calls',
    kind: 'number',
    fallback: 30,
    applies: 'now',
    min: 0,
    max: 200,
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
  // Ноль — без предела: ссылка сегодня многоразовая, и сколько человек по ней
  // придёт, никто не считает.
  {
    key: 'invites.maxGuestsPerChannel',
    group: 'invites',
    kind: 'number',
    fallback: 0,
    applies: 'now',
    min: 0,
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
    client: true,
  },
  {
    key: 'appearance.installEmoji',
    group: 'appearance',
    kind: 'text',
    fallback: '',
    applies: 'now',
    max: 8,
    client: true,
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
    client: true,
  },
  {
    key: 'appearance.defaultLocale',
    group: 'appearance',
    kind: 'select',
    fallback: 'en',
    applies: 'new',
    options: ['en', 'ru'],
    client: true,
  },
  {
    key: 'appearance.loginNotice',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: NOTICE_MAX,
    client: true,
  },
  {
    key: 'appearance.rulesText',
    group: 'appearance',
    kind: 'multiline',
    fallback: '',
    applies: 'now',
    max: RULES_MAX,
    client: true,
  },
  {
    key: 'appearance.showVersion',
    group: 'appearance',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },

  // ── notifications — уведомления ──────────────────────────────────────────
  {
    key: 'notifications.soundEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  {
    key: 'notifications.mentionSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  {
    key: 'notifications.directSound',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Раньше здесь стояла заметка «системных уведомлений relay не показывает: ни
  // одного вызова Notification API в клиенте нет — переключатель появится
  // вместе с кодом, который их шлёт». Этот код — входящий звонок (задача 7
  // плана B, `apps/web/lib/notify.ts`, `notifyCall`): первый и пока
  // единственный вызов `new Notification(...)` во всём клиенте. Заметка была
  // верна ровно до этой строки.
  //
  // Своя настройка, а не второе чтение `soundEnabled`: то — рубильник над
  // звуком ЧАТОВЫХ сигналов (сообщение/упоминание/личка, apps/web/lib/
  // notify.ts), это — про системное окошко поверх остальных окон, когда
  // вкладку/приложение свернули. Рингтон входящего звонка под `soundEnabled`
  // не подчинён вовсе: он играет так же, как остальные звуки голоса в этой
  // кодовой базе (apps/web/lib/voice.ts) — без отдельного рубильника, но под
  // общим мутом (`sfx.setAllMuted`, деафен глушит и его). Человек волен
  // выключить одно, не трогая другое (беззвучная вкладка — законный выбор, и
  // его не должно чинить выключение попапов, о которых речь не шла).
  {
    key: 'notifications.desktopEnabled',
    group: 'notifications',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
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
    client: true,
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
  | 'too-long'
  /** Пункт списка не той формы: строка, которая адресом с маской не является. */
  | 'bad-item';

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
      // Адреса и маски приводятся к канонической записи прямо здесь, а не при
      // сравнении: в таблицу и на экран уезжает то, ЧТО СЕРВЕР ПОНЯЛ. Голый
      // IPv6 при этом разворачивается в /64 и виден развёрнутым — иначе
      // настройка выглядела бы одним, а действовала бы другим.
      if (spec.items === 'cidr') {
        const prefixes: string[] = [];
        for (const item of items) {
          const prefix = normalizeAddressPrefix(item);
          if (!prefix) return { ok: false, error: 'bad-item' };
          prefixes.push(prefix);
        }
        return { ok: true, value: prefixes };
      }
      // Копия: список уезжает в хранилище, а пришедший массив принадлежит
      // вызывающему и может измениться у него под руками.
      return { ok: true, value: [...items] };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Адреса и маски
//
// Разбор живёт здесь, внутри каталога, и это не случайность: `validateSetting`
// зовут и браузер, и сервер, а `apps/api` намеренно не ввозит `@relay/shared`.
// Значит парсер — обычная функция в обоих экземплярах каталога, и его
// одинаковость держит тот же тест, что и всё остальное в этом файле.
//
// Чем этот список НЕ является — важнее того, чем является. Он не защищает от
// нагрузки: запрос всё равно доходит до Node, оплатив TLS, и инструмент против
// потока — файрвол или прокси перед приложением. И он не запрещает человеку:
// VPN и мобильный интернет обходят его за минуту. Настройка, от которой ждут
// больше, чем она даёт, хуже отсутствующей, поэтому обе оговорки стоят и в
// подсказке поля.
// ─────────────────────────────────────────────────────────────────────────────

/** Разобранная маска: адрес сети байтами (4 или 16) и длина префикса. */
interface AddressPrefix {
  bytes: number[];
  bits: number;
}

/**
 * Одна четвёрка IPv4. Ноль впереди отвергаем: `010` — это восемь в одних
 * разборщиках и десять в других, и маска, которую два участника пути понимают
 * по-разному, хуже отсутствующей.
 */
function parseV4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IPv6 со всеми законными сокращениями: `::` ровно одно, хвост в виде IPv4
 * (`::ffff:1.2.3.4`) — тоже форма записи, и именно ею Node называет
 * IPv4-клиента на двойном сокете. Не разбери мы её, маска `10.0.0.0/8` не
 * ловила бы `::ffff:10.1.2.3` — то есть выглядела бы работающей и не работала.
 */
function parseV6(text: string): number[] | null {
  let src = text;
  let tail: number[] = [];
  if (src.includes('.')) {
    const colon = src.lastIndexOf(':');
    if (colon < 0) return null;
    const v4 = parseV4(src.slice(colon + 1));
    if (!v4) return null;
    tail = v4;
    // Двоеточие оставляем и снимаем сами — но только если перед ним не «::»,
    // которое само по себе часть адреса.
    src = src.slice(0, colon + 1);
    if (!src.endsWith('::')) src = src.slice(0, -1);
  }
  const want = 8 - tail.length / 2;
  const gap = src.indexOf('::');
  if (gap >= 0 && src.indexOf('::', gap + 1) >= 0) return null;
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(split(gap < 0 ? src : src.slice(0, gap)));
  const rest = groupsOf(gap < 0 ? [] : split(src.slice(gap + 2)));
  if (!head || !rest) return null;
  let groups: number[];
  if (gap < 0) {
    if (head.length !== want) return null;
    groups = head;
  } else {
    // «::» обязано покрывать хотя бы одну группу — иначе это просто лишние
    // двоеточия, а не сокращение.
    if (head.length + rest.length >= want) return null;
    groups = [...head, ...new Array<number>(want - head.length - rest.length).fill(0), ...rest];
  }
  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return [...bytes, ...tail];
}

function groupsOf(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    out.push(parseInt(part, 16));
  }
  return out;
}

/** Обёртка IPv4 в IPv6 — тот же самый IPv4, и считать его надо им. */
function v4Mapped(bytes: number[]): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Адрес любой из двух семей, в байтах. Обёрнутый IPv4 разворачивается. */
function parseAddress(text: string): number[] | null {
  const bytes = text.includes(':') ? parseV6(text) : parseV4(text);
  if (!bytes) return null;
  return v4Mapped(bytes) ? bytes.slice(12) : bytes;
}

/** Обнулить всё за маской: сеть — это сеть, а не адрес внутри неё. */
function maskBytes(bytes: number[], bits: number): number[] {
  return bytes.map((byte, index) => {
    const left = bits - index * 8;
    if (left >= 8) return byte;
    if (left <= 0) return 0;
    return byte & (0xff << (8 - left)) & 0xff;
  });
}

/**
 * Запись списка → маска. `null` — не адрес.
 *
 * Голый IPv6 разворачивается в `/64`, и это не вольность. Жильё раздаётся
 * блоком /64, а адрес внутри него меняется сам собой (RFC 4941): бан одного
 * `/128` перестал бы действовать через несколько минут, ничего об этом не
 * сказав. Голый IPv4 остаётся самим собой — там адрес выдают поштучно.
 */
function parsePrefix(text: string): AddressPrefix | null {
  const slash = text.indexOf('/');
  const bytes = parseAddress(slash < 0 ? text : text.slice(0, slash));
  if (!bytes) return null;
  let bits = bytes.length === 4 ? 32 : 64;
  if (slash >= 0) {
    const suffix = text.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(suffix)) return null;
    bits = Number(suffix);
    if (bits > bytes.length * 8) return null;
  }
  return { bytes: maskBytes(bytes, bits), bits };
}

/** Каноническая запись IPv6: строчные группы, самый длинный ноль — под «::». */
function textV6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let at = -1;
  let len = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j += 1;
    if (j - i > len) {
      at = i;
      len = j - i;
    }
    i = j;
  }
  const hex = (part: number[]) => part.map((group) => group.toString(16)).join(':');
  if (len < 2) return hex(groups);
  return `${hex(groups.slice(0, at))}::${hex(groups.slice(at + len))}`;
}

/**
 * Каноническая запись маски — то, что владелец увидит после сохранения.
 * `null`, если строка адресом не является.
 *
 * IPv4 без маски пишется голым (он и есть один адрес), IPv6 — всегда с
 * длиной: увидеть, во что развернулась запись, важнее краткости.
 */
export function normalizeAddressPrefix(text: string): string | null {
  const prefix = parsePrefix(text);
  if (!prefix) return null;
  if (prefix.bytes.length === 4) {
    return prefix.bits === 32 ? prefix.bytes.join('.') : `${prefix.bytes.join('.')}/${prefix.bits}`;
  }
  return `${textV6(prefix.bytes)}/${prefix.bits}`;
}

/**
 * Разобранные маски одного и того же списка. Список хранится замороженным и
 * меняется разве что раз в месяц, а спрашивают его на каждом рукопожатии и
 * каждом http-запросе — разбирать пятьсот строк заново каждый раз значило бы
 * платить за настройку тем самым, ради чего она заведена.
 */
const parsedLists = new WeakMap<readonly string[], AddressPrefix[]>();

function prefixesOf(list: readonly string[]): AddressPrefix[] {
  const known = parsedLists.get(list);
  if (known) return known;
  const parsed: AddressPrefix[] = [];
  // Непонятой строке здесь взяться неоткуда (в таблицу их не пускает
  // `validateSetting`), но если возьмётся — она просто никого не блокирует.
  for (const item of list) {
    const prefix = parsePrefix(item);
    if (prefix) parsed.push(prefix);
  }
  parsedLists.set(list, parsed);
  return parsed;
}

/**
 * Закрыт ли этот адрес списком владельца.
 *
 * Семьи не смешиваются: IPv4 не совпадает с IPv6-маской и наоборот. Иначе
 * `::/0`, написанный ради «закрыть всё в шестой версии», закрыл бы заодно и
 * четвёртую — то есть инсталляцию целиком.
 */
export function addressBlocked(list: readonly string[], address: string): boolean {
  if (list.length === 0) return false;
  const probe = parseAddress(address);
  if (!probe) return false;
  for (const prefix of prefixesOf(list)) {
    if (prefix.bytes.length !== probe.length) continue;
    if (sameNetwork(prefix, probe)) return true;
  }
  return false;
}

function sameNetwork(prefix: AddressPrefix, probe: number[]): boolean {
  const masked = maskBytes(probe, prefix.bits);
  return masked.every((byte, index) => byte === prefix.bytes[index]);
}

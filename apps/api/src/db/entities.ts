import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';

/**
 * Схема relay 1.0 целиком — одним файлом.
 *
 * Одним файлом намеренно: схема читается как схема, а не как десяток файлов по
 * пятнадцать строк, между которыми надо прыгать, чтобы понять, что на что
 * ссылается. Слой 1 работает с четырьмя таблицами (`servers`, `channels`,
 * `messages`, `attachments`); остальные первая миграция создала пустыми — их
 * наполнили личности, роли, непрочитанное и настройки слоёв 2-3. Что появилось
 * позже самой первой миграции (`owner_claims`, `prefs`), видно по списку в
 * `db/migrations`, а не по этому файлу: здесь схема как она есть сейчас.
 *
 * Типы колонок проставлены руками ВЕЗДЕ, включая те, где TypeORM вывел бы их
 * сам: вывод держится на `emitDecoratorMetadata`, а тесты гоняет vitest на
 * esbuild, который метаданные не эмитит вовсе. Забытый `type:` обернётся не
 * ошибкой сборки, а падением на импорте в тестах.
 *
 * DDL живёт в миграции и написан на SQL, а не выведен из этих классов
 * (`synchronize` в проде — способ потерять данные молча). Значит эти два места
 * могут разъехаться, и за этим следит отдельная проверка: см. `schema.test.ts`,
 * который спрашивает у TypeORM, что бы он ещё дописал в базу после миграций.
 * Ответ обязан быть «ничего».
 */

// ── Реестр ──────────────────────────────────────────────────────────────────

/**
 * Сервер (гильдия). Id — текстовый и приходит от клиента: он придумывает его
 * сам, чтобы не ждать ответа, а дефолтные записи носят фиксированные id
 * (`relay-main`). Менять это на uuid значило бы ломать и клиент, и переезд
 * старого registry.json ради красоты первичного ключа.
 */
@Entity('servers')
export class ServerRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  emoji!: string | null;

  @Column({ type: 'boolean' })
  removable!: boolean;

  /** `salt:hash` (scrypt) закрытого сервера. Наружу не уходит никогда. */
  @Column({ type: 'text', name: 'password_hash', nullable: true })
  passwordHash!: string | null;

  /**
   * Создатель до личностей: clientId устройства из localStorage. Заслон от
   * случайного сноса, а не право — такое «владение» терялось вместе с чисткой
   * браузера. Новые записи его больше не пишут (см. `creator_identity_id`), но
   * у существующих оно продолжает работать: отобрать сервер у человека в день
   * обновления — не то, ради чего он обновлялся.
   */
  @Column({ type: 'text', name: 'creator_id', nullable: true })
  creatorId!: string | null;

  /**
   * Создатель как личность — он же модератор этого сервера и только его.
   *
   * Без внешнего ключа, по той же причине, что и у автора реплики: сервер
   * инсталляции не должен зависеть от жизни строки личности. Исчезнет
   * создатель — сервер остаётся, просто без хозяина, и распоряжается им
   * владелец инсталляции.
   */
  @Column({ type: 'uuid', name: 'creator_identity_id', nullable: true })
  creatorIdentityId!: string | null;

  /**
   * Порядок в рейке. В registry.json им был порядок элементов массива, и терять
   * его при переезде нельзя: рейка серверов у человека перетасовалась бы сама
   * по себе.
   */
  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

/**
 * Канал. Слаг уникален в пределах типа (`type, slug`) — на нём держится имя
 * комнаты socket.io, и два канала с одним слагом делили бы одну комнату на
 * двоих. До 1.0 это было возможно и означало общую ленту у разных каналов;
 * миграция реестра разводит такие пары суффиксом.
 */
@Entity('channels')
@Index('channels_type_slug_key', ['type', 'slug'], { unique: true })
export class ChannelRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text', name: 'server_id' })
  serverId!: string;

  @ManyToOne(() => ServerRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_id' })
  server!: ServerRow;

  /** `text` | `voice`. */
  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'boolean' })
  removable!: boolean;

  /** Только у голосовых: `p2p` | `sfu`. */
  @Column({ type: 'text', nullable: true })
  mode!: string | null;

  /** Как у сервера: clientId создателя у унаследованных записей. */
  @Column({ type: 'text', name: 'creator_id', nullable: true })
  creatorId!: string | null;

  /** Как у сервера: личность создателя у всего, что создано начиная с 1.0. */
  @Column({ type: 'uuid', name: 'creator_identity_id', nullable: true })
  creatorIdentityId!: string | null;

  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

// ── Переписка ───────────────────────────────────────────────────────────────

/**
 * Загруженный файл. Строка появляется в момент загрузки, ДО того как файл
 * прицепят к сообщению, — иначе загрузку нечем было бы связать с сообщением
 * после рестарта, ровно как сегодня.
 *
 * Id — имя файла на диске: одна сущность, один ключ, и подметание не гадает,
 * какому файлу какая строка соответствует.
 */
@Entity('attachments')
export class AttachmentRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  /** Показываемое имя: уже обеззараженное (без путей, длины и спецсимволов). */
  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column({ type: 'text' })
  mime!: string;

  /** Как рисовать: `image` | `audio` | `file`. */
  @Column({ type: 'text' })
  kind!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'uploaded_at' })
  uploadedAt!: Date;
}

/**
 * Реплика чата. Всё, что раньше жило в `Map` гейтвея и умирало вместе с
 * процессом.
 *
 * `reply_to` — снимок цитируемого (id, имя, обрезанный текст), а не ссылка:
 * оригинал могут отредактировать или удалить, цитата обязана остаться прежней.
 * `reactions` — `{ эмодзи: [имена] }` в jsonb: набор эмодзи закрыт, а имена
 * самоназначаемые, так что отдельная таблица дала бы строгость там, где её
 * всё равно не из чего взять.
 */
@Entity('messages')
// Лента канала и курсор пагинации: «последние N канала» и «N старше этой
// точки» — это один и тот же индекс, если ключ полный (ts, id). Одного ts мало:
// в миллисекунду попадает несколько сообщений, и страница бы их теряла.
@Index('messages_channel_ts_idx', ['channelId', 'createdAt', 'id'])
// Ретенция ходит по всей таблице, без канала.
@Index('messages_created_at_idx', ['createdAt'])
// Третий индекс этой таблицы — `messages_search_idx` под поиск — объявлен
// только в миграции MessageSearch: он GIN по выражению `to_tsvector(...)`, а
// декоратор такого не выражает. Схема от этого не разъезжается (проверяется в
// schema.test), но при чтении entities о нём легко забыть — потому и написано.
// Четвёртый — `messages_mentions_idx` под счётчик упоминаний — объявлен и
// здесь, и в миграции Mentions: колонку декоратор назвать умеет, а вот метод
// (GIN) и класс операторов (`jsonb_path_ops`) — нет, и настоящий DDL живёт
// там же, где вся остальная схема.
@Index('messages_mentions_idx', ['mentions'])
export class MessageRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', name: 'channel_id' })
  channelId!: string;

  @ManyToOne(() => ChannelRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel!: ChannelRow;

  /**
   * Подпись автора — имя на момент отправки. С личностью оно уже не
   * самоназначаемое (гейтвей берёт его у сервера, а не из тела сообщения), но
   * остаётся снимком: переименование не переписывает сказанное вчера.
   */
  @Column({ type: 'text', name: 'author_name' })
  authorName!: string;

  /** Автор как личность. Пусто у гостя по инвайту и у всего, что до 1.0. */
  @Column({ type: 'uuid', name: 'author_identity_id', nullable: true })
  authorIdentityId!: string | null;

  /**
   * Та же связь объектом — из неё лента берёт отпечаток, чтобы нарисовать лицо
   * автора. Без внешнего ключа намеренно: строка сообщения не должна зависеть
   * от жизни строки личности. Личность исчезает (её снёс админ, вычистила
   * будущая уборка отозванных) — реплика обязана остаться в ленте безымянной,
   * а не увести с собой чужой разговор и не заблокировать своё же удаление.
   */
  @ManyToOne(() => IdentityRow, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'author_identity_id' })
  authorIdentity!: IdentityRow | null;

  @Column({ type: 'text' })
  text!: string;

  /** Системная строка ленты: не правится, не удаляется автором, но реакции носит. */
  @Column({ type: 'boolean', default: false })
  system!: boolean;

  /** Метка сообщения, а не файла: один и тот же файл можно послать со спойлером и без. */
  @Column({ type: 'boolean', default: false })
  spoiler!: boolean;

  @Column({ type: 'text', name: 'attachment_id', nullable: true })
  attachmentId!: string | null;

  @ManyToOne(() => AttachmentRow, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'attachment_id' })
  attachment!: AttachmentRow | null;

  @Column({ type: 'jsonb', name: 'reply_to', nullable: true })
  replyTo!: { id: string; name: string; text: string } | null;

  /**
   * Кого назвали в реплике: отпечаток ключа (это и есть адресат) и ник, как он
   * был написан. Снимок, как и цитата: человек переименуется — сказанное вчера
   * не перепишется, а найти его упоминания отпечаток по-прежнему даст.
   *
   * Дефолт значением, а не выражением — по той же причине, что у `reactions`:
   * jsonb TypeORM сверяет глубоким сравнением, и `() => "'[]'::jsonb"` он счёл
   * бы расхождением со прочитанным из базы.
   */
  @Column({ type: 'jsonb', default: [] })
  mentions!: { fingerprint: string; nick: string }[];

  /**
   * Время ставит база (`now()` при вставке), а не Node и тем более не клиент.
   * На нём держится порядок ленты и курсор пагинации, а значит оно обязано
   * идти из одних часов — тех же, по которым потом сортируется выборка.
   * Поэтому обычная колонка с дефолтом, а не `@CreateDateColumn`: тот
   * подставляет время процесса.
   *
   * Точность — миллисекунды, ровно та, в которой это время уходит клиенту и
   * возвращается курсором. У Postgres по умолчанию микросекунды, и лишние три
   * знака оборачивались бы потерянными и удвоенными репликами на границе
   * страницы: клиент присылает `12:00:00.001`, а в базе лежит `12:00:00.0014`,
   * и строка одновременно «не старше» и «не новее» собственного курсора.
   */
  @Column({
    type: 'timestamptz',
    precision: 3,
    name: 'created_at',
    default: () => `date_trunc('milliseconds', now())`,
  })
  createdAt!: Date;

  // Дефолт объектом, а не выражением: у jsonb TypeORM сверяет дефолты глубоким
  // сравнением значений, и `() => "'{}'::jsonb"` он бы честно счёл расхождением
  // с тем, что прочитал из базы, — на каждом старте предлагая «починить».
  @Column({ type: 'jsonb', default: {} })
  reactions!: Record<string, string[]>;

  @Column({ type: 'timestamptz', name: 'edited_at', nullable: true })
  editedAt!: Date | null;

  /**
   * Закрепление этой реплики — список, в котором бывает ноль строк или одна:
   * ключ таблицы `pins` — сам id сообщения. Списком, а не связью «один к
   * одному», намеренно: `@OneToOne` попросил бы у базы отдельное ограничение
   * уникальности поверх первичного ключа, которого в миграции нет, и схема
   * начала бы расходиться с классами на ровном месте (см. `schema.test.ts`).
   *
   * Лента подтягивает его слева и по наличию строки рисует пометку.
   */
  @OneToMany(() => PinRow, (pin) => pin.message)
  pins!: PinRow[];
}

// ── Личность (слой 2) ───────────────────────────────────────────────────────

/**
 * Человек. Не строка в localStorage и не запись в таблице пользователей с
 * паролем: публичный ключ и есть личность. Регистрации нет, восстановления нет.
 */
@Entity('identities')
export class IdentityRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Публичная половина корневого ключа (base64url). Приватную сервер не видит. */
  @Column({ type: 'text', name: 'public_key', unique: true })
  publicKey!: string;

  /** Отпечаток ключа: из него же рисуется identicon. */
  @Column({ type: 'text', unique: true })
  fingerprint!: string;

  /** Ник. Свободный и НЕ уникальный — людей различает отпечаток. */
  @Column({ type: 'text' })
  nick!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt!: Date | null;
}

/**
 * Устройство. У каждого свой ключ, связка — деревом: существующее устройство
 * подписывает сертификат нового. Браузер и десктоп-оболочка — уже два разных
 * устройства одного человека, у них разные хранилища.
 */
@Entity('devices')
export class DeviceRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'identity_id' })
  identityId!: string;

  @ManyToOne(() => IdentityRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'identity_id' })
  identity!: IdentityRow;

  @Column({ type: 'text', name: 'public_key', unique: true })
  publicKey!: string;

  /** Как показать в списке устройств: «relay для macOS», «Chrome». */
  @Column({ type: 'text' })
  name!: string;

  /** Подпись донора: чем это устройство доказывает своё родство с личностью. */
  @Column({ type: 'text', nullable: true })
  certificate!: string | null;

  @Column({ type: 'uuid', name: 'parent_device_id', nullable: true })
  parentDeviceId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt!: Date | null;

  /** Отозвано владельцем личности. Строку не удаляем: отзыв — это факт. */
  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
}

// ── Слой 3 ──────────────────────────────────────────────────────────────────

/**
 * Роль личности. `server_id = null` — вся инсталляция (там живёт владелец и
 * туда же пишется бан на всю инсталляцию); заполненный — конкретная гильдия,
 * и такой строкой создатель сервера банит со своего сервера.
 *
 * Ролей ровно две: `owner` и `banned`. Обычный участник строки не имеет — и это
 * не экономия, а то же правило, по которому здесь нет регистрации: право быть в
 * общем канале даёт вход на инсталляцию, а не запись в таблице. Была бы строка
 * `member`, кто-то обязан был бы её выдавать, и появился бы четвёртый экран,
 * которого никто не просил.
 *
 * Уникальность по паре — с `NULLS NOT DISTINCT` (см. вторую миграцию): без неё
 * Postgres считает NULL'ы различными и пропустил бы второго «владельца
 * инсталляции» для той же личности. Сама пометка `unique` тут ровно для того,
 * чтобы TypeORM знал об индексе; ключевое слово он не умеет, и его дописывает
 * миграция.
 */
@Entity('roles')
@Index('roles_identity_server_key', ['identityId', 'serverId'], { unique: true })
export class RoleRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'identity_id' })
  identityId!: string;

  @ManyToOne(() => IdentityRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'identity_id' })
  identity!: IdentityRow;

  @Column({ type: 'text', name: 'server_id', nullable: true })
  serverId!: string | null;

  @Column({ type: 'text' })
  role!: string;

  /** Кто выдал. Инвайт обязан помнить своего автора — это и есть след. */
  @Column({ type: 'uuid', name: 'granted_by', nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

/**
 * Приглашение во владельцы: то, что печатает `install.sh` и перевыпускает
 * `relay owner-link`. Кто открыл ссылку — тот привязал свой ключ как владельца.
 *
 * Строка живёт в базе, а не в памяти api, по одной причине: между установкой и
 * первым заходом человека проходит время и как минимум один перезапуск стека.
 * Использованные строки не удаляются — это единственный след того, кто и когда
 * взял власть над инсталляцией.
 */
@Entity('owner_claims')
export class OwnerClaimRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** SHA-256 ключа. Самого ключа сервер не хранит — см. `hashOwnerToken`. */
  @Column({ type: 'text', name: 'token_hash', unique: true })
  tokenHash!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;

  /** Кто им воспользовался. Без внешнего ключа: след переживает личность. */
  @Column({ type: 'uuid', name: 'used_by', nullable: true })
  usedBy!: string | null;
}

/**
 * Непрочитанное. Раньше оно жило в localStorage, то есть в браузере; с
 * личностью «прочитал на десктопе» означает «прочитано и на телефоне».
 *
 * Ключ — id канала, а не слаг: слагом непрочитанное зовётся в протоколе (его же
 * знает `chat-activity`), но переименование канала не должно объявлять его
 * непрочитанным заново у всех сразу.
 */
@Entity('reads')
export class ReadRow {
  @PrimaryColumn({ type: 'uuid', name: 'identity_id' })
  identityId!: string;

  @PrimaryColumn({ type: 'text', name: 'channel_id' })
  channelId!: string;

  /** До какого момента канал прочитан. */
  @Column({ type: 'timestamptz', name: 'read_at' })
  readAt!: Date;
}

/**
 * Настройка человека — та, что описывает не эту машину, а его самого.
 *
 * Граница проведена по этому вопросу и проходит прямо здесь: громкость
 * конкретного собеседника и звук конкретного канала — про людей и каналы, они
 * едут с личностью на любое устройство. Выбор микрофона, горячие клавиши,
 * push-to-talk — про эту клавиатуру и эти наушники, и они остаются в браузере,
 * где и лежали. Синхронизировать выбранный микрофон между телефоном и
 * десктопом значит сломать оба.
 *
 * Строка на ключ, а не один документ на человека: два устройства, меняющие
 * разные настройки в одну секунду, не должны затирать друг друга — при
 * документе выигравший записал бы поверх чужого поля. Внутри одного ключа
 * последнее слово всё же за последним записавшим, и это честный предел: у
 * «списка каналов со звуком» нет способа слить две версии, кроме как выбрать.
 *
 * Что можно писать под этими ключами — решает не клиент (см. `prefs.service`):
 * иначе таблица стала бы бесплатным хранилищем чего угодно для всякого, у кого
 * есть ключ.
 */
@Entity('prefs')
export class PrefRow {
  @PrimaryColumn({ type: 'uuid', name: 'identity_id' })
  identityId!: string;

  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: unknown;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}

/**
 * Закреплённое сообщение — единственное исключение из ретенции, поэтому оно
 * отдельная таблица, а не флаг: чистильщик спрашивает «есть ли на это
 * закрепление», и ответ не зависит от того, сколько колонок у сообщения.
 */
@Entity('pins')
export class PinRow {
  @PrimaryColumn({ type: 'uuid', name: 'message_id' })
  messageId!: string;

  @ManyToOne(() => MessageRow, (message) => message.pins, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_id' })
  message!: MessageRow;

  @Column({ type: 'text', name: 'channel_id' })
  channelId!: string;

  @Column({ type: 'uuid', name: 'pinned_by', nullable: true })
  pinnedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'pinned_at' })
  pinnedAt!: Date;
}

/** Всё, что знает DataSource. Порядок — как в файле: реестр, чат, личности. */
export const ENTITIES = [
  ServerRow,
  ChannelRow,
  AttachmentRow,
  MessageRow,
  IdentityRow,
  DeviceRow,
  OwnerClaimRow,
  RoleRow,
  ReadRow,
  PrefRow,
  PinRow,
];

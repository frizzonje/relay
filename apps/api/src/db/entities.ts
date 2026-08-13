import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

/**
 * Схема relay 1.0 целиком — девять таблиц одним файлом.
 *
 * Одним файлом намеренно: схема читается как схема, а не как девять файлов по
 * пятнадцать строк, между которыми надо прыгать, чтобы понять, что на что
 * ссылается. Слой 1 работает с четырьмя таблицами (`servers`, `channels`,
 * `messages`, `attachments`); остальные пять созданы первой миграцией и стоят
 * пустыми до слоёв 2-3 — их наполнят личности, роли, непрочитанное и
 * закреплённые.
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
   * Создатель. Сейчас это clientId устройства из localStorage — заслон от
   * случайного сноса, а не личность. Слой 2 заменит его на `identity_id`.
   */
  @Column({ type: 'text', name: 'creator_id', nullable: true })
  creatorId!: string | null;

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

  @Column({ type: 'text', name: 'creator_id', nullable: true })
  creatorId!: string | null;

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
   * Время ставит база (`now()` при вставке), а не Node и тем более не клиент.
   * На нём держится порядок ленты и курсор пагинации, а значит оно обязано
   * идти из одних часов — тех же, по которым потом сортируется выборка.
   * Поэтому обычная колонка с дефолтом, а не `@CreateDateColumn`: тот
   * подставляет время процесса.
   */
  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  // Дефолт объектом, а не выражением: у jsonb TypeORM сверяет дефолты глубоким
  // сравнением значений, и `() => "'{}'::jsonb"` он бы честно счёл расхождением
  // с тем, что прочитал из базы, — на каждом старте предлагая «починить».
  @Column({ type: 'jsonb', default: {} })
  reactions!: Record<string, string[]>;

  @Column({ type: 'timestamptz', name: 'edited_at', nullable: true })
  editedAt!: Date | null;
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
 * Роль личности. `server_id = null` — вся инсталляция (там и живёт владелец);
 * заполненный — конкретная гильдия. Набор ролей намеренно бедный:
 * `owner` | `member` | `banned`.
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
 * Непрочитанное. Сегодня оно живёт в localStorage, то есть в браузере; с
 * личностью «прочитал на десктопе» означает «прочитано и на телефоне».
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
 * Закреплённое сообщение — единственное исключение из ретенции, поэтому оно
 * отдельная таблица, а не флаг: чистильщик спрашивает «есть ли на это
 * закрепление», и ответ не зависит от того, сколько колонок у сообщения.
 */
@Entity('pins')
export class PinRow {
  @PrimaryColumn({ type: 'uuid', name: 'message_id' })
  messageId!: string;

  @ManyToOne(() => MessageRow, { onDelete: 'CASCADE' })
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
  RoleRow,
  ReadRow,
  PinRow,
];

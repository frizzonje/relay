import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AttachmentRow, MessageRow } from '../db/entities';
import type { Attachment } from '../uploads';
import type { ChatMessage, ReactionMap, ReplyRef } from './protocol';
import { RegistryService } from './registry.service';

/**
 * История текстовых каналов.
 *
 * До 1.0 она жила в памяти процесса: пятьдесят последних реплик на канал,
 * двести каналов, рестарт стирает всё (audit S3). Теперь — Postgres, и вместе
 * с ним исчезли оба лимита: их место заняла ретенция, которая считает не
 * реплики, а дни.
 *
 * Гейтвей по-прежнему не знает, где лежит история: он оперирует слагом канала
 * и получает готовые реплики. Всё, что связано с хранением — курсор, вложения,
 * снимок цитаты, — живёт здесь.
 *
 * Единственное, что осталось в памяти, — время последней реплики каждого
 * канала. Его спрашивают на каждую рассылку реестра, по каналу на строку
 * сайдбара, и поход в базу за этим числом означал бы запрос на канал на каждый
 * чих. Это кэш производной величины, а не второе хранилище: он пересчитывается
 * при старте одним запросом и обновляется на каждой новой реплике.
 */

/** Комнаты чата в socket.io живут с префиксом — чтобы не пересечься с эфиром. */
export const CHAT_PREFIX = 'chat:';

/** Сколько реплик отдаём одной страницей — и при входе в канал, и при подгрузке. */
export const PAGE_SIZE = 50;

/**
 * Сколько находок отдаём одной страницей. Меньше страницы ленты намеренно:
 * результат читают глазами по одному, а не пролистывают.
 */
export const SEARCH_PAGE_SIZE = 20;

/**
 * Окно вокруг найденной реплики — столько же сверху и снизу. Смысл перехода из
 * поиска в том, чтобы увидеть разговор, а не одну строку: ответ на вопрос почти
 * всегда ниже вопроса.
 */
export const AROUND_HALF = 25;

/**
 * Конфигурация полнотекста. Обязана слово в слово совпадать с той, что в
 * индексе (миграция MessageSearch) — иначе индекс молча не применится.
 * Почему `simple`, а не язык — там же, в шапке миграции.
 */
const SEARCH_CONFIG = 'simple';

/** Больше слов в запрос не берём: это поиск по чату, а не язык запросов. */
const SEARCH_MAX_TERMS = 8;

/** И длиннее слова не берём — тем более что ищем по префиксу. */
const SEARCH_TERM_MAX = 40;

/**
 * Запрос человека → слова для полнотекста.
 *
 * Режем по всему, что не буква и не цифра, и тем самым решаем сразу вторую
 * задачу: у `to_tsquery` свой синтаксис (`&`, `|`, `!`, скобки, кавычки), и
 * человек, написавший в поиске «а & б», не должен получить ни ошибку базы, ни
 * чужой смысл. После разбора в словах не остаётся ни одного его символа.
 */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((term) => term.slice(0, SEARCH_TERM_MAX))
    .slice(0, SEARCH_MAX_TERMS);
}

/**
 * Слова → tsquery: все слова обязательны, каждое ищется как начало.
 *
 * Префикс — замена стеммингу, которого в `simple` нет: «канал» находит
 * «каналы» и «каналом». Обратное неверно, и это честный размен — набранное
 * человеком слово почти всегда короче или равно тому, что он ищет.
 */
function tsquery(terms: string[]): string {
  return terms.map((term) => `${term}:*`).join(' & ');
}

/**
 * Разрешённый набор реакций — дублирует REACTION_EMOJIS из `@relay/shared`
 * (api намеренно не зависит от пакета фронта, как и прочие константы).
 */
const REACTION_EMOJIS = new Set(['👍', '👎', '❤️', '😂', '🔥', '🫡', '🤡', '😭']);

/**
 * Всё, что приходит от клиента, обязано быть проверено до попадания в запрос:
 * `id` тут — строка из тела сообщения, и «не-uuid» в условии по uuid-колонке
 * это не пустой результат, а ошибка базы (22P02).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Новая реплика — то, что гейтвей разобрал из тела и проверил по правам. */
export interface NewMessage {
  name: string;
  /** Автор как личность. Пусто — писал гость по инвайту, за него ручается токен. */
  identityId?: string;
  text: string;
  /** id загрузки (он же имя файла на диске). Проверяется по таблице вложений. */
  uploadId?: string;
  spoiler?: boolean;
  /** На какое сообщение отвечаем. Снимок цитаты снимается здесь. */
  replyToId?: string;
}

/** Страница ленты: реплики по возрастанию времени и есть ли что-то выше. */
export interface Page {
  messages: ChatMessage[];
  /** Выше есть ещё — клиент показывает «подгрузить», а не «начало истории». */
  more: boolean;
}

/**
 * Кусок ленты из середины истории — то, что видно после перехода из поиска.
 * От обычной страницы отличается тем, что «ещё» бывает с обеих сторон: у ленты
 * появился низ, которого при чтении сверху вниз никогда не было.
 */
export interface FeedWindow extends Page {
  /** Ниже есть ещё — значит человек смотрит прошлое, а не живой конец канала. */
  moreAfter: boolean;
}

/**
 * Находка: реплика и канал, в котором она сказана. Слаг здесь обязателен —
 * поиск по серверу возвращает реплики из каналов, в которых человек сейчас не
 * сидит, и без него результат некуда открыть.
 */
export interface SearchHit {
  slug: string;
  message: ChatMessage;
}

export interface SearchPage {
  hits: SearchHit[];
  /** Есть что показать дальше — страница, а не «всё, что нашлось». */
  more: boolean;
}

/** Курсор — «время и id последней показанной реплики», как у ленты. */
export interface Cursor {
  ts: number;
  id: string;
}

function toAttachment(row: AttachmentRow, spoiler: boolean): Attachment {
  return {
    url: '/uploads/' + row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    kind: row.kind as Attachment['kind'],
    ...(spoiler ? { spoiler: true } : {}),
  };
}

/**
 * Строка базы → реплика протокола. Пустые поля не носим: клиент отличает
 * «реакций нет» от «пустой объект реакций» только по наличию ключа, и так было
 * всегда.
 */
function toMessage(row: MessageRow): ChatMessage {
  const reactions = row.reactions ?? {};
  return {
    id: row.id,
    name: row.authorName,
    // Отпечаток берётся у личности, а не хранится в строке: имя — снимок
    // момента, а лицо у человека одно, и второй его копией мы бы завели место,
    // где оно может разойтись с ключом.
    ...(row.authorIdentity ? { fingerprint: row.authorIdentity.fingerprint } : {}),
    text: row.text,
    ts: row.createdAt.getTime(),
    ...(row.attachment ? { attachment: toAttachment(row.attachment, row.spoiler) } : {}),
    ...(row.system ? { system: true } : {}),
    ...(Object.keys(reactions).length ? { reactions } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    ...(row.editedAt ? { editedTs: row.editedAt.getTime() } : {}),
  };
}

@Injectable()
export class ChatService implements OnModuleInit {
  /** channel_id → время последней НЕсистемной реплики. Кэш, см. шапку файла. */
  private readonly lastActivity = new Map<string, number>();

  constructor(
    private readonly db: DataSource,
    private readonly registry: RegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.warmActivity();
  }

  /** Имя socket.io-комнаты текстового канала по его слагу. */
  room(slug: string): string {
    return CHAT_PREFIX + slug;
  }

  /** Слаг канала по имени его комнаты. */
  slug(room: string): string {
    return room.slice(CHAT_PREFIX.length);
  }

  /**
   * Последняя страница канала — то, что человек видит, войдя в него. Идём от
   * свежих к старым (индекс по (channel_id, created_at, id)), затем
   * переворачиваем: лента читается сверху вниз.
   */
  async history(slug: string): Promise<Page> {
    const channelId = this.channelId(slug);
    if (!channelId) return { messages: [], more: false };
    const rows = await this.feed().where('m.channel_id = :channelId', { channelId }).getMany();
    return this.page(rows);
  }

  /**
   * Страница выше курсора. Курсор — «время и id самой верхней показанной
   * реплики»: одного времени мало, в миллисекунду попадает несколько реплик, и
   * такая страница их бы теряла или показывала дважды.
   */
  async older(slug: string, beforeTs: number, beforeId: string): Promise<Page> {
    const channelId = this.channelId(slug);
    if (!channelId || !isUuid(beforeId)) return { messages: [], more: false };
    const rows = await this.feed()
      .where('m.channel_id = :channelId', { channelId })
      .andWhere('(m.created_at, m.id) < (:beforeAt, :beforeId)', {
        beforeAt: new Date(beforeTs),
        beforeId,
      })
      .getMany();
    return this.page(rows);
  }

  /**
   * Страница ниже курсора — то, чего до поиска не требовалось. Лента читается
   * сверху вниз и всегда упиралась в живой конец канала; из поиска человек
   * попадает в середину истории, и «дальше» для него означает вниз.
   */
  async newer(slug: string, afterTs: number, afterId: string): Promise<FeedWindow> {
    const channelId = this.channelId(slug);
    if (!channelId || !isUuid(afterId)) return { messages: [], more: false, moreAfter: false };
    const rows = await this.db
      .getRepository(MessageRow)
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.attachment', 'a')
      .leftJoinAndSelect('m.authorIdentity', 'ai')
      .where('m.channel_id = :channelId', { channelId })
      .andWhere('(m.created_at, m.id) > (:afterAt, :afterId)', {
        afterAt: new Date(afterTs),
        afterId,
      })
      .orderBy('m.createdAt', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .limit(PAGE_SIZE + 1)
      .getMany();
    const moreAfter = rows.length > PAGE_SIZE;
    const slice = moreAfter ? rows.slice(0, PAGE_SIZE) : rows;
    return { messages: slice.map(toMessage), more: false, moreAfter };
  }

  /**
   * Окно вокруг реплики: она сама, соседи сверху и соседи снизу.
   *
   * Двумя запросами, а не одним с `OFFSET`: «двадцать пять до» и «двадцать пять
   * после» — это два разных обхода одного индекса, и каждый читает ровно
   * столько строк, сколько отдаёт.
   */
  async around(slug: string, id: string): Promise<FeedWindow> {
    const empty = { messages: [], more: false, moreAfter: false };
    const channelId = this.channelId(slug);
    if (!channelId || !isUuid(id)) return empty;
    const target = await this.db.getRepository(MessageRow).findOne({
      where: { id, channelId },
      relations: { attachment: true, authorIdentity: true },
    });
    // Реплики нет — её удалили, пока человек читал результаты поиска. Пустое
    // окно здесь честнее последней страницы канала: «нашли, но показать нечего»
    // и «вот вам живой конец» — разные ответы, и клиент их различает.
    if (!target) return empty;

    const at = target.createdAt;
    const [before, after] = await Promise.all([
      this.db
        .getRepository(MessageRow)
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.attachment', 'a')
        .leftJoinAndSelect('m.authorIdentity', 'ai')
        .where('m.channel_id = :channelId', { channelId })
        .andWhere('(m.created_at, m.id) < (:at, :id)', { at, id })
        .orderBy('m.createdAt', 'DESC')
        .addOrderBy('m.id', 'DESC')
        .limit(AROUND_HALF + 1)
        .getMany(),
      this.db
        .getRepository(MessageRow)
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.attachment', 'a')
        .leftJoinAndSelect('m.authorIdentity', 'ai')
        .where('m.channel_id = :channelId', { channelId })
        .andWhere('(m.created_at, m.id) > (:at, :id)', { at, id })
        .orderBy('m.createdAt', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .limit(AROUND_HALF + 1)
        .getMany(),
    ]);

    const more = before.length > AROUND_HALF;
    const moreAfter = after.length > AROUND_HALF;
    const top = (more ? before.slice(0, AROUND_HALF) : before).reverse();
    const bottom = moreAfter ? after.slice(0, AROUND_HALF) : after;
    return { messages: [...top, target, ...bottom].map(toMessage), more, moreAfter };
  }

  /**
   * Поиск по истории. Каналы приходят списком — гейтвей уже отобрал те, что
   * человеку видно, и решать это здесь второй раз значило бы завести второе
   * место, где живут права.
   *
   * Порядок — по времени, а не по релевантности: в чате ищут не «самое
   * подходящее», а «то, что говорили тогда», и свежее почти всегда нужнее.
   * Заодно это делает курсор тем же, что у ленты, — время и id.
   */
  async search(channelIds: string[], query: string, cursor?: Cursor): Promise<SearchPage> {
    const terms = searchTerms(query);
    if (!terms.length || channelIds.length === 0) return { hits: [], more: false };

    const qb = this.db
      .getRepository(MessageRow)
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.attachment', 'a')
      .leftJoinAndSelect('m.authorIdentity', 'ai')
      .where('m.channel_id IN (:...channelIds)', { channelIds })
      // Системные строки — «история истекла», «удалено владельцем» — не то, что
      // человек искал: он ищет сказанное людьми.
      .andWhere('m.system = false')
      .andWhere(`to_tsvector('${SEARCH_CONFIG}', m.text) @@ to_tsquery('${SEARCH_CONFIG}', :q)`, {
        q: tsquery(terms),
      })
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(SEARCH_PAGE_SIZE + 1);

    if (cursor && isUuid(cursor.id)) {
      qb.andWhere('(m.created_at, m.id) < (:beforeAt, :beforeId)', {
        beforeAt: new Date(cursor.ts),
        beforeId: cursor.id,
      });
    }

    const rows = await qb.getMany();
    const more = rows.length > SEARCH_PAGE_SIZE;
    const slice = more ? rows.slice(0, SEARCH_PAGE_SIZE) : rows;
    return {
      hits: slice.flatMap((row) => {
        const slug = this.slugOf(row.channelId);
        return slug ? [{ slug, message: toMessage(row) }] : [];
      }),
      more,
    };
  }

  /**
   * Новая реплика. Возвращает то, что уйдёт в эфир: id и время назначает база,
   * а не отправитель, — иначе курсор пагинации зависел бы от часов клиента и
   * от того, в каком порядке два сообщения дошли до сервера.
   */
  async add(slug: string, input: NewMessage): Promise<ChatMessage | undefined> {
    const channelId = this.channelId(slug);
    if (!channelId) return undefined;

    const id = randomUUID();
    await this.db
      .getRepository(MessageRow)
      .createQueryBuilder()
      .insert()
      .values({
        id,
        channelId,
        authorName: input.name,
        text: input.text,
        system: false,
        spoiler: input.spoiler === true,
        reactions: {},
        attachmentId: (await this.attachmentId(input.uploadId)) ?? null,
        replyTo: await this.replySnapshot(channelId, input.replyToId),
        editedAt: null,
        authorIdentityId: input.identityId ?? null,
      })
      .execute();

    // Читаем записанное обратно, а не собираем ответ из того, что отправили:
    // время ставила база, вложение лежит отдельной строкой, и второй сборкой
    // тех же данных руками мы бы завели второе место, где они могут разойтись.
    const saved = await this.one(slug, id, true);
    if (saved) this.lastActivity.set(channelId, saved.ts);
    return saved;
  }

  /** Несистемная реплика канала по id (системные не правятся и не удаляются). */
  async find(slug: string, id: string): Promise<ChatMessage | undefined> {
    return this.one(slug, id, false);
  }

  /** Реплика по id, включая системные — реакции можно ставить на любую. */
  async findAny(slug: string, id: string): Promise<ChatMessage | undefined> {
    return this.one(slug, id, true);
  }

  /**
   * Личность автора реплики. Тем и отличается от имени в ленте, что имя —
   * снимок момента и не уникально, а модерация обязана попасть в того самого
   * человека. `null` — у реплики нет автора-личности: её писал гость по
   * инвайту или она старше самих личностей.
   */
  async authorOf(slug: string, id: string): Promise<string | null> {
    const channelId = this.channelId(slug);
    if (!channelId || !isUuid(id)) return null;
    const row = await this.db.getRepository(MessageRow).findOne({
      where: { id, channelId },
      select: { authorIdentityId: true },
    });
    return row?.authorIdentityId ?? null;
  }

  /** Новый текст своей реплики. Возвращает время правки — тоже с часов базы. */
  async edit(id: string, text: string): Promise<number> {
    const res = await this.db
      .getRepository(MessageRow)
      .createQueryBuilder()
      .update()
      .set({ text, editedAt: () => 'now()' })
      .where({ id })
      .returning('edited_at')
      .execute();
    return new Date(res.raw[0].edited_at).getTime();
  }

  /** Убирает реплику из ленты. `false` — такой в канале нет. */
  async remove(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const res = await this.db.getRepository(MessageRow).delete({ id });
    return (res.affected ?? 0) > 0;
  }

  /** Записывает новый набор реакций реплики. */
  async saveReactions(id: string, reactions: ReactionMap): Promise<void> {
    await this.db.getRepository(MessageRow).update({ id }, { reactions });
  }

  /**
   * Канал удалён — его лента ушла вместе с ним (ON DELETE CASCADE), здесь
   * остаётся забыть кэш активности.
   */
  forget(slug: string): void {
    const channelId = this.channelId(slug);
    if (channelId) this.lastActivity.delete(channelId);
  }

  /** Сколько реплик в канале (для диалога подтверждения удаления). */
  async count(slug: string): Promise<number> {
    const channelId = this.channelId(slug);
    if (!channelId) return 0;
    return this.db.getRepository(MessageRow).countBy({ channelId });
  }

  /**
   * Время последней НЕсистемной реплики канала (0 — писать ещё не начинали).
   * Системные строки активностью не считаем: точку «непрочитано» зажигают
   * только сообщения — ровно те же, что рассылают `chat-activity`.
   */
  lastTs(slug: string): number {
    const channelId = this.channelId(slug);
    return (channelId && this.lastActivity.get(channelId)) || 0;
  }

  /** Знаем ли мы такую реакцию (набор закрытый — произвольные эмодзи не носим). */
  knownReaction(emoji: string): boolean {
    return REACTION_EMOJIS.has(emoji);
  }

  /** Тогл реакции: повторный эмодзи снимает свою. Возвращает новый набор. */
  toggleReaction(msg: ChatMessage, name: string, emoji: string): ReactionMap {
    const reactions: ReactionMap = { ...(msg.reactions ?? {}) };
    const list = reactions[emoji] ?? [];
    if (list.includes(name)) {
      const next = list.filter((n) => n !== name);
      if (next.length) reactions[emoji] = next;
      else delete reactions[emoji];
    } else {
      reactions[emoji] = [...list, name];
    }
    return reactions;
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  /** Текстовый канал с таким слагом — из реестра в памяти, без похода в базу. */
  private channelId(slug: string): string | undefined {
    return this.registry.channels.find((c) => c.type === 'text' && c.slug === slug)?.id;
  }

  /**
   * Обратный ход: слаг канала по его id. Нужен поиску — в базе у реплики
   * записан id канала, а клиент оперирует слагами, и переводить одно в другое
   * должна та сторона, у которой реестр под рукой.
   */
  private slugOf(channelId: string): string | undefined {
    return this.registry.channels.find((c) => c.id === channelId)?.slug;
  }

  /**
   * Запрос ленты: свежие первыми, на одну больше страницы. Эта лишняя запись и
   * есть ответ на вопрос «есть ли выше ещё» — считать общее число реплик
   * канала ради одного булева значения было бы расточительно.
   */
  private feed() {
    return (
      this.db
        .getRepository(MessageRow)
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.attachment', 'a')
        .leftJoinAndSelect('m.authorIdentity', 'ai')
        .orderBy('m.createdAt', 'DESC')
        .addOrderBy('m.id', 'DESC')
        // `limit`, а не `take`: вложение — связь «многие к одному», лишних строк
        // от неё не бывает, и городить ради этого подзапрос с DISTINCT незачем.
        .limit(PAGE_SIZE + 1)
    );
  }

  private page(rows: MessageRow[]): Page {
    const more = rows.length > PAGE_SIZE;
    const slice = more ? rows.slice(0, PAGE_SIZE) : rows;
    return { messages: slice.reverse().map(toMessage), more };
  }

  private async one(
    slug: string,
    id: string,
    includeSystem: boolean,
  ): Promise<ChatMessage | undefined> {
    const channelId = this.channelId(slug);
    if (!channelId || !isUuid(id)) return undefined;
    const row = await this.db.getRepository(MessageRow).findOne({
      where: { id, channelId, ...(includeSystem ? {} : { system: false }) },
      relations: { attachment: true, authorIdentity: true },
    });
    return row ? toMessage(row) : undefined;
  }

  /** Загрузка существует? Клиент называет её id, а не url и не mime. */
  private async attachmentId(uploadId: string | undefined): Promise<string | undefined> {
    if (!uploadId) return undefined;
    const row = await this.db.getRepository(AttachmentRow).findOneBy({ id: uploadId });
    return row?.id;
  }

  /**
   * Снимок цитируемого (id, имя, обрезанный текст) — копией, а не ссылкой:
   * оригинал могут отредактировать или удалить, цитата остаётся прежней.
   */
  private async replySnapshot(
    channelId: string,
    replyToId: string | undefined,
  ): Promise<ReplyRef | null> {
    if (!replyToId || !isUuid(replyToId)) return null;
    const src = await this.db
      .getRepository(MessageRow)
      .findOneBy({ id: replyToId, channelId, system: false });
    if (!src) return null;
    return { id: src.id, name: src.authorName, text: src.text.slice(0, 140) };
  }

  /**
   * Кэш активности при старте — одним запросом на всю базу. Без него первая
   * рассылка реестра показала бы все каналы «без единого сообщения», и
   * «непрочитано» зажглось бы только после чьей-то новой реплики.
   */
  private async warmActivity(): Promise<void> {
    const rows: { channel_id: string; last: Date }[] = await this.db
      .getRepository(MessageRow)
      .createQueryBuilder('m')
      .select('m.channel_id', 'channel_id')
      .addSelect('MAX(m.created_at)', 'last')
      .where('m.system = false')
      .groupBy('m.channel_id')
      .getRawMany();
    this.lastActivity.clear();
    for (const r of rows) this.lastActivity.set(r.channel_id, new Date(r.last).getTime());
  }
}

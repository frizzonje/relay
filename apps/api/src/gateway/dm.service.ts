import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ChannelRow, ConversationRow } from '../db/entities';

/** Адрес беседы всегда начинается с этого — по нему её и узнают в ленте. */
export const DM_PREFIX = 'dm-';

/** Сколько знаков хэша в адресе. 24 знака шестнадцатеричных — 96 бит. */
const ADDRESS_LEN = 24;

/** Докуда обрезается превью последней реплики в списке переписок. */
export const DM_PREVIEW_LIMIT = 120;

/** Сколько людей отдаётся на один запрос `dm-people`. */
export const DM_PEOPLE_LIMIT = 30;

export interface DmPeerView {
  fingerprint: string;
  nick: string;
}

export interface DmConversationView {
  /** Адрес беседы — он же слаг и id её канала. */
  slug: string;
  peer: DmPeerView;
  /** Время последней реплики; 0 — переписки ещё не было. */
  lastTs: number;
  preview: string;
  /** Последняя реплика — моя. По ней список рисует «вы: …». */
  previewMine: boolean;
}

export type DmOpenFailure = 'unknown' | 'self';

/** Беседа так, как её держит память: без похода в базу на каждую реплику. */
interface Known {
  a: string;
  b: string;
}

/**
 * Личные сообщения: кто с кем говорит.
 *
 * Хранение реплик сюда не переезжает — оно в `chat.service.ts` и одинаково для
 * канала и для беседы. Здесь ровно то, чего у канала нет: **адрес пары и
 * членство**. Канал видно из реестра, и вход в него решается видимостью; беседу
 * не видно ниоткуда, и вход в неё решается вопросом «ты одна из двух сторон?».
 *
 * Ответ на этот вопрос лежит в памяти, а не спрашивается у базы: его задают на
 * каждой реплике, на каждой правке и на каждом «печатает…», то есть в самом
 * горячем месте гейтвея. Карта заполняется на старте и растёт по одной строке
 * при каждом открытии — беседы не удаляются, поэтому расхождения с базой у неё
 * взяться неоткуда.
 */
@Injectable()
export class DmService implements OnModuleInit {
  private readonly logger = new Logger('dm');

  /** адрес → пара личностей. Заполняется на старте, растёт при открытии. */
  private readonly known = new Map<string, Known>();

  /**
   * Лицо и подпись каждой личности — для списка переписок собеседника. Растёт
   * так же, как `known`: на старте одним запросом, дальше — по одной строке на
   * каждое открытие и по звонку `rememberNick` на переименование.
   */
  private readonly nicks = new Map<string, DmPeerView>();

  constructor(private readonly db: DataSource) {}

  async onModuleInit(): Promise<void> {
    const conversations = await this.db.getRepository(ConversationRow).find();
    for (const row of conversations) this.known.set(row.channelId, { a: row.a, b: row.b });

    const identities: Array<{ id: string; fingerprint: string; nick: string }> =
      await this.db.query('SELECT id, fingerprint, nick FROM identities');
    for (const row of identities)
      this.nicks.set(row.id, { fingerprint: row.fingerprint, nick: row.nick });

    this.logger.log(`бесед в памяти: ${this.known.size}`);
  }

  /**
   * Адрес беседы двоих. Считается из двух id и только из них, поэтому обе
   * стороны приходят к одному адресу, ни о чём не договариваясь, — и поэтому
   * же открытие беседы не гонка: второй insert упирается в уникальный ключ.
   *
   * Хэш, а не «id через дефис»: адрес виден в протоколе и в отладочных логах, а
   * id личности — внутренний ключ, которому там делать нечего.
   */
  static address(aId: string, bId: string): string {
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    const hash = createHash('sha256').update(`${a}:${b}`).digest('hex');
    return DM_PREFIX + hash.slice(0, ADDRESS_LEN);
  }

  /**
   * Открыть беседу с этим отпечатком. Идемпотентно: второй вызов (и вызов с
   * другой стороны) возвращает ту же беседу, а не заводит вторую.
   */
  async open(
    meId: string,
    peerFingerprint: string,
  ): Promise<{ ok: true; view: DmConversationView } | { ok: false; reason: DmOpenFailure }> {
    // Обе стороны одним запросом: собеседник — по отпечатку, я — по id.
    // `nicks` обязана расти по обеим половинам беседы (см. комментарий у поля
    // `nicks`): открыл я — и в чужом процессе, где я окажусь чьим-то `peer`,
    // и в моём собственном, где я сам себе `meId`, должно быть чем ответить
    // на `peerView`.
    const rows: Array<{ id: string; fingerprint: string; nick: string }> = await this.db.query(
      'SELECT id, fingerprint, nick FROM identities WHERE fingerprint = $1 OR id = $2',
      [peerFingerprint, meId],
    );
    const peer = rows.find((r) => r.fingerprint === peerFingerprint);
    if (!peer) return { ok: false, reason: 'unknown' };
    if (peer.id === meId) return { ok: false, reason: 'self' };

    const slug = DmService.address(meId, peer.id);
    if (!this.known.has(slug)) await this.create(slug, meId, peer.id);
    for (const row of rows)
      this.nicks.set(row.id, { fingerprint: row.fingerprint, nick: row.nick });

    const [last] = await this.previews([slug], meId);
    return {
      ok: true,
      view: {
        slug,
        peer: { fingerprint: peer.fingerprint, nick: peer.nick },
        lastTs: last?.lastTs ?? 0,
        preview: last?.preview ?? '',
        previewMine: last?.previewMine ?? false,
      },
    };
  }

  isDm(slug: string): boolean {
    return this.known.has(slug);
  }

  channelIdOf(slug: string): string | undefined {
    return this.known.has(slug) ? slug : undefined;
  }

  membersOf(slug: string): [string, string] | undefined {
    const pair = this.known.get(slug);
    return pair ? [pair.a, pair.b] : undefined;
  }

  isMember(slug: string, identityId: string): boolean {
    const pair = this.known.get(slug);
    return !!pair && (pair.a === identityId || pair.b === identityId);
  }

  /**
   * Мои переписки, свежие сверху. Пустые (открыл и не написал) остаются в
   * списке: закрытая переписка не должна исчезать из раздела оттого, что в ней
   * пока нечего показать.
   */
  async list(meId: string): Promise<DmConversationView[]> {
    const rows: Array<{ channel_id: string; peer_fingerprint: string; peer_nick: string }> =
      await this.db.query(
        `SELECT c.channel_id,
                i.fingerprint AS peer_fingerprint,
                i.nick        AS peer_nick
           FROM conversations c
           JOIN identities i ON i.id = CASE WHEN c.a = $1 THEN c.b ELSE c.a END
          WHERE c.a = $1 OR c.b = $1`,
        [meId],
      );
    if (!rows.length) return [];

    const previews = new Map(
      (
        await this.previews(
          rows.map((r) => r.channel_id),
          meId,
        )
      ).map((p) => [p.slug, p]),
    );
    return rows
      .map((row) => {
        const p = previews.get(row.channel_id);
        return {
          slug: row.channel_id,
          peer: { fingerprint: row.peer_fingerprint, nick: row.peer_nick },
          lastTs: p?.lastTs ?? 0,
          preview: p?.preview ?? '',
          previewMine: p?.previewMine ?? false,
        };
      })
      .sort((x, y) => y.lastTs - x.lastTs);
  }

  /**
   * Кого инсталляция уже видела. Забаненных на всю инсталляцию не показываем:
   * им всё равно не доставить, а строка в списке выглядела бы как живой
   * человек.
   */
  async people(
    meId: string,
    query: string,
    limit: number,
  ): Promise<Array<DmPeerView & { lastSeenTs: number }>> {
    const like = `%${query.trim().toLowerCase()}%`;
    const rows: Array<{ fingerprint: string; nick: string; last_seen_at: Date | null }> =
      await this.db.query(
        `SELECT i.fingerprint, i.nick, i.last_seen_at
           FROM identities i
          WHERE i.id <> $1
            AND NOT EXISTS (
                  SELECT 1 FROM roles r
                   WHERE r.identity_id = i.id AND r.server_id IS NULL AND r.role = 'banned')
            AND ($2 = '%%' OR lower(i.nick) LIKE $2 OR lower(i.fingerprint) LIKE $2)
          ORDER BY i.last_seen_at DESC NULLS LAST, i.nick ASC
          LIMIT $3`,
        [meId, like, limit],
      );
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      nick: r.nick,
      lastSeenTs: r.last_seen_at ? r.last_seen_at.getTime() : 0,
    }));
  }

  /** Адреса моих бесед — по памяти, без базы (нужно отметкам чтения). */
  slugsOf(identityId: string): string[] {
    const slugs: string[] = [];
    for (const [slug, pair] of this.known) {
      if (pair.a === identityId || pair.b === identityId) slugs.push(slug);
    }
    return slugs;
  }

  /** Как показать эту личность собеседнику: лицо и подпись. */
  peerView(identityId: string): DmPeerView | undefined {
    return this.nicks.get(identityId);
  }

  /** Человек переименовался — подпись в списке переписок обязана это узнать. */
  rememberNick(identityId: string, nick: string): void {
    const known = this.nicks.get(identityId);
    if (known) known.nick = nick;
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  /**
   * Канал беседы и сама беседа — одной транзакцией. Слаг канала равен его id и
   * адресу: три имени одному и тому же, чтобы `chat.service` мог перевести
   * комнату в канал не спрашивая никого.
   *
   * `orIgnore` на обеих вставках — не оптимизация, а разрешение гонки: два
   * человека могут вызвать `open` одновременно с обеих сторон, у обоих один и
   * тот же `slug`, и один из двух insert обязан молча проиграть, а не упасть
   * ошибкой уникальности наружу к вызывающему.
   */
  private async create(slug: string, meId: string, peerId: string): Promise<void> {
    const [a, b] = meId < peerId ? [meId, peerId] : [peerId, meId];
    await this.db.transaction(async (m) => {
      await m
        .getRepository(ChannelRow)
        .createQueryBuilder()
        .insert()
        .values({
          id: slug,
          serverId: null,
          type: 'dm',
          name: slug,
          slug,
          removable: true,
          mode: null,
          creatorId: null,
          creatorIdentityId: null,
          position: 0,
        })
        .orIgnore()
        .execute();
      await m
        .getRepository(ConversationRow)
        .createQueryBuilder()
        .insert()
        .values({ id: randomUUID(), channelId: slug, a, b, createdAt: new Date() })
        .orIgnore()
        .execute();
    });
    this.known.set(slug, { a, b });
  }

  /**
   * Последняя реплика каждой из бесед — одним запросом на весь список.
   * Отдельным запросом на переписку это была бы та же лента, прочитанная
   * тридцать раз ради тридцати строк превью.
   */
  private async previews(
    slugs: string[],
    meId: string,
  ): Promise<Array<{ slug: string; lastTs: number; preview: string; previewMine: boolean }>> {
    if (!slugs.length) return [];
    const rows: Array<{
      channel_id: string;
      text: string;
      created_at: Date;
      author_identity_id: string | null;
    }> = await this.db.query(
      `SELECT DISTINCT ON (m.channel_id)
              m.channel_id, m.text, m.created_at, m.author_identity_id
         FROM messages m
        WHERE m.channel_id = ANY($1)
        ORDER BY m.channel_id, m.created_at DESC, m.id DESC`,
      [slugs],
    );
    return rows.map((r) => ({
      slug: r.channel_id,
      lastTs: r.created_at.getTime(),
      preview: r.text.slice(0, DM_PREVIEW_LIMIT),
      previewMine: r.author_identity_id === meId,
    }));
  }
}

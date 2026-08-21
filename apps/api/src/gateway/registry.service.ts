import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { DataSource, type EntityManager } from 'typeorm';
import { ChannelRow, ServerRow } from '../db/entities';
import { Channel, MIGRATED_MARKER, REGISTRY_FILE, ServerEntry, loadRegistry } from './registry';
import { type Claimant, type PublicServer, ownedBy, publicServer } from './ownership';

/**
 * Реестр серверов и каналов: что вообще существует, кому оно видно и кому
 * позволено это менять.
 *
 * Живёт в Postgres, но в памяти держится целиком — и это не кэш «на всякий
 * случай». Видимость канала спрашивают на каждую рассылку присутствия, на
 * каждое сообщение и на каждый вход: два десятка серверов и полсотни каналов
 * стоят килобайты, а поход в базу за ними стоил бы запроса на каждый чих.
 * База — источник правды при старте и место, куда всё это доезжает; правила
 * видимости считаются здесь.
 *
 * Права владения — в `./ownership`, чтение старого файлового реестра (переезд с
 * 0.x) — в `./registry`. Гейтвей поверх этого добавляет ровно одно — сокет: кто
 * спрашивает и куда уходит ответ.
 *
 * Слой ролей плана 1.0 приземляется сюда: «кому позволено» — это `editable` и
 * `canSee`, и больше нигде.
 */

/** Главный сервер relay — неудаляем; его id носят все каналы по умолчанию. */
export const MAIN_SERVER_ID = 'relay-main';

/**
 * Потолки. Их два вида, и они про разное (audit S2).
 *
 * Потолок инсталляции — про машину: реестр целиком лежит в памяти и целиком
 * уезжает каждому сокету при любой правке. Личный — про то, чтобы этот потолок
 * не выбрал один человек: до 1.0 числа были только общие, и двадцати серверов
 * хватало одному, чтобы никто на инсталляции не завёл больше ни одного.
 * Каналы считаются по своему серверу по той же причине: чужой сервер не должен
 * уметь занять место в твоём.
 *
 * От того, кто заводит ключи пачкой, личные потолки не спасают и не должны:
 * ключи здесь бесплатны by design, и заслон от такого — ворота инсталляции
 * (`SITE_PASSWORD`), а не число в реестре.
 */
export const MAX_SERVERS = 50;
export const MAX_SERVERS_PER_PERSON = 5;
export const MAX_CHANNELS = 300;
export const MAX_CHANNELS_PER_SERVER = 25;

// Серверы по умолчанию — только главный. Участники добавляют свои через «+» в
// рейке. Клиент держит такой же сид (lib/constants).
const DEFAULT_SERVERS: ServerEntry[] = [{ id: MAIN_SERVER_ID, name: 'relay', removable: false }];

// Каналы главного сервера. Набор фиксирован: ровно два голосовых (прямой и
// через медиасервер — чтобы разницу можно было услышать, не заводя своего
// сервера) и один текстовый. Ни создать четвёртый, ни удалить, ни
// переименовать эти нельзя — все запреты держит сам сервер, не интерфейс.
// Клиент держит такой же сид (lib/constants) — id/slug совпадают.
const DEFAULT_CHANNELS: Channel[] = [
  {
    id: 'text-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'text',
    name: 'общий',
    slug: 'obshchii',
    removable: false,
  },
  {
    id: 'voice-obshchii',
    serverId: MAIN_SERVER_ID,
    type: 'voice',
    name: 'P2P общий',
    slug: 'voice-obshchii',
    removable: false,
  },
  {
    id: 'voice-obshchii-sfu',
    serverId: MAIN_SERVER_ID,
    type: 'voice',
    name: 'SFU общий',
    slug: 'voice-obshchii-sfu',
    removable: false,
    // Медиасервер поднят не везде: если его нет, клиент не получит пропуск
    // (`sfu-token` → not-sfu/unavailable) и штатно позвонит напрямую.
    mode: 'sfu',
  },
];

// Каналы, которые были дефолтными раньше. persist() пишет на диск весь список
// вместе с дефолтами, поэтому выпавший из DEFAULT_CHANNELS канал вернулся бы
// из registry.json как «сохранённый пользовательский» — и главный сервер
// навсегда остался бы с лишней строкой. Вычищаем их по id при загрузке.
const RETIRED_CHANNEL_IDS = new Set(['text-general']);

// Дефолты — источник правды: копируем их первыми, затем добавляем сохранённые
// записи с новыми id (созданные пользователями). Так дефолты всегда актуальны,
// а их изменение между версиями не перетирается старым файлом.
function mergeById<T extends { id: string }>(defaults: T[], saved: T[] | undefined): T[] {
  const out = defaults.map((d) => ({ ...d }));
  const seen = new Set(out.map((d) => d.id));
  for (const item of saved ?? []) {
    if (item && typeof item.id === 'string' && !seen.has(item.id)) {
      out.push(item);
      seen.add(item.id);
    }
  }
  return out;
}

/**
 * Строка базы → запись реестра. Пустые поля выкидываем, а не носим как `null`:
 * в памяти и в протоколе их форма — «поля нет», и такой она была всегда.
 */
function toServerEntry(row: ServerRow): ServerEntry {
  return {
    id: row.id,
    name: row.name,
    removable: row.removable,
    ...(row.emoji ? { emoji: row.emoji } : {}),
    ...(row.passwordHash ? { passwordHash: row.passwordHash } : {}),
    ...(row.creatorId ? { creatorId: row.creatorId } : {}),
    ...(row.creatorIdentityId ? { creatorIdentityId: row.creatorIdentityId } : {}),
  };
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    serverId: row.serverId,
    type: row.type as Channel['type'],
    name: row.name,
    slug: row.slug,
    removable: row.removable,
    ...(row.mode ? { mode: row.mode as Channel['mode'] } : {}),
    ...(row.creatorId ? { creatorId: row.creatorId } : {}),
    ...(row.creatorIdentityId ? { creatorIdentityId: row.creatorIdentityId } : {}),
  };
}

/**
 * Развод одинаковых слагов при переезде. До 1.0 слаг ничем не проверялся, и два
 * канала одного типа могли получить один и тот же — они молча делили комнату
 * socket.io и историю на двоих. В базе такая пара просто не поместится
 * (уникальный индекс), поэтому второму и следующим дописываем номер.
 *
 * Переименование заметно человеку, но альтернатива — уронить переезд целиком
 * или потерять канал, а это хуже.
 */
function dedupeSlugs(channels: Channel[]): Channel[] {
  const taken = new Set<string>();
  return channels.map((c) => {
    let slug = c.slug;
    for (let n = 2; taken.has(c.type + '\0' + slug); n += 1) {
      slug = `${c.slug}-${n}`.slice(0, 32);
    }
    taken.add(c.type + '\0' + slug);
    return slug === c.slug ? c : { ...c, slug };
  });
}

/**
 * Слаг направления из произвольного ввода: строчные, пробелы → дефис, только
 * буквы/цифры/дефис/подчёркивание (кириллица сохраняется), схлопываем дубли, 32.
 */
export function slugifyChannel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Хвост слага: шесть знаков от id сервера. */
const SERVER_MARK = 6;

/**
 * Адрес комнаты для нового канала: слаг имени плюс метка своего сервера.
 *
 * Метка нужна потому, что слаг уникален по всей инсталляции — по нему
 * ключуются комната socket.io и лента чата, — а имена каналов у людей
 * повторяются: «общий» и «болталка» заводит каждый второй. Без метки первый
 * такой канал занимал бы имя у всех остальных серверов разом, а отказ во
 * втором был бы ответом на вопрос, который спрашивать не давали: «есть ли на
 * этой инсталляции скрытый канал с таким именем» (audit S2). Теперь
 * столкнуться можно только со своим же каналом на своём же сервере — то есть с
 * тем, что и так видно в списке.
 *
 * Человеку метка не показывается нигде: в интерфейсе канал зовут его именем, а
 * слаг — это адрес, и живёт он в протоколе. Каналы главного сервера метки не
 * носят: их набор фиксирован, заводить там нечего, а их слаги знают наизусть и
 * клиенты, и приглашения.
 */
export function channelSlug(name: string, serverId: string): string {
  const base = slugifyChannel(name);
  if (!base || serverId === MAIN_SERVER_ID) return base;
  const mark = createHash('sha256').update(serverId).digest('hex').slice(0, SERVER_MARK);
  return `${base.slice(0, 32 - SERVER_MARK - 1)}-${mark}`;
}

/**
 * Убрать из таблицы всё, чего нет в этом списке id. Пустой список означает
 * «не осталось ничего» и обязан очищать таблицу, а не падать.
 */
async function deleteMissing(
  m: EntityManager,
  entity: typeof ServerRow | typeof ChannelRow,
  keep: string[],
): Promise<void> {
  const qb = m.createQueryBuilder().delete().from(entity);
  if (keep.length) qb.where('id NOT IN (:...keep)', { keep });
  await qb.execute();
}

/** Отказ в правке канала — теми же кодами, что уходят клиенту ack'ом. */
export type EditError = 'not-found' | 'forbidden' | 'not-owner';

@Injectable()
export class RegistryService implements OnModuleInit {
  private readonly logger = new Logger(RegistryService.name);

  /** Реестр серверов (гильдий), общий на инсталляцию. Переживает рестарт. */
  readonly servers: ServerEntry[] = [];

  /** Реестр направлений, общий на инсталляцию. Тоже из базы и в базу. */
  readonly channels: Channel[] = [];

  /**
   * Очередь записей. Реестр пишется целиком, и две одновременные записи
   * означали бы гонку двух полных снимков: кто последний, того и реестр.
   * Поэтому они выстраиваются в цепочку — а `flush()` позволяет её дождаться
   * (тестам и выключению).
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Пути старого файлового реестра — параметры экземпляра, а не константы
   * модуля: тесту нужен свой каталог, а перезагружать ради этого модуль
   * нельзя — вместе с ним перезагрузятся сущности, и открытое соединение
   * перестанет их узнавать.
   *
   * `@Optional()` обязателен: значения по умолчанию в конструкторе — это
   * договорённость TypeScript, а Nest видит только эмитированные типы и честно
   * ищет провайдер для `String`. Без него приложение не поднимается вовсе.
   */
  constructor(
    private readonly db: DataSource,
    @Optional() private readonly legacyFile: string = REGISTRY_FILE,
    @Optional() private readonly migratedMarker: string = MIGRATED_MARKER,
  ) {}

  /**
   * Nest ждёт этот метод до того, как поднимется порт: реестр обязан быть в
   * памяти раньше, чем придёт первый сокет.
   */
  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Поднимаем реестр из базы и подмешиваем дефолты. Каналы «сирот» (сервер
   * которых не существует) отбрасываем — иначе повиснут вне рейки. Дефолты
   * первыми: они источник правды, и их изменение между версиями не должно
   * перетираться сохранённым.
   *
   * Перед первым чтением — переезд со старого файлового реестра, если он ещё
   * не состоялся.
   */
  async load(): Promise<void> {
    await this.importLegacy();

    const [servers, channels] = await Promise.all([
      this.db.getRepository(ServerRow).find({ order: { position: 'ASC' } }),
      this.db.getRepository(ChannelRow).find({ order: { position: 'ASC' } }),
    ]);

    this.servers.length = 0;
    this.servers.push(...mergeById(DEFAULT_SERVERS, servers.map(toServerEntry)));
    const serverIds = new Set(this.servers.map((s) => s.id));
    this.channels.length = 0;
    this.channels.push(
      ...mergeById(DEFAULT_CHANNELS, channels.map(toChannel)).filter(
        (c) => serverIds.has(c.serverId) && !RETIRED_CHANNEL_IDS.has(c.id),
      ),
    );

    // Дефолты, отсев сирот и вычистка снятых с довольствия каналов — это
    // изменения реестра, и они обязаны доехать до базы, а не жить до рестарта.
    // `void` — не забытый `await`: очередь записи ждём следующей строкой, а
    // ошибку `persist` глушит у себя логом (см. ниже).
    void this.persist();
    await this.flush();
  }

  /**
   * Сохраняем реестр в базу. Ошибку записи не роняем на пользователя, только
   * логируем: живой реестр в памяти важнее — ровно как с диском до 1.0.
   *
   * Возвращает обещание, и его ЖДУТ: канал должен появиться в базе до того,
   * как в него напишут. Сообщение ссылается на канал внешним ключом, и
   * отложенная запись реестра означала бы отказ базы на первой же реплике в
   * только что созданном канале.
   */
  persist(): Promise<void> {
    this.queue = this.queue.then(() =>
      this.sync().catch((e) => {
        this.logger.error(`не удалось сохранить реестр: ${e}`);
      }),
    );
    return this.queue;
  }

  /** Дождаться, пока всё отправленное в `persist` доедет до базы. */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Полный снимок памяти в базу: что есть — обновляем, чего не стало —
   * удаляем. Именно так вела себя запись файла целиком, и менять эту семантику
   * на «дельту» нельзя: удаление сервера должно уносить его каналы, а удаление
   * канала — свою историю (за это отвечает ON DELETE CASCADE).
   *
   * Порядок внутри транзакции не случаен: сначала появляются серверы, потом
   * каналы (внешний ключ), удаляем в обратном порядке.
   */
  private async sync(): Promise<void> {
    await this.db.transaction(async (m: EntityManager) => {
      const serverIds = this.servers.map((s) => s.id);
      const channelIds = this.channels.map((c) => c.id);

      if (serverIds.length) {
        await m.getRepository(ServerRow).upsert(
          this.servers.map((s, position) => ({
            id: s.id,
            name: s.name,
            emoji: s.emoji ?? null,
            removable: s.removable,
            passwordHash: s.passwordHash ?? null,
            creatorId: s.creatorId ?? null,
            creatorIdentityId: s.creatorIdentityId ?? null,
            position,
          })),
          ['id'],
        );
      }
      if (channelIds.length) {
        await m.getRepository(ChannelRow).upsert(
          this.channels.map((c, position) => ({
            id: c.id,
            serverId: c.serverId,
            type: c.type,
            name: c.name,
            slug: c.slug,
            removable: c.removable,
            mode: c.mode ?? null,
            creatorId: c.creatorId ?? null,
            creatorIdentityId: c.creatorIdentityId ?? null,
            position,
          })),
          ['id'],
        );
      }
      // Удаляем построителем, а не `delete({ id: Not(In(...)) })`: пустой
      // список — законное состояние (в реестре может не остаться ни одного
      // канала), а репозиторий на пустом критерии отказывается работать
      // вовсе — и роняет вместе с собой всю транзакцию.
      await deleteMissing(m, ChannelRow, channelIds);
      await deleteMissing(m, ServerRow, serverIds);
    });
  }

  /**
   * Переезд с 0.x: `registry.json` → таблицы. Один раз, в транзакции, и после
   * него рядом с файлом ложится маркер.
   *
   * Сам файл не трогаем — это и есть цена отката: если 1.0 не пошёл,
   * инсталляция возвращается на 0.x со своими серверами и каналами. Маркер
   * нужен ровно затем, чтобы второй старт не воскресил то, что человек успел
   * удалить уже в 1.0.
   */
  private async importLegacy(): Promise<void> {
    if (existsSync(this.migratedMarker) || !existsSync(this.legacyFile)) return;

    // Битый файл loadRegistry разбирает сам: откладывает исходные байты в
    // сторону, пробует прошлую копию и кричит в лог. Сюда в худшем случае
    // придут пустые данные — осознанный, а не молчаливый худший случай.
    const saved = loadRegistry(this.legacyFile);
    const servers = (saved.data.servers ?? []).filter((s) => s && typeof s.id === 'string');
    const serverIds = new Set(servers.map((s) => s.id));
    const channels = dedupeSlugs(
      (saved.data.channels ?? []).filter(
        (c) => c && typeof c.id === 'string' && serverIds.has(c.serverId),
      ),
    );

    await this.db.transaction(async (m: EntityManager) => {
      // ON CONFLICT DO NOTHING: переезд обязан быть идемпотентным, а дефолтные
      // записи в базе уже могут быть — они старше любого файла.
      if (servers.length) {
        await m
          .getRepository(ServerRow)
          .createQueryBuilder()
          .insert()
          .values(
            servers.map((s, position) => ({
              id: s.id,
              name: s.name,
              emoji: s.emoji ?? null,
              removable: s.removable !== false,
              passwordHash: s.passwordHash ?? null,
              creatorId: s.creatorId ?? null,
              position,
            })),
          )
          .orIgnore()
          .execute();
      }
      if (channels.length) {
        await m
          .getRepository(ChannelRow)
          .createQueryBuilder()
          .insert()
          .values(
            channels.map((c, position) => ({
              id: c.id,
              serverId: c.serverId,
              type: c.type,
              name: c.name,
              slug: c.slug,
              removable: c.removable !== false,
              mode: c.mode ?? null,
              creatorId: c.creatorId ?? null,
              position,
            })),
          )
          .orIgnore()
          .execute();
      }
    });

    writeFileSync(this.migratedMarker, new Date().toISOString() + '\n');
    this.logger.log(
      `реестр переехал в базу: серверов ${servers.length}, каналов ${channels.length}. ` +
        `Исходный ${this.legacyFile} оставлен нетронутым`,
    );
  }

  server(id: string): ServerEntry | undefined {
    return this.servers.find((s) => s.id === id);
  }

  channel(id: string): Channel | undefined {
    return this.channels.find((c) => c.id === id);
  }

  /** Сервер, которому принадлежит канал (для проверки его пароля). */
  serverOf(channel: Channel): ServerEntry | undefined {
    return this.server(channel.serverId);
  }

  /**
   * Видит ли обладатель этого набора разблокировок такой канал: канал закрытого
   * сервера — только после ввода пароля.
   */
  canSee(unlocked: Set<string> | undefined, channel: Channel): boolean {
    const srv = this.serverOf(channel);
    if (!srv?.passwordHash) return true;
    return unlocked?.has(srv.id) === true;
  }

  /**
   * Чем один сокет отличается от другого с точки зрения видимости каналов:
   * списком разблокированных ЗАКРЫТЫХ серверов. Открытые видны всем и в ключ
   * не идут. По этому ключу рассылка группирует сокеты, вместо того чтобы
   * собирать реестр каждому персонально.
   */
  visibilityKey(unlocked: Set<string> | undefined): string {
    if (!unlocked?.size) return '';
    const ids: string[] = [];
    for (const s of this.servers) {
      if (s.passwordHash && unlocked.has(s.id)) ids.push(s.id);
    }
    return ids.join('\0');
  }

  /**
   * Публичная форма реестра серверов: без хэша пароля, с флагом `locked`, с
   * `unlocked` (закрытые серверы, чей пароль спрашивающий уже предъявлял) и с
   * `mine` — «этой записью управляешь ты». Наружу уходит именно флаг, а не
   * clientId владельца: рассылать id значило бы раздавать всем то единственное,
   * чем правило владения и держится (см. ./ownership).
   */
  publicServers(who: Claimant, unlocked?: Set<string>): PublicServer[] {
    return this.servers.map((s) => publicServer(s, who, unlocked));
  }

  /** Кто из создателей вообще встречается в этих записях (см. gateway.ownerKey). */
  ownerIds(entries: { creatorId?: string; creatorIdentityId?: string }[]): Set<string> {
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.creatorId) ids.add(e.creatorId);
      if (e.creatorIdentityId) ids.add(e.creatorIdentityId);
    }
    return ids;
  }

  /**
   * Канал, который позволено менять: существующий, не дефолтный, свой (создан
   * этой личностью) и — если лежит в закрытом сервере — в разблокированном.
   * Пароль сервера это и есть право на его каналы.
   *
   * У каналов без создателя (они старше самого правила владения) права прежние —
   * владельца не существует, и менять их может любой участник, как раньше.
   *
   * Порядок проверок не случаен: пароль закрытого сервера идёт ПЕРЕД владением.
   * Канал закрытого сервера для непосвящённого не существует вовсе, и разные
   * коды отказа («не твой» против «нет доступа») рассказывали бы по одному id,
   * есть ли у скрытого канала владелец.
   */
  editable(
    id: string,
    unlocked: Set<string> | undefined,
    who: Claimant,
  ): { channel: Channel; index: number } | { error: EditError } {
    const index = this.channels.findIndex((c) => c.id === id);
    if (index === -1) return { error: 'not-found' };
    const channel = this.channels[index];
    if (!channel.removable) return { error: 'forbidden' };
    const srv = this.serverOf(channel);
    if (srv?.passwordHash && !unlocked?.has(srv.id)) return { error: 'forbidden' };
    if (!ownedBy(channel, who)) return { error: 'not-owner' };
    return { channel, index };
  }
}

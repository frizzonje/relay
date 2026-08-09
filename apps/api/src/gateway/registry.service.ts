import { Injectable, Logger } from '@nestjs/common';
import { Channel, ServerEntry, loadRegistry, saveRegistry } from './registry';
import { type PublicServer, ownedBy, publicServer } from './ownership';

/**
 * Реестр серверов и каналов: что вообще существует, кому оно видно и кому
 * позволено это менять.
 *
 * Хранилище (атомарная запись, битый файл, прошлая копия) живёт в `./registry`,
 * права владения — в `./ownership`; здесь то, что между ними: сам список,
 * дефолты, пределы и правила видимости. Гейтвей поверх этого добавляет ровно
 * одно — сокет: кто спрашивает и куда уходит ответ.
 *
 * Слой ролей плана 1.0 приземляется сюда: «кому позволено» — это `editable` и
 * `canSee`, и больше нигде.
 */

/** Главный сервер relay — неудаляем; его id носят все каналы по умолчанию. */
export const MAIN_SERVER_ID = 'relay-main';

/** Потолки — общие на инсталляцию (audit S2: их можно выбрать целиком). */
export const MAX_SERVERS = 20;
export const MAX_CHANNELS = 50;

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

/** Отказ в правке канала — теми же кодами, что уходят клиенту ack'ом. */
export type EditError = 'not-found' | 'forbidden' | 'not-owner';

@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  /** Реестр серверов (гильдий), общий на инсталляцию. Переживает рестарт. */
  readonly servers: ServerEntry[];

  /** Реестр направлений, общий на инсталляцию. Тоже с диска и на диск. */
  readonly channels: Channel[];

  constructor() {
    // Поднимаем сохранённый реестр и подмешиваем дефолты. Каналы «сирот»
    // (сервер которых не существует) отбрасываем — иначе повиснут вне рейки.
    // Битый файл loadRegistry разбирает сам: откладывает исходные байты в
    // сторону, пробует прошлую копию и кричит в лог. Сюда в худшем случае
    // придут пустые данные — и это уже осознанный, а не молчаливый худший случай.
    const saved = loadRegistry().data;
    this.servers = mergeById(DEFAULT_SERVERS, saved.servers);
    const serverIds = new Set(this.servers.map((s) => s.id));
    this.channels = mergeById(DEFAULT_CHANNELS, saved.channels).filter(
      (c) => serverIds.has(c.serverId) && !RETIRED_CHANNEL_IDS.has(c.id),
    );
  }

  /**
   * Сохраняем реестр на диск (атомарно, с fsync и прошлой копией — см.
   * saveRegistry), чтобы рестарт не потерял серверы и каналы пользователей.
   * Диск-ошибку не роняем на пользователя, только логируем: живой реестр в
   * памяти важнее.
   */
  persist(): void {
    try {
      saveRegistry({ servers: this.servers, channels: this.channels });
    } catch (e) {
      this.logger.error(`не удалось сохранить реестр: ${e}`);
    }
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
   * Публичная форма реестра серверов: без хэша пароля, с флагом `locked` и с
   * `mine` — «этой записью управляешь ты». Наружу уходит именно флаг, а не
   * clientId владельца: рассылать id значило бы раздавать всем то единственное,
   * чем правило владения и держится (см. ./ownership).
   */
  publicServers(clientId: string | undefined): PublicServer[] {
    return this.servers.map((s) => publicServer(s, clientId));
  }

  /** Кто из создателей вообще встречается в этих записях (см. gateway.ownerKey). */
  ownerIds(entries: { creatorId?: string }[]): Set<string> {
    const ids = new Set<string>();
    for (const e of entries) if (e.creatorId) ids.add(e.creatorId);
    return ids;
  }

  /**
   * Канал, который позволено менять: существующий, не дефолтный, свой (создан
   * с этого устройства) и — если лежит в закрытом сервере — в разблокированном.
   * Пароль сервера это и есть право на его каналы.
   *
   * У каналов без creatorId (созданы до правила владения) права прежние —
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
    clientId: string | undefined,
  ): { channel: Channel; index: number } | { error: EditError } {
    const index = this.channels.findIndex((c) => c.id === id);
    if (index === -1) return { error: 'not-found' };
    const channel = this.channels[index];
    if (!channel.removable) return { error: 'forbidden' };
    const srv = this.serverOf(channel);
    if (srv?.passwordHash && !unlocked?.has(srv.id)) return { error: 'forbidden' };
    if (!ownedBy(channel, clientId)) return { error: 'not-owner' };
    return { channel, index };
  }
}

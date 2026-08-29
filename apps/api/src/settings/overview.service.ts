import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RetentionService } from '../db/retention.service';
import { OWNER_ROLE } from '../identity/owner.service';
import { BANNED_ROLE } from '../identity/roles.service';
import { serverVersion } from '../version';
import type { AdminDevice, AdminOverview, AdminPerson } from '../gateway/protocol';
import { SettingsService } from './settings.service';

/**
 * Витрина панели: сводка и таблица людей.
 *
 * Всё здесь считается ЗАПРОСОМ В МОМЕНТ ВОПРОСА, а не счётчиком в памяти, и это
 * главное решение файла. Счётчик пришлось бы заводить в шести местах, каждое из
 * которых умеет ошибиться в одну сторону, а рестарт api обнулял бы накопленное —
 * и сводка стала бы единственным местом в relay, где числа не сходятся с
 * соседней вкладкой. Цена честная: полдюжины `count(*)` на открытие панели,
 * то есть раз в день на инсталляцию.
 *
 * Живого состояния здесь нет вовсе: «сколько людей на связи» знают только
 * сокеты, и спрашивает их обработчик (см. `admin.handlers.ts`). База об этом не
 * знает и знать не может.
 */

/** Столько людей в одной странице таблицы. */
const PAGE_SIZE = 50;

/** Курсор страницы людей: время заведения личности и её id. */
const CURSOR_RE = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface CountsRow {
  people: string;
  bans: string;
  messages: string;
  servers: string;
  channels: string;
  storage: string;
}

interface PersonRow {
  id: string;
  fingerprint: string;
  nick: string;
  created_at: Date;
  last_seen_at: Date | null;
  banned: boolean;
  owner: boolean;
}

interface DeviceRowRaw {
  id: string;
  identity_id: string;
  name: string;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

export interface AdminPeoplePage {
  people: AdminPerson[];
  /** Есть чем продолжить. `undefined` — страница последняя. */
  cursor?: string;
}

@Injectable()
export class OverviewService {
  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
    private readonly retention: RetentionService,
  ) {}

  /**
   * Сводка. Одним запросом, а не шестью: подзапросы считаются в базе, и разница
   * между «шесть обращений» и «одно» здесь не в скорости, а в связности —
   * числа, снятые в один момент, не спорят друг с другом.
   *
   * Политику хранения спрашиваем у того, кто по ней чистит (`RetentionService`),
   * а не собираем из настроек заново: сводка обязана показывать ровно то, что
   * происходит, — второе прочтение тех же ключей однажды разошлось бы с первым.
   */
  async summary(online: number): Promise<AdminOverview> {
    const [row]: CountsRow[] = await this.db.query(
      `SELECT
         (SELECT count(*) FROM identities) AS people,
         (SELECT count(*) FROM roles WHERE role = $1 AND server_id IS NULL) AS bans,
         (SELECT count(*) FROM messages) AS messages,
         (SELECT count(*) FROM servers) AS servers,
         -- Беседа двоих — тоже строка в channels (type = 'dm'), но каналом её
         -- не называют нигде: ни в реестре, ни в интерфейсе. Счёт «каналов»,
         -- растущий от чужой переписки, объяснить владельцу нечем.
         (SELECT count(*) FROM channels WHERE type <> 'dm') AS channels,
         (SELECT coalesce(sum(size), 0) FROM attachments) AS storage`,
      [BANNED_ROLE],
    );

    return {
      // `count(*)` в postgres — bigint, и драйвер отдаёт его строкой: без
      // приведения «людей» в панели стало бы «12» плюс «3» равно «123».
      people: Number(row.people),
      online,
      bans: Number(row.bans),
      messages: Number(row.messages),
      servers: Number(row.servers),
      channels: Number(row.channels),
      storageBytes: Number(row.storage),
      storageQuotaBytes: this.settings.get<number>('files.installQuotaBytes'),
      retention: this.retention.effective(),
      directRetention: this.retention.directEffective(),
      version: serverVersion(),
    };
  }

  /**
   * Страница людей: от новых личностей к старым.
   *
   * Ключ страницы полный (время заведения и id): в одну миллисекунду попадает
   * несколько личностей — их заводят вдвоём с одной связки, — и страница по
   * одному времени их теряла бы или показывала дважды. Та же беда и то же
   * лекарство, что у ленты канала и у журнала.
   *
   * Негодный курсор — пустая страница, а не первая: панель, сбившись, иначе
   * листала бы по кругу одно и то же начало списка.
   */
  async people(opts: { query?: string; cursor?: string } = {}): Promise<AdminPeoplePage> {
    const params: unknown[] = [OWNER_ROLE, BANNED_ROLE];
    const where: string[] = [];

    if (opts.query) {
      // Ищем и по нику, и по отпечатку: человека зовут как угодно, а различают
      // его отпечатком — и в панели по нему же ищут, скопировав из ленты.
      params.push(`%${escapeLike(opts.query)}%`);
      where.push(
        `(i.nick ILIKE $${params.length} ESCAPE '\\' OR i.fingerprint ILIKE $${params.length} ESCAPE '\\')`,
      );
    }
    if (opts.cursor) {
      const parsed = CURSOR_RE.exec(opts.cursor);
      if (!parsed) return { people: [] };
      params.push(new Date(Number(parsed[1])), parsed[2]);
      where.push(`(i.created_at, i.id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(PAGE_SIZE + 1);

    const rows: PersonRow[] = await this.db.query(
      `SELECT i.id, i.fingerprint, i.nick, i.created_at, i.last_seen_at,
              EXISTS (SELECT 1 FROM roles r
                       WHERE r.identity_id = i.id AND r.server_id IS NULL AND r.role = $1) AS owner,
              EXISTS (SELECT 1 FROM roles r
                       WHERE r.identity_id = i.id AND r.server_id IS NULL AND r.role = $2) AS banned
         FROM identities i
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT $${params.length}`,
      params,
    );

    const more = rows.length > PAGE_SIZE;
    const page = more ? rows.slice(0, PAGE_SIZE) : rows;
    const devices = await this.devicesOf(page.map((r) => r.id));
    const last = page[page.length - 1];

    return {
      people: page.map((row) => ({
        fingerprint: row.fingerprint,
        nick: row.nick,
        createdAt: row.created_at.getTime(),
        lastSeenAt: row.last_seen_at?.getTime() ?? null,
        devices: devices.get(row.id) ?? [],
        banned: row.banned,
        owner: row.owner,
      })),
      ...(more && last ? { cursor: `${last.created_at.getTime()}.${last.id}` } : {}),
    };
  }

  /**
   * Устройства всей страницы одним запросом. По запросу на человека вышло бы
   * полсотни обращений на одно открытие вкладки — та самая беда «N+1», которую
   * потом ищут по логу медленных запросов.
   */
  private async devicesOf(ids: string[]): Promise<Map<string, AdminDevice[]>> {
    const out = new Map<string, AdminDevice[]>();
    if (!ids.length) return out;
    const rows: DeviceRowRaw[] = await this.db.query(
      `SELECT id, identity_id, name, last_seen_at, revoked_at
         FROM devices
        WHERE identity_id = ANY($1)
        ORDER BY created_at ASC`,
      [ids],
    );
    for (const row of rows) {
      const list = out.get(row.identity_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        lastSeenAt: row.last_seen_at?.getTime() ?? null,
        revoked: row.revoked_at !== null,
      });
      out.set(row.identity_id, list);
    }
    return out;
  }
}

/**
 * Экранирование для `ILIKE`. Без него ник «100%» находил бы всех подряд, а
 * подчёркивание в поиске означало бы «любой знак» — то есть поиск врал бы тем
 * тише, чем реже им пользуются.
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

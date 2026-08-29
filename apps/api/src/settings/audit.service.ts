import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { IdentityRow } from '../db/entities';
import {
  SYSTEM_ACTOR_NICK,
  UNKNOWN_ACTOR_NICK,
  type AuditAction,
  type AuditCursor,
  type AuditEntry,
} from '../gateway/protocol';

/**
 * Журнал: кто, что, с чего на что и когда.
 *
 * Главное правило здесь одно, и оно объясняет всю форму этого файла: ЗАПИСЬ НЕ
 * СРЫВАЕТ ДЕЙСТВИЕ. Бан, случившийся, но не записанный, — плохо; бан, не
 * случившийся из-за того, что не записался, — хуже. Поэтому `write` не бросает
 * вовсе, а жалуется в лог (тот же размен, что у рассылки подписчикам в
 * `SettingsService.emit`), и зовут его ПОСЛЕ того, как действие совершилось, —
 * в частности, снаружи транзакции: ошибка внутри неё отравляет транзакцию
 * целиком, и «журнал не записался» превратилось бы в «власть не перешла».
 *
 * Ретенции у журнала нет намеренно: он переживает чистку сообщений, потому что
 * «кто снял бан позавчера» спрашивают и через год. Индекс `audit_at_idx`
 * оставляет подрезку дешёвой, когда она понадобится.
 *
 * Значения секретов сюда не попадают никогда. Держится это не дисциплиной
 * авторов записей, а тем, что общая дорога записи настройки (`SettingsService.set`)
 * секрет вовсе не принимает: журналу нечего у неё взять.
 */

/** Страница журнала. По умолчанию столько строк, сколько человек читает разом. */
const PAGE_SIZE = 50;

/** Потолок страницы: курсор у панели свой, и просить всю таблицу разом незачем. */
const MAX_PAGE_SIZE = 200;

/** То, что просит записать вызывающий. Ник он знать не обязан — см. `write`. */
export interface AuditWrite {
  /** Личность действовавшего. `null` — сделала машина, а не человек. */
  actor: string | null;
  /**
   * Имя действовавшего. Обычно не задаётся: журнал берёт его из личности сам —
   * иначе ник пришлось бы тащить через четыре сервиса, у которых на руках один
   * лишь id. Задавать имеет смысл там, где имя известно, а личности уже нет.
   */
  actorNick?: string;
  action: AuditAction;
  target?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Есть ли что показать ниже. Считается лишней строкой, а не вторым запросом. */
  more: boolean;
}

/** Строка журнала вместе с лицом автора, если личность ещё жива. */
interface AuditQueryRow {
  id: string;
  at: Date;
  actor: string | null;
  actor_nick: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  fingerprint: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger('audit');

  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /**
   * Записать. Не бросает ни при каких обстоятельствах — см. доккомментарий
   * файла; молча при этом не пропадает: строка в логе — единственный способ
   * узнать, что журнал начал терять записи.
   *
   * Время ставит процесс, а не база, и это не небрежность. Курсор страницы
   * ездит к панели и обратно МИЛЛИСЕКУНДАМИ, а `now()` в Postgres пишет
   * микросекунды: строка, попавшая на 1234 микросекунды позже соседа, при
   * возврате курсора оказалась бы «новее» показанной страницы и не досталась
   * бы ни одной. `Date` даёт ровно ту точность, которую переживает круг.
   */
  async write(entry: AuditWrite): Promise<void> {
    try {
      // Запросом, а не репозиторием, — как соседний `SettingsService.write`: у
      // частичного вида TypeORM нет места для jsonb со свободным содержимым, и
      // обходится это либо приведением, которое врёт о типе, либо вот так.
      await this.db.query(
        `INSERT INTO audit (id, at, actor, actor_nick, action, target, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          randomUUID(),
          new Date(this.now()),
          entry.actor,
          entry.actorNick ?? (await this.nickOf(entry.actor)),
          entry.action,
          entry.target ?? null,
          JSON.stringify(entry.detail ?? {}),
        ],
      );
    } catch (err) {
      this.logger.error(
        `журнал: запись «${entry.action}» не сохранена — само действие уже совершилось`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Страница от свежих к старым. Курсор полный (время и id): в одну
   * миллисекунду попадает несколько записей, и страница по одному времени их
   * теряла бы или показывала дважды — та же беда и то же лекарство, что у
   * ленты канала.
   *
   * Негодный курсор — пустая страница, а не первая. Первая означала бы, что
   * панель, сбившись, тихо показывает по кругу одно и то же начало журнала.
   */
  async page(cursor?: AuditCursor, limit: number = PAGE_SIZE): Promise<AuditPage> {
    const take = Math.min(Math.max(Math.trunc(limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const params: unknown[] = [];
    let where = '';
    if (cursor) {
      if (!Number.isFinite(cursor.at) || !UUID_RE.test(cursor.id)) {
        this.logger.warn(`журнал: негодный курсор ${JSON.stringify(cursor)} — страница пуста`);
        return { entries: [], more: false };
      }
      params.push(new Date(cursor.at), cursor.id);
      where = 'WHERE (a.at, a.id) < ($1, $2)';
    }
    params.push(take + 1);

    // Отпечаток берётся соединением, а не хранится в строке: лицо рисуется по
    // живому ключу, и подставлять его снимком значило бы рисовать лицо тому,
    // кого в инсталляции уже нет. Имя, наоборот, хранится снимком — оно и есть
    // ответ на «как его тогда звали».
    const rows: AuditQueryRow[] = await this.db.query(
      `SELECT a.id, a.at, a.actor, a.actor_nick, a.action, a.target, a.detail, i.fingerprint
         FROM audit a
         LEFT JOIN identities i ON i.id = a.actor
         ${where}
         ORDER BY a.at DESC, a.id DESC
         LIMIT $${params.length}`,
      params,
    );

    const more = rows.length > take;
    return { entries: (more ? rows.slice(0, take) : rows).map(toEntry), more };
  }

  /**
   * Имя действовавшего снимком. Личности может не быть вовсе: тесты подписывают
   * правки выдуманным отпечатком, а живая личность успевает исчезнуть между
   * действием и записью. Ни то ни другое не повод терять запись.
   */
  private async nickOf(actor: string | null): Promise<string> {
    if (!actor) return SYSTEM_ACTOR_NICK;
    const row = await this.db
      .getRepository(IdentityRow)
      .findOne({ where: { id: actor }, select: { nick: true } });
    return row?.nick ?? UNKNOWN_ACTOR_NICK;
  }
}

/** Строка базы → строка панели. Пустые поля не уезжают вовсе. */
function toEntry(row: AuditQueryRow): AuditEntry {
  return {
    id: row.id,
    at: row.at.getTime(),
    actorNick: row.actor_nick,
    action: row.action as AuditAction,
    detail: row.detail,
    ...(row.fingerprint ? { actor: row.fingerprint } : {}),
    // Систему выдаёт ПУСТАЯ КОЛОНКА автора, а не текст ника: узнавай панель
    // систему по имени — человек, назвавшийся так же, подделал бы системную
    // запись. Удалённая личность отпечатка тоже не даёт, но автор у неё был,
    // и системной её звать нельзя.
    ...(row.actor === null ? { system: true as const } : {}),
    ...(row.target === null ? {} : { target: row.target }),
  };
}

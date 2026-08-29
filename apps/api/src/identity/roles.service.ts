import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { IdentityRow, RoleRow } from '../db/entities';
import { AuditService } from '../settings/audit.service';
import { OWNER_ROLE } from './owner.service';

/**
 * Что власть значит — в отличие от `owner.service`, где написано, как она
 * попадает внутрь.
 *
 * Ролей в relay две, и обе — про запрет или про исключение: `owner` и `banned`.
 * Обычный участник строки в таблице не имеет вовсе, и это не экономия. Право
 * быть в общем канале даёт вход на инсталляцию, а не запись в реестре людей;
 * появись строка `member`, её кто-то обязан был бы выдавать — то есть у relay
 * появилась бы регистрация, ровно та, от которой он и уходил.
 *
 * Бан бывает двух охватов, и охват — это `server_id`:
 *
 *   - пустой: вся инсталляция. Такой бан ставит только владелец, и человека
 *     после него не пускают вовсе — сокет отвергается на входе;
 *   - заполненный: конкретный сервер. Такой ставит его создатель, он же
 *     единственный модератор своего сервера. Сервер пропадает из рейки, его
 *     каналы — из списка, вход в них отвергается.
 *
 * Чем это НЕ является: баном человека. Забаненный ключ — это забаненный ключ, и
 * ничто не мешает завести новый: личность здесь рождается на устройстве за одну
 * секунду и без чьего-либо разрешения. Бан — способ прекратить происходящее
 * сейчас, а не запрет на вход в здание; последний в relay ровно один и называется
 * паролем инсталляции.
 */

export const BANNED_ROLE = 'banned';

/** Права личности так, как их спрашивает гейтвей: одним запросом на сокет. */
export interface Rights {
  /** Не пускать вовсе. */
  banned: boolean;
  /** Серверы, с которых забанен. Пустое множество — обычный случай. */
  bannedFrom: Set<string>;
}

/** Забаненный так, как его видит модератор: лицо, имя и след. */
export interface BanView {
  fingerprint: string;
  nick: string;
  at: string;
  /** Кто забанил. Пусто — личности бана уже нет в базе. */
  by: string | null;
}

export type BanFailure =
  /** Отпечатка нет: такой личности инсталляция не знает. */
  | 'unknown'
  /** Владельца инсталляции не банят — и себя тоже. */
  | 'forbidden';

@Injectable()
export class RolesService {
  private readonly logger = new Logger('roles');

  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
    // Журнал со значением по умолчанию, а не обязательным доводом: он ходит в
    // ту же базу, ничего не хранит и нужен здесь всегда. Собранный руками
    // сервис ведёт журнал так же, как рабочий, — «в тесте не записалось» не
    // бывает, и порядок доводов у соседей не ломается.
    @Optional() private readonly audit: AuditService = new AuditService(db, now),
  ) {}

  /**
   * Всё, что нужно знать про эту личность на входе. Один запрос: спрашивают на
   * каждом подключении, а строк у человека обычно ноль.
   */
  async rightsOf(identityId: string): Promise<Rights> {
    const rows = await this.db.getRepository(RoleRow).findBy({ identityId, role: BANNED_ROLE });
    const bannedFrom = new Set<string>();
    let banned = false;
    for (const row of rows) {
      if (row.serverId === null) banned = true;
      else bannedFrom.add(row.serverId);
    }
    return { banned, bannedFrom };
  }

  /**
   * Забанить. `serverId` — охват: пустой значит всю инсталляцию.
   *
   * Владельца забанить нельзя никаким охватом. Не из почтения: строка бана на
   * инсталляцию и строка владельца — это одна и та же пара ключей в таблице, и
   * забаненный владелец означал бы инсталляцию, у которой владельца нет вовсе.
   * Разомкнуть это можно было бы только ссылкой из ssh — то есть модератор
   * сервера одним нажатием отправлял бы хозяина в терминал.
   */
  async ban(
    identityId: string,
    serverId: string | null,
    by: string,
  ): Promise<{ ok: true } | { ok: false; reason: BanFailure }> {
    if (identityId === by) return { ok: false, reason: 'forbidden' };
    // Имя и отпечаток берутся здесь же, одним запросом вместо `countBy`: в
    // журнал уезжает не id (его никто не читает глазами), а отпечаток — та же
    // ручка, которой забаненный показан в панели, — и имя снимком.
    const target = await this.db
      .getRepository(IdentityRow)
      .findOne({ where: { id: identityId }, select: { id: true, nick: true, fingerprint: true } });
    if (!target) return { ok: false, reason: 'unknown' };
    const owner = await this.db
      .getRepository(RoleRow)
      .countBy({ identityId, serverId: IsNull(), role: OWNER_ROLE });
    if (owner) return { ok: false, reason: 'forbidden' };

    // Повторный бан — не ошибка (два модератора нажали одновременно, человек
    // забанен на сервере и следом на инсталляции). Молча оставляем первую
    // строку: она и есть след, и переписывать её задним числом незачем.
    await this.db
      .getRepository(RoleRow)
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        identityId,
        serverId,
        role: BANNED_ROLE,
        grantedBy: by,
        createdAt: new Date(this.now()),
      })
      .orIgnore()
      .execute();

    this.logger.log(`бан личности ${identityId} (${serverId ?? 'вся инсталляция'}) от ${by}`);
    // После бана, а не вместо него: журнал не вправе отменить состоявшееся
    // (`write` не бросает вовсе — см. `AuditService`). Охват уезжает как есть:
    // пусто — вся инсталляция, и это ровно то, что человек хочет знать через
    // год, глядя на строку.
    await this.audit.write({
      actor: by,
      action: 'ban',
      target: target.fingerprint,
      detail: { nick: target.nick, server: serverId },
    });
    return { ok: true };
  }

  /**
   * Разбанить. `false` — такого бана и не было.
   *
   * Кто разбанил, спрашивается доводом: до журнала это никого не интересовало —
   * строка просто исчезала, — а теперь снятие бана надо кому-то приписать. Это
   * ровно тот вопрос, ради которого журнал и заведён.
   */
  async unban(identityId: string, serverId: string | null, by: string): Promise<boolean> {
    // Бан не переживает свою личность: строка роли уходит вместе с ней
    // (внешний ключ с CASCADE). Поэтому неизвестная личность — это заведомо
    // «такого бана и не было», а не повод писать в журнал строку без имени.
    const target = await this.db
      .getRepository(IdentityRow)
      .findOne({ where: { id: identityId }, select: { id: true, nick: true, fingerprint: true } });
    if (!target) return false;

    const res = await this.db.getRepository(RoleRow).delete({
      identityId,
      serverId: serverId ?? IsNull(),
      role: BANNED_ROLE,
    });
    if (!res.affected) return false;

    this.logger.log(`разбан ${identityId} (${serverId ?? 'вся инсталляция'})`);
    await this.audit.write({
      actor: by,
      action: 'unban',
      target: target.fingerprint,
      detail: { nick: target.nick, server: serverId },
    });
    return true;
  }

  /**
   * Кто забанен в этом охвате. Наружу уходят отпечаток и ник, а не id: по
   * отпечатку человека и различают глазами, и он же служит ручкой для разбана —
   * id личности в протоколе не появляется вовсе (см. `gateway/ownership`).
   */
  async bans(serverId: string | null): Promise<BanView[]> {
    const rows = await this.db.getRepository(RoleRow).find({
      where: { serverId: serverId ?? IsNull(), role: BANNED_ROLE },
      relations: { identity: true },
      order: { createdAt: 'DESC' },
    });
    const authors = await this.nicksOf(rows.map((r) => r.grantedBy));
    return rows
      .filter((row) => !!row.identity)
      .map((row) => ({
        fingerprint: row.identity.fingerprint,
        nick: row.identity.nick,
        at: row.createdAt.toISOString(),
        by: (row.grantedBy && authors.get(row.grantedBy)) || null,
      }));
  }

  /** Личность по отпечатку — тем же ключом, которым её называют в протоколе. */
  async byFingerprint(fingerprint: unknown): Promise<string | null> {
    if (typeof fingerprint !== 'string' || !fingerprint) return null;
    const row = await this.db
      .getRepository(IdentityRow)
      .findOne({ where: { fingerprint }, select: { id: true } });
    return row?.id ?? null;
  }

  private async nicksOf(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    const out = new Map<string, string>();
    if (!wanted.length) return out;
    const rows = await this.db.getRepository(IdentityRow).find({
      where: wanted.map((id) => ({ id })),
      select: { id: true, nick: true },
    });
    for (const row of rows) out.set(row.id, row.nick);
    return out;
  }
}

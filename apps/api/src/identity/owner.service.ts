import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, LessThan, IsNull } from 'typeorm';
import { OwnerClaimRow, RoleRow } from '../db/entities';
import { AuditService } from '../settings/audit.service';
import { hashOwnerToken, isOwnerToken, newOwnerToken } from './crypto';

/**
 * Владелец инсталляции — единственная роль, которую невозможно выдать изнутри.
 *
 * Круг замкнут по определению: раздавать роли может владелец, а первого
 * владельца раздать некому. Разомкнуть его можно только снаружи приложения —
 * оттуда, где у человека есть машина: `install.sh` печатает ссылку, `relay
 * owner-link` выпускает её заново. Ключ от машины и есть доказательство права,
 * и другого в этой схеме взять неоткуда.
 *
 * Отсюда же ответ на «а если ключ владельца потерян». Восстановления пароля тут
 * нет и не будет, но есть ssh: перевыпустил ссылку — вернул власть. Поэтому
 * открывший новую ссылку становится владельцем, а прежний перестаёт им быть.
 * Владелец у инсталляции один; цена решения честная и её стоит знать —
 * подсмотренная ссылка не добавляет чужого рядом с тобой, а забирает твоё.
 */

/** Сколько живёт невостребованное приглашение. */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** Роль на всю инсталляцию — та самая строка с пустым `server_id`. */
export const OWNER_ROLE = 'owner';

export type ClaimFailure =
  /** Ключ не той формы или такого не выдавалось. */
  | 'bad-token'
  /** Ссылкой уже воспользовались — второй раз она не работает. */
  | 'used'
  /** Сутки вышли, либо ключ перевыпущен: годен всегда только последний. */
  | 'expired';

export type ClaimResult = { ok: true } | { ok: false; reason: ClaimFailure };

@Injectable()
export class OwnerService {
  private readonly logger = new Logger('owner');

  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
    // Со значением по умолчанию — по той же причине, что у соседей: журнал
    // ходит в ту же базу и нужен здесь всегда, а обязательным доводом он ломал
    // бы порядок у всех, кто собирает сервис руками.
    @Optional() private readonly audit: AuditService = new AuditService(db, now),
  ) {}

  /**
   * Новое приглашение. Прежние невостребованные при этом умирают: живой ключ на
   * инсталляции ровно один, иначе «перевыпустил, потому что старый мог утечь»
   * не значило бы ничего.
   *
   * Возвращается сам ключ — единственный раз, когда он вообще существует в
   * читаемом виде. В базе остаётся только его хэш.
   *
   * `by` — кто перевыпустил. Пусто у `relay owner-link`: там за человека
   * ручается доступ к машине, личности у него в этот момент нет вовсе, и в
   * журнале такая строка честно значится системной. Из панели ссылку
   * перевыпускает владелец, и там автор есть.
   */
  async issue(by: string | null = null): Promise<{ token: string; expiresAt: Date }> {
    const token = newOwnerToken();
    const expiresAt = new Date(this.now() + CLAIM_TTL_MS);
    const claims = this.db.getRepository(OwnerClaimRow);

    await this.db.transaction(async (m) => {
      await m
        .getRepository(OwnerClaimRow)
        .update({ usedAt: IsNull() }, { expiresAt: new Date(this.now()) });
      await m.getRepository(OwnerClaimRow).insert({
        id: randomUUID(),
        tokenHash: hashOwnerToken(token),
        createdAt: new Date(this.now()),
        expiresAt,
        usedAt: null,
        usedBy: null,
      });
    });

    // Подметаем давно истекшее: строка нужна ради следа о взятии власти, а
    // невостребованные следа не оставляют и копиться им незачем.
    await claims.delete({
      usedAt: IsNull(),
      expiresAt: LessThan(new Date(this.now() - CLAIM_TTL_MS)),
    });

    this.logger.log('выпущено приглашение во владельцы');
    // Сам ключ в журнал не попадает и попасть не может: строка о выпуске нужна,
    // чтобы человек увидел чужой перевыпуск, а не чтобы им воспользоваться.
    await this.audit.write({
      actor: by,
      action: 'owner-link-issued',
      detail: { expiresAt: expiresAt.toISOString() },
    });
    return { token, expiresAt };
  }

  /**
   * Взять власть по ключу. Всё одной транзакцией: пометка приглашения
   * использованным и смена владельца — это одно событие, и половина его
   * означала бы либо сожжённую ссылку без владельца, либо ссылку, годную
   * дважды.
   *
   * В журнал строка уходит ПОСЛЕ транзакции, а не внутри неё: неудачный запрос
   * внутри отравляет транзакцию целиком, и «не записалось в журнал»
   * превратилось бы в «власть не перешла» — ровно наоборот тому, чего от
   * журнала хотят.
   */
  async claim(token: unknown, identityId: string): Promise<ClaimResult> {
    if (!isOwnerToken(token)) return { ok: false, reason: 'bad-token' };
    const hash = hashOwnerToken(token);

    const done = await this.db.transaction(async (m) => {
      // Блокировка строки: два клика по одной ссылке в двух окнах — это
      // обычная жизнь, и второй обязан увидеть «уже использована», а не стать
      // вторым владельцем.
      const claim = await m
        .getRepository(OwnerClaimRow)
        .findOne({ where: { tokenHash: hash }, lock: { mode: 'pessimistic_write' } });
      if (!claim) return { ok: false, reason: 'bad-token' as const };
      if (claim.usedAt) return { ok: false, reason: 'used' as const };
      if (claim.expiresAt.getTime() <= this.now()) return { ok: false, reason: 'expired' as const };

      await m
        .getRepository(OwnerClaimRow)
        .update({ id: claim.id }, { usedAt: new Date(this.now()), usedBy: identityId });

      // Прежний владелец теряет роль — строкой меньше, и он снова обычный
      // человек. Кем он был, помнит использованное приглашение: там записано,
      // кто и когда брал власть до него.
      //
      // Кто это был, читается ДО удаления и уезжает наружу вместе с ответом:
      // «власть перешла от Ани к Борису» и есть содержание записи в журнале, а
      // после коммита спрашивать об этом уже некого. Сразу личностью, а не id:
      // строку журнала читают глазами, и «отобрана у 9f2c…» не говорит ничего.
      const prev = await m.getRepository(RoleRow).findOne({
        where: { serverId: IsNull(), role: OWNER_ROLE },
        relations: { identity: true },
      });
      const previous = prev?.identity
        ? { fingerprint: prev.identity.fingerprint, nick: prev.identity.nick }
        : null;
      await m.getRepository(RoleRow).delete({ serverId: IsNull(), role: OWNER_ROLE });
      // И всё, что было записано о новом владельце, — тоже. Записано о нём
      // может быть только одно: бан. Ссылка из ssh сильнее любого бана, иначе
      // уходящий владелец забанил бы всех и запер инсталляцию, а отпереть её
      // было бы нечем. Заодно это снимает столкновение по уникальному ключу:
      // бан на инсталляцию и владение — одна и та же пара (личность, пусто).
      await m.getRepository(RoleRow).delete({ identityId });
      await m.getRepository(RoleRow).insert({
        id: randomUUID(),
        identityId,
        serverId: null,
        role: OWNER_ROLE,
        // Выдал не человек, а машина: приглашение печатает тот, у кого ssh.
        grantedBy: null,
        createdAt: new Date(this.now()),
      });

      this.logger.log(`владельцем инсталляции стала личность ${identityId}`);
      return { ok: true as const, previous };
    });
    if (!done.ok) return done;

    // Прежнего владельца нет вовсе — власть взяли впервые, и подробностей у
    // записи нет: пустое «от кого» лучше выдуманного.
    await this.audit.write({
      actor: identityId,
      action: 'owner-claimed',
      detail: done.previous ? { previous: done.previous } : {},
    });
    return { ok: true };
  }

  /** Владелец ли. Вопрос задаётся про себя и только про себя. */
  async isOwner(identityId: string): Promise<boolean> {
    return (
      (await this.db
        .getRepository(RoleRow)
        .countBy({ identityId, serverId: IsNull(), role: OWNER_ROLE })) > 0
    );
  }

  /**
   * Личность владельца — или `null`, если ссылку ещё никто не открывал. Нужен
   * там, где вопрос задают не про себя, а про всех сразу: гейтвей пересобирает
   * права живых сокетов одним запросом, а не по запросу на сокет.
   */
  async ownerId(): Promise<string | null> {
    const row = await this.db
      .getRepository(RoleRow)
      .findOne({ where: { serverId: IsNull(), role: OWNER_ROLE }, select: { identityId: true } });
    return row?.identityId ?? null;
  }

  /** Есть ли у инсталляции владелец вообще. Нужен установщику и тестам. */
  async claimed(): Promise<boolean> {
    return (
      (await this.db.getRepository(RoleRow).countBy({ serverId: IsNull(), role: OWNER_ROLE })) > 0
    );
  }
}

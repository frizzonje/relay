import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, LessThan, IsNull } from 'typeorm';
import { OwnerClaimRow, RoleRow } from '../db/entities';
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
  ) {}

  /**
   * Новое приглашение. Прежние невостребованные при этом умирают: живой ключ на
   * инсталляции ровно один, иначе «перевыпустил, потому что старый мог утечь»
   * не значило бы ничего.
   *
   * Возвращается сам ключ — единственный раз, когда он вообще существует в
   * читаемом виде. В базе остаётся только его хэш.
   */
  async issue(): Promise<{ token: string; expiresAt: Date }> {
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
    return { token, expiresAt };
  }

  /**
   * Взять власть по ключу. Всё одной транзакцией: пометка приглашения
   * использованным и смена владельца — это одно событие, и половина его
   * означала бы либо сожжённую ссылку без владельца, либо ссылку, годную
   * дважды.
   */
  async claim(token: unknown, identityId: string): Promise<ClaimResult> {
    if (!isOwnerToken(token)) return { ok: false, reason: 'bad-token' };
    const hash = hashOwnerToken(token);

    return this.db.transaction(async (m) => {
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
      await m.getRepository(RoleRow).delete({ serverId: IsNull(), role: OWNER_ROLE });
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
      return { ok: true as const };
    });
  }

  /** Владелец ли. Вопрос задаётся про себя и только про себя. */
  async isOwner(identityId: string): Promise<boolean> {
    return (
      (await this.db
        .getRepository(RoleRow)
        .countBy({ identityId, serverId: IsNull(), role: OWNER_ROLE })) > 0
    );
  }

  /** Есть ли у инсталляции владелец вообще. Нужен установщику и тестам. */
  async claimed(): Promise<boolean> {
    return (
      (await this.db.getRepository(RoleRow).countBy({ serverId: IsNull(), role: OWNER_ROLE })) > 0
    );
  }
}

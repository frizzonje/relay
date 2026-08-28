import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { DeviceRow, IdentityRow } from '../db/entities';
import { SettingsService } from '../settings/settings.service';

/**
 * Уборка личностей, о которых давно ничего не слышно
 * (`people.pruneInactiveDays`).
 *
 * Умолчание — ноль, и это единственный честный вариант: до появления настройки
 * личности не удалялись вовсе, ни по какому сроку. Ноль тут значит «никого не
 * чистим» — та же договорённость, что у квот на файлы и у окна правки.
 *
 * Что уносит с собой удалённая личность: её устройства (по внешнему ключу,
 * каскадом) и её личное — отметки чтения и настройки. Что НЕ уносит: сказанное
 * ей. Реплики стоят на связи без внешнего ключа намеренно (см. `entities.ts`),
 * и разговор, из которого пропала половина фраз, был бы ущербом куда большим,
 * чем строка в таблице личностей.
 *
 * Три рода личностей не трогаем никогда, и каждый — по своей причине:
 *
 *   - у кого есть роль. Роль — это владелец инсталляции и это бан. Первого
 *     удалить значит оставить инсталляцию без хозяина (ссылка владельца уже
 *     использована и второй раз не сработает), второго — снять бан: ключ у
 *     человека остался, он войдёт заново, получит НОВЫЙ id и окажется чистым.
 *     Уборка, снимающая баны по сроку давности, — худший род тишины;
 *   - создатели серверов. Сервер переживает своего создателя (так и задумано),
 *     но остаётся без хозяина: человек, вернувшийся через полгода, обнаружил
 *     бы, что его сервером теперь распоряжается кто-то другой;
 *   - те, кто заходил недавно. «Недавно» считает база: время последнего входа
 *     ставила тоже она.
 */

/** Как часто ходим. Срок здесь дневной — чаще незачем, реже неотзывчиво. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const KEY = 'people.pruneInactiveDays';

@Injectable()
export class PruneService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PruneService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.apply();
    // Настройка, которая начинает действовать только после перезапуска, — не
    // настройка: выключив уборку, человек ждёт, что она прекратится сейчас, а
    // не с ближайшим обновлением образа.
    this.unsubscribe = this.settings.onChange((key) => {
      if (key === KEY) this.apply();
    });
  }

  onModuleDestroy(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Сколько дней бездействия терпим. Ноль — не чистим вовсе. */
  days(): number {
    return this.settings.get<number>(KEY);
  }

  /**
   * Один проход. Возвращает, сколько личностей убрано, — по этому же числу его
   * проверяет тест, и оно же уходит в лог, когда есть что сказать.
   */
  async sweep(): Promise<number> {
    const days = this.days();
    if (days <= 0) return 0;

    const doomed = await this.db
      .getRepository(IdentityRow)
      .createQueryBuilder('i')
      .select('i.id', 'id')
      // Никогда не входившая личность считается по своему рождению: `null` в
      // сравнении с интервалом дал бы `null`, то есть «не подходит», и такие
      // строки копились бы вечно.
      .where(`COALESCE(i.last_seen_at, i.created_at) < now() - (:days || ' days')::interval`, {
        days,
      })
      .andWhere('NOT EXISTS (SELECT 1 FROM roles r WHERE r.identity_id = i.id)')
      .andWhere('NOT EXISTS (SELECT 1 FROM servers s WHERE s.creator_identity_id = i.id)')
      .getRawMany<{ id: string }>();
    if (!doomed.length) return 0;

    const ids = doomed.map((row) => row.id);
    await this.db.transaction(async (m) => {
      // Личное чистится явно: у отметок чтения и настроек нет внешнего ключа
      // (ключ там составной и первичный), и каскад до них не дотянется —
      // остались бы строки, которых никто уже не прочитает.
      await m.query('DELETE FROM reads WHERE identity_id = ANY($1::uuid[])', [ids]);
      await m.query('DELETE FROM prefs WHERE identity_id = ANY($1::uuid[])', [ids]);
      // Устройства уходят каскадом от личности, но сносим их первыми и сами:
      // так порядок удаления не зависит от того, каким объявлен внешний ключ.
      await m.getRepository(DeviceRow).delete({ identityId: In(ids) });
      await m.getRepository(IdentityRow).delete(ids);
    });

    this.logger.log(`уборка личностей: удалено — ${ids.length} (бездействие ${days} дн.)`);
    return ids.length;
  }

  /**
   * Взять действующий срок и пересобрать под него расписание. Зовётся и на
   * старте, и на каждой смене настройки — второй раз это важнее: включив
   * уборку, человек остался бы без единого прохода до перезапуска, потому что
   * у выключенной таймера нет вовсе.
   */
  private apply(): void {
    this.stop();
    const days = this.days();
    if (days <= 0) {
      this.logger.log('уборка личностей выключена');
      return;
    }
    // Говорим вслух: удаление людей — не та работа, которая заводится молча.
    this.logger.log(`уборка личностей: бездействие дольше ${days} дн.`);
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

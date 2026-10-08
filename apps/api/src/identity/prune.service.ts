import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Periodic } from '../periodic';
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
  private readonly schedule = new Periodic(this.logger, () => this.sweep());

  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.schedule.follow(this.settings, [KEY], () => this.plan());
  }

  onModuleDestroy(): void {
    this.schedule.stop();
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

    const ids = await this.db.transaction(async (m) => {
      // Решение «кого» и удаление — одним запросом. Раздельно между ними стоял
      // бы поход в базу, и бан, поставленный в это окно, уборка снесла бы
      // вместе с личностью (а вошедший в это окно человек потерял бы себя).
      // Устройства уходят каскадом по внешнему ключу.
      // На DELETE драйвер Postgres у TypeORM отвечает парой [строки, счётчик].
      const [rows]: [{ id: string }[], number] = await m.query(
        // Никогда не входившая личность считается по своему рождению: `null` в
        // сравнении с интервалом дал бы `null`, то есть «не подходит», и такие
        // строки копились бы вечно.
        `DELETE FROM identities i
          WHERE COALESCE(i.last_seen_at, i.created_at) < now() - ($1 || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.identity_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.creator_identity_id = i.id)
        RETURNING i.id`,
        [days],
      );
      const gone = rows.map((row) => row.id);
      if (gone.length) {
        // Личное чистится явно: у отметок чтения и настроек нет внешнего ключа
        // (ключ там составной и первичный), и каскад до них не дотянется —
        // остались бы строки, которых никто уже не прочитает.
        await m.query('DELETE FROM reads WHERE identity_id = ANY($1::uuid[])', [gone]);
        await m.query('DELETE FROM prefs WHERE identity_id = ANY($1::uuid[])', [gone]);
      }
      return gone;
    });
    if (!ids.length) return 0;

    this.logger.log(`уборка личностей: удалено — ${ids.length} (бездействие ${days} дн.)`);
    return ids.length;
  }

  /**
   * Период прохода под действующий срок — или `null`, если уборка выключена.
   * Зовётся на старте и на каждой смене настройки (см. `Periodic.follow`).
   */
  private plan(): number | null {
    const days = this.days();
    if (days <= 0) {
      this.logger.log('уборка личностей выключена');
      return null;
    }
    // Говорим вслух: удаление людей — не та работа, которая заводится молча.
    this.logger.log(`уборка личностей: бездействие дольше ${days} дн.`);
    return SWEEP_INTERVAL_MS;
  }
}

import { Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReadRow } from '../db/entities';

/**
 * Отметки чтения: до какого момента человек дочитал каждый канал.
 *
 * Переехало это из localStorage не ради красоты. Непрочитанное в браузере
 * означало, что открытый на работе канал вечером снова горит дома, — то есть
 * индикатор врал ровно тем, кто пользуется relay с двух устройств, а таких
 * после связки устройств стало большинство.
 *
 * Правило слияния здесь одно и оно не «последний записавший прав», как у
 * настроек: отметка только растёт. Телефон с отставшими часами, вкладка,
 * пролежавшая сутки открытой, устройство, вернувшееся из офлайна со старым
 * снимком, — любое из них, победи оно по времени записи, объявило бы уже
 * прочитанное непрочитанным. Поэтому запись, которая пытается сдвинуть отметку
 * назад, не проигрывает спор, а просто ничего не делает.
 *
 * Время здесь — серверное: это время последней реплики канала, то самое, что
 * приезжает клиенту в `chat-activity` и в снимке каналов. Часы клиента в этой
 * арифметике не участвуют вовсе (см. `web/stores/unread`).
 */
@Injectable()
export class ReadsService {
  constructor(
    private readonly db: DataSource,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  /** Все отметки человека: id канала → время. Спрашивается один раз, на входе. */
  async marks(identityId: string): Promise<Map<string, number>> {
    const rows = await this.db.getRepository(ReadRow).findBy({ identityId });
    return new Map(rows.map((row) => [row.channelId, row.readAt.getTime()]));
  }

  /**
   * Дочитать канал до этого момента. Возвращает ставшую отметку — её и уносят
   * другим устройствам человека; `null` — отметка не сдвинулась: она уже была
   * не старше присланной.
   *
   * Будущим временем канал не «дочитывается»: отметку клиент берёт из
   * активности канала, но проверять это на слово нельзя — иначе один кривой
   * (или злой) клиент разом гасил бы человеку непрочитанное во всех каналах и
   * навсегда. Себе, но всё же.
   */
  async mark(identityId: string, channelId: string, at: number): Promise<number | null> {
    if (!identityId || !channelId || !Number.isFinite(at) || at <= 0) return null;
    const readAt = new Date(Math.min(at, this.now()));
    const changed: unknown[] = await this.db.query(
      `INSERT INTO "reads" ("identity_id", "channel_id", "read_at") VALUES ($1, $2, $3)
         ON CONFLICT ("identity_id", "channel_id")
         DO UPDATE SET "read_at" = EXCLUDED."read_at"
         WHERE "reads"."read_at" < EXCLUDED."read_at"
       RETURNING 1`,
      [identityId, channelId, readAt],
    );
    return changed.length > 0 ? readAt.getTime() : null;
  }

  /**
   * Канала больше нет — забыть его отметки. Внешнего ключа у таблицы нет
   * (отметка не должна запирать удаление канала), поэтому убирать за собой
   * приходится руками; иначе у долгоживущей инсталляции копятся строки о
   * каналах, которых никто уже не помнит.
   */
  async forget(channelId: string): Promise<void> {
    if (!channelId) return;
    await this.db.getRepository(ReadRow).delete({ channelId });
  }
}

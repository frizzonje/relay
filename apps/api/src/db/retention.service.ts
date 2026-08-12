import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Ретенция: переписка живёт `RETENTION_DAYS` дней и исчезает.
 *
 * Это не уборка мусора, а обещание продукта — «максимум доверия, минимум
 * хранения». Поэтому срок один на инсталляцию, виден в интерфейсе и не имеет
 * исключений, кроме одного: закреплённые сообщения. Оно потому и единственное,
 * что явное — человек сам сказал «это должно остаться».
 *
 * Файлы удаляются не здесь: осиротевшее вложение подметает `UploadsService` —
 * ему всё равно, чьё сообщение исчезло, ретенции или руки владельца.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Как часто ходим. При нулевой ретенции — раз в минуту, см. `retentionDays`. */
const SWEEP_INTERVAL_MS = HOUR_MS;
const SWEEP_INTERVAL_ZERO_MS = 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Срок из окружения. Мусор в переменной — это не повод молча выбрать дефолт:
 * «14» и «непонятно что, поэтому 14» выглядят в логе одинаково, а означают
 * разное. Отрицательное — «не удалять никогда»: не документируем, но и не
 * ломаем инсталляцию, которая так себя настроила.
 */
export function retentionDays(raw: string | undefined = process.env.RETENTION_DAYS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return NaN;
  return value;
}

@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: DataSource) {}

  onModuleInit(): void {
    const days = retentionDays();
    if (Number.isNaN(days)) {
      this.logger.warn(
        `RETENTION_DAYS="${process.env.RETENTION_DAYS}" не похоже на число дней — ` +
          `беру ${DEFAULT_RETENTION_DAYS}`,
      );
    }
    if (this.effectiveDays() < 0) {
      this.logger.warn('RETENTION_DAYS отрицателен — переписка не будет удаляться никогда');
      return;
    }
    void this.sweep();
    // Ноль означает «не хранить»: раз в час было бы часом хранения.
    const interval = this.effectiveDays() === 0 ? SWEEP_INTERVAL_ZERO_MS : SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  /** Сколько дней держим на самом деле (мусор в переменной → дефолт). */
  effectiveDays(): number {
    const days = retentionDays();
    return Number.isNaN(days) ? DEFAULT_RETENTION_DAYS : days;
  }

  /**
   * Один проход. Возвращает, сколько реплик удалено, — по этому же числу его
   * проверяет тест, и оно же уходит в лог, когда есть что сказать.
   */
  async sweep(): Promise<number> {
    const days = this.effectiveDays();
    if (days < 0) return 0;
    const res = await this.db
      .createQueryBuilder()
      .delete()
      .from('messages')
      // Срок считает база, а не Node: время реплики ставила тоже она, и
      // сравнивать его с часами другого контейнера значило бы промахиваться
      // ровно на их расхождение — заметнее всего при нулевом сроке.
      .where(`created_at < now() - (:days || ' days')::interval`, { days })
      // Закреплённое живёт дольше срока — единственное исключение из ретенции.
      .andWhere('NOT EXISTS (SELECT 1 FROM pins p WHERE p.message_id = messages.id)')
      .execute();
    const removed = res.affected ?? 0;
    if (removed) this.logger.log(`ретенция: удалено реплик старше ${days} дн. — ${removed}`);
    return removed;
  }
}

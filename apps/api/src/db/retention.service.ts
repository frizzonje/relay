import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { describeRetention, type Retention, type RetentionMode } from './retention.policy';

/**
 * Ретенция: сколько живёт переписка.
 *
 * Это не уборка мусора, а обещание продукта — «максимум доверия, минимум
 * хранения». Поэтому срок один на инсталляцию, виден в интерфейсе и не имеет
 * исключений, кроме одного: закреплённые сообщения. Оно потому и единственное,
 * что явное — человек сам сказал «это должно остаться».
 *
 * Срок берётся у настроек, а не у окружения. `RETENTION_DAYS` по-прежнему
 * работает, но ровно один раз: `SettingsService` переносит её в таблицу на
 * первом старте (см. его `seed`). Читать переменную и здесь значило бы завести
 * второй источник правды — и панель, показывающая тридцать дней, чистила бы по
 * четырнадцати.
 *
 * Файлы удаляются не здесь: осиротевшее вложение подметает `UploadsService` —
 * ему всё равно, чьё сообщение исчезло, ретенции или руки владельца.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Как часто ходим. Без срока хранения — раз в минуту, см. `apply`. */
const SWEEP_INTERVAL_MS = HOUR_MS;
const SWEEP_INTERVAL_EPHEMERAL_MS = 60 * 1000;

/** Настройки, от которых зависит расписание. Смена любой из них его пересобирает. */
const WATCHED = ['messages.retentionMode', 'messages.retentionDays'];

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.apply();
    // Настройка, которая начинает действовать только после перезапуска, — не
    // настройка: человек, поставивший в панели три дня, ждёт, что недельное
    // уйдёт сегодня, а не с ближайшим обновлением образа.
    this.unsubscribe = this.settings.onChange((key) => {
      if (WATCHED.includes(key)) this.apply();
    });
  }

  onModuleDestroy(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Что делаем на самом деле — ровно то, что показывает панель. */
  effective(): Retention {
    const mode = this.settings.get<RetentionMode>('messages.retentionMode');
    if (mode !== 'days') return { mode };
    return { mode, days: this.settings.get<number>('messages.retentionDays') };
  }

  /**
   * Один проход. Возвращает, сколько реплик удалено, — по этому же числу его
   * проверяет тест, и оно же уходит в лог, когда есть что сказать.
   */
  async sweep(): Promise<number> {
    const policy = this.effective();
    if (policy.mode === 'forever') return 0;
    const days = policy.mode === 'days' ? policy.days : 0;
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
    if (removed) this.logger.log(`ретенция: удалено реплик — ${removed}`);
    return removed;
  }

  /**
   * Взять действующую политику и пересобрать под неё расписание. Зовётся и на
   * старте, и на каждой смене настройки — второй раз это важнее: сменив режим
   * с «хранить всегда» на «не хранить», человек остался бы без единого прохода,
   * потому что таймера у «всегда» нет вовсе.
   */
  private apply(): void {
    this.stop();
    const policy = this.effective();
    // Говорим всегда, а не только на необычном значении: хранение — обещание
    // людям на этом сервере, и хозяин должен видеть его при каждом старте и
    // при каждой правке.
    this.logger.log(`ретенция: ${describeRetention(policy)}`);
    if (policy.mode === 'forever') return;

    void this.sweep();
    // Без срока хранения час подметания был бы часом хранения.
    const interval = policy.mode === 'ephemeral' ? SWEEP_INTERVAL_EPHEMERAL_MS : SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

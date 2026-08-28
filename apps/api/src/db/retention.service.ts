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
 *
 * С этапа C политик две: общая и та, по которой живёт личная переписка
 * (`direct.retentionMode`). Вторая по умолчанию — «как у каналов», и это
 * сегодняшнее поведение слово в слово: проход ходит по всей таблице реплик и о
 * том, что часть из них лежит в беседах, не знает вовсе.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Как часто ходим. Без срока хранения — раз в минуту, см. `apply`. */
const SWEEP_INTERVAL_MS = HOUR_MS;
const SWEEP_INTERVAL_EPHEMERAL_MS = 60 * 1000;

/** Настройки, от которых зависит расписание. Смена любой из них его пересобирает. */
const WATCHED = [
  'messages.retentionMode',
  'messages.retentionDays',
  'direct.retentionMode',
  'direct.retentionDays',
];

/**
 * Кого чистит этот проход. `all` — всю таблицу разом, ровно как до появления
 * второй политики: пока переписка живёт по общему сроку, делить запрос надвое
 * незачем, и один и тот же DELETE остаётся тем же самым DELETE.
 */
type Scope = 'all' | 'channels' | 'direct';

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
   * Срок личной переписки — или `null`, если он общий с каналами. `null`, а не
   * копия общей политики, намеренно: по нему `sweep` узнаёт, что делить запрос
   * надвое не нужно, и инсталляция без своего срока чистится ровно тем же
   * DELETE, что и до этапа C.
   */
  directEffective(): Retention | null {
    const mode = this.settings.get<string>('direct.retentionMode');
    if (mode === 'inherit') return null;
    if (mode === 'days') {
      return { mode, days: this.settings.get<number>('direct.retentionDays') };
    }
    // Каталог держит список положений (`options`), и в него не попадёт ничего
    // сверх — но тип этого не знает, поэтому «всё прочее» называем прямо.
    return { mode: mode === 'ephemeral' ? 'ephemeral' : 'forever' };
  }

  /**
   * Один проход. Возвращает, сколько реплик удалено, — по этому же числу его
   * проверяет тест, и оно же уходит в лог, когда есть что сказать.
   */
  async sweep(): Promise<number> {
    const direct = this.directEffective();
    if (!direct) return this.purge(this.effective(), 'all');
    // Два прохода вместо одного — и только когда у переписки свой срок: беседа
    // и канал живут по разным обещаниям, а одна общая политика не умеет
    // хранить первое дольше второго.
    return (await this.purge(this.effective(), 'channels')) + (await this.purge(direct, 'direct'));
  }

  /** Проход одной политики по своей половине таблицы. */
  private async purge(policy: Retention, scope: Scope): Promise<number> {
    if (policy.mode === 'forever') return 0;
    const days = policy.mode === 'days' ? policy.days : 0;
    const query = this.db
      .createQueryBuilder()
      .delete()
      .from('messages')
      // Срок считает база, а не Node: время реплики ставила тоже она, и
      // сравнивать его с часами другого контейнера значило бы промахиваться
      // ровно на их расхождение — заметнее всего при нулевом сроке.
      .where(`created_at < now() - (:days || ' days')::interval`, { days })
      // Закреплённое живёт дольше срока — единственное исключение из ретенции.
      .andWhere('NOT EXISTS (SELECT 1 FROM pins p WHERE p.message_id = messages.id)');
    // Беседа — это канал с типом `dm` (см. ConversationRow): другого признака
    // у реплики нет, и спрашивать его надо у канала, а не гадать по слагу.
    if (scope !== 'all') {
      const dm = "SELECT 1 FROM channels c WHERE c.id = messages.channel_id AND c.type = 'dm'";
      query.andWhere(scope === 'direct' ? `EXISTS (${dm})` : `NOT EXISTS (${dm})`);
    }
    const res = await query.execute();
    const removed = res.affected ?? 0;
    if (removed) {
      const what = scope === 'direct' ? 'реплик в беседах' : 'реплик';
      this.logger.log(`ретенция: удалено ${what} — ${removed}`);
    }
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
    const direct = this.directEffective();
    // Про переписку — только когда у неё СВОЙ срок: строка «беседы как каналы»
    // в каждом логе была бы шумом, а не обещанием.
    if (direct) this.logger.log(`ретенция бесед: ${describeRetention(direct)}`);

    const both = direct ? [policy, direct] : [policy];
    if (both.every((p) => p.mode === 'forever')) return;

    void this.sweep();
    // Без срока хранения час подметания был бы часом хранения — хватает и
    // одной такой политики из двух.
    const interval = both.some((p) => p.mode === 'ephemeral')
      ? SWEEP_INTERVAL_EPHEMERAL_MS
      : SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

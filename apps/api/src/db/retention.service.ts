import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Ретенция: сколько живёт переписка.
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

/** Как часто ходим. Без срока хранения — раз в минуту, см. `parseRetention`. */
const SWEEP_INTERVAL_MS = HOUR_MS;
const SWEEP_INTERVAL_EPHEMERAL_MS = 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Что инсталляция делает с историей. Три исхода, а не число, — потому что
 * «хранить N дней», «хранить всегда» и «не хранить вовсе» это три разных
 * обещания, и одно число их различает только по договорённости, о которой
 * человек не знает.
 */
export type RetentionMode = 'days' | 'forever' | 'ephemeral';

export type Retention =
  | { mode: 'days'; days: number }
  | { mode: 'forever' }
  | { mode: 'ephemeral' };

export const DEFAULT_RETENTION: Retention = { mode: 'days', days: DEFAULT_RETENTION_DAYS };

/** Слова, которыми настройка называется вслух. Первое — каноническое. */
const FOREVER_WORDS = ['forever', 'never', 'unlimited', 'off'];
const EPHEMERAL_WORDS = ['ephemeral', 'none'];

/**
 * Разбор `RETENTION_DAYS`. `null` — «это не похоже ни на что», выше подставят
 * дефолт и скажут об этом в лог.
 *
 * **Ноль означает «хранить всегда», а не «не хранить».** Соблазн был обратный:
 * ноль дней буквально и есть ноль дней хранения. Но за пределами этого файла
 * ноль почти везде читается как «предела нет» (`0` в `MaxAge`, в `TTL`, в
 * `LIMIT 0` уже нет — и именно поэтому договорённость не спасает), и человек,
 * который на своём сервере и своём диске хочет «храни всё», наберёт `0`
 * первым делом. Ошибиться тут можно в две стороны, и они не равны: лишнее
 * сохранённое удаляется одной командой, а удалённое по чужой догадке не
 * возвращается ничем. Поэтому число выбирает безопасную сторону, а редкое
 * «не хранить вовсе» получает собственное слово, которое случайно не наберёшь.
 *
 * Отрицательное сюда же: раньше это был недокументированный способ выключить
 * ретенцию, и инсталляция, настроенная так, продолжает работать как прежде.
 */
export function parseRetention(
  raw: string | undefined = process.env.RETENTION_DAYS,
): Retention | null {
  if (raw === undefined) return DEFAULT_RETENTION;
  const text = raw.trim().toLowerCase();
  if (text === '') return DEFAULT_RETENTION;
  if (FOREVER_WORDS.includes(text)) return { mode: 'forever' };
  if (EPHEMERAL_WORDS.includes(text)) return { mode: 'ephemeral' };
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return { mode: 'forever' };
  return { mode: 'days', days: value };
}

/** Действующая политика: мусор в переменной уже заменён дефолтом. */
export function retention(raw?: string): Retention {
  return parseRetention(raw) ?? DEFAULT_RETENTION;
}

/**
 * Политика словами — одной строкой, в лог при старте и в отказ инсталлятора.
 * Хранение — то, о чём человек имеет право узнать, не читая исходник.
 */
export function describeRetention(r: Retention): string {
  if (r.mode === 'forever') return 'переписка хранится без срока';
  if (r.mode === 'ephemeral') return 'переписка не хранится вовсе';
  return `переписка хранится ${r.days} дн.`;
}

@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: DataSource) {}

  onModuleInit(): void {
    // Мусор в переменной — это не повод молча выбрать дефолт: «14» и «непонятно
    // что, поэтому 14» выглядят в логе одинаково, а означают разное.
    if (parseRetention() === null) {
      this.logger.warn(
        `RETENTION_DAYS="${process.env.RETENTION_DAYS}" не похоже ни на число дней, ` +
          `ни на «${FOREVER_WORDS[0]}», ни на «${EPHEMERAL_WORDS[0]}» — беру ` +
          `${DEFAULT_RETENTION_DAYS} дн.`,
      );
    }

    const policy = this.effective();
    // Говорим всегда, а не только на необычном значении: хранение — обещание
    // людям на этом сервере, и хозяин должен видеть его при каждом старте.
    this.logger.log(`ретенция: ${describeRetention(policy)}`);
    if (policy.mode === 'forever') return;

    void this.sweep();
    // Без срока хранения час подметания был бы часом хранения.
    const interval = policy.mode === 'ephemeral' ? SWEEP_INTERVAL_EPHEMERAL_MS : SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  /** Что делаем на самом деле (мусор в переменной → дефолт). */
  effective(): Retention {
    return retention();
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
}

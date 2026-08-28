/**
 * Что инсталляция делает с историей — как понятие, отдельно от того, кто и
 * когда её подметает.
 *
 * Модуль стоит особняком не для красоты. Разбор `RETENTION_DAYS` нужен
 * настройкам (окружение засевается в таблицу при первом старте), а действующую
 * политику настройки же и раздают обратно `RetentionService` — оставь разбор в
 * сервисе, и два модуля начнут импортировать друг друга.
 */

export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Три исхода, а не число, — потому что «хранить N дней», «хранить всегда» и
 * «не хранить вовсе» это три разных обещания, и одно число их различает только
 * по договорённости, о которой человек не знает.
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
 * умолчание и скажут об этом в лог.
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

/**
 * Жалоба на непонятое значение переменной. Живёт рядом с разбором, чтобы
 * названия режимов в сообщении не разошлись с теми, которые разбор принимает:
 * подсказка, зовущая набрать слово, которого код не знает, хуже молчания.
 */
export function retentionEnvComplaint(raw: string): string {
  return (
    `RETENTION_DAYS="${raw}" не похоже ни на число дней, ` +
    `ни на «${FOREVER_WORDS[0]}», ни на «${EPHEMERAL_WORDS[0]}»`
  );
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

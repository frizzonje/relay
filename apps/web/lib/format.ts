import { getClientLocale } from '@/lib/i18n';

/**
 * Часы:минуты сообщения — форматом занимается Intl, а не мы: 24-часовой вид у
 * одних языков и AM/PM у других получаются сами, без записи в словарь.
 */
export function fmtClock(ts?: number): string {
  return new Intl.DateTimeFormat(getClientLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts || Date.now()));
}

/** Сколько времени в единице — от секунды к году. Порядок важен: ищем первую подходящую. */
const SINCE: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['year', 365 * 24 * 60 * 60 * 1000],
];

/**
 * «Пять минут назад», «вчера». Слова для каждой единицы и каждого языка знает
 * Intl, а не наш словарь: иначе в переводы уехали бы падежи и склонения
 * числительных — ровно то, на чём такие строки и ломаются.
 */
export function fmtSince(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const passed = Date.now() - ms;
  // Самая крупная единица, в которую прошедшее укладывается хотя бы раз: час
  // назад человеку сообщают часом, а не тремя тысячами шестьюстами секундами.
  let [unit, size] = SINCE[0];
  for (const [name, span] of SINCE) {
    if (Math.abs(passed) < span) break;
    [unit, size] = [name, span];
  }
  // `auto` даёт «вчера» вместо «1 день назад» там, где язык так говорит.
  return new Intl.RelativeTimeFormat(getClientLocale(), { numeric: 'auto' }).format(
    -Math.round(passed / size),
    unit,
  );
}

/** Человекочитаемый размер файла — единицы измерения тоже от Intl. */
export function fmtBytes(n?: number): string {
  if (!n && n !== 0) return '';
  const [value, unit, digits] =
    n < 1024
      ? [n, 'byte' as const, 0]
      : n < 1024 * 1024
        ? [n / 1024, 'kilobyte' as const, 0]
        : [n / 1024 / 1024, 'megabyte' as const, 1];
  return new Intl.NumberFormat(getClientLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: digits,
  }).format(value);
}

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

import type { MetricsResponse } from '@relay/shared';

/**
 * Состояние машины, на которой стоит инсталляция (`GET /api/metrics`).
 * Показывается на главном экране вместо заставки: открыл relay — сразу видно,
 * как живёт сервер, а не только что он жив.
 *
 * Кэша здесь нет намеренно (в отличие от `lib/config`): цифры на то и цифры,
 * что каждый опрос должен привозить свежие.
 */
export type { MetricsResponse };

/**
 * Как часто главный экран перечитывает метрики. Совпадает с тактом выборки на
 * сервере: чаще спрашивать бессмысленно (ответ придёт из секундного кэша), реже
 * — экран начинает выглядеть застывшим.
 */
export const METRICS_POLL_MS = 2000;

/**
 * Сколько замеров ЦП видно на графике: 48 × 2 с ≈ полторы минуты. Хранить их
 * нужно на один больше — уехавший за левый край подпирает линию, пока она
 * ползёт (см. `sparkPoints`).
 */
export const CPU_HISTORY = 48;

export async function fetchMetrics(signal?: AbortSignal): Promise<MetricsResponse> {
  const base = process.env.NEXT_PUBLIC_API_URL || '';
  const res = await fetch(`${base}/api/metrics`, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`metrics ${res.status}`);
  return (await res.json()) as MetricsResponse;
}

/** Доля 0..1 → целые проценты; `null` остаётся `null` (на экране прочерк). */
export function percent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

const UNITS = ['b', 'kb', 'mb', 'gb', 'tb'] as const;
export type ByteUnit = (typeof UNITS)[number];

/**
 * Байты в человеческий вид — числом и единицей отдельно, чтобы подпись
 * («ГБ»/«GB») пришла из словаря, а не из этого файла. Шаг 1024: это память и
 * файловая система, а не диски из магазина.
 *
 * Дробную часть держим ровно там, где она что-то значит: 3.4 ГБ читается,
 * 3.42 ГБ — уже шум, а 340 МБ дробей не просит вовсе.
 */
export function toBytes(value: number): { value: number; unit: ByteUnit } {
  if (!Number.isFinite(value) || value < 0) return { value: 0, unit: 'b' };
  let n = value;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return { value: n < 10 ? Math.round(n * 10) / 10 : Math.round(n), unit: UNITS[i] };
}

/**
 * Аптайм в «12д 04:31:07». Дни отдельным числом (их подпись переводится),
 * остальное — моноширинным временем.
 *
 * Секунды здесь не ради точности, а ради честности картинки: на спокойном
 * сервере проценты не шевелятся минутами, и панель без единого движущегося
 * знака читается как зависшая. Тикающие секунды — доказательство, что цифры
 * живые. Клиент досчитывает их сам между опросами (аптайм растёт равномерно,
 * гадать не о чем), поэтому ход ровно посекундный, а не рывками по такту.
 */
export function splitUptime(seconds: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

export interface SparkPoint {
  x: number;
  y: number;
}

/**
 * Точки спарклайна в координатах viewBox `0..(slots-1)` × `0..100`, свежие —
 * у правого края. Пока замеров меньше, чем слотов, линия начинается не от
 * левого края: дорисовывать её нулями значило бы показать простой, которого
 * не было.
 *
 * Один замер сверх окна остаётся и уезжает за левый край (`x = -1`). Он там не
 * лишний: график между опросами непрерывно ползёт влево ровно на один интервал,
 * и без запаса слева за линией тянулась бы пустая полоса.
 */
export function sparkPoints(values: number[], slots: number): SparkPoint[] {
  if (slots <= 0) return [];
  const tail = values.slice(-(slots + 1));
  const first = slots - tail.length;
  return tail.map((v, i) => ({
    x: first + i,
    y: 100 - Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0)),
  }));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Ломаную — в гладкую кривую (`d` для `<path>`).
 *
 * Наклоны считаем по Фричу–Карлсону, а не обычным сплайном: обычный на резком
 * всплеске «перелетает» через замер и рисует провал ниже нуля или горб выше
 * ста — то есть загрузку, которой не было. Здесь кривая между двумя соседними
 * замерами не выходит за их значения, так что сглаживание остаётся честным:
 * оно убирает углы, а не придумывает данные.
 */
export function smoothPath(points: SparkPoint[]): string {
  if (points.length === 0) return '';
  const start = `M ${round(points[0].x)} ${round(points[0].y)}`;
  if (points.length === 1) return start;

  const n = points.length;
  // Секущие между соседями.
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x;
    secant.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
  }

  const slope = new Array<number>(n);
  slope[0] = secant[0];
  slope[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    // Замер — локальный пик или впадина: горизонтальная касательная, иначе
    // кривая проскочит мимо него.
    slope[i] = secant[i - 1] * secant[i] <= 0 ? 0 : (secant[i - 1] + secant[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (secant[i] === 0) {
      slope[i] = 0;
      slope[i + 1] = 0;
      continue;
    }
    const a = slope[i] / secant[i];
    const b = slope[i + 1] / secant[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      slope[i] = tau * a * secant[i];
      slope[i + 1] = tau * b * secant[i];
    }
  }

  let d = start;
  for (let i = 0; i < n - 1; i += 1) {
    const h = points[i + 1].x - points[i].x;
    d +=
      ` C ${round(points[i].x + h / 3)} ${round(points[i].y + (slope[i] * h) / 3)}` +
      ` ${round(points[i + 1].x - h / 3)} ${round(points[i + 1].y - (slope[i + 1] * h) / 3)}` +
      ` ${round(points[i + 1].x)} ${round(points[i + 1].y)}`;
  }
  return d;
}

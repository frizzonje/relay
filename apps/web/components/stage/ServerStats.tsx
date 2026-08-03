'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Logo } from '@/components/ui/Logo';
import { useLocale, useT, type MessageKey } from '@/lib/i18n';
import {
  CPU_HISTORY,
  METRICS_POLL_MS,
  fetchMetrics,
  percent,
  smoothPath,
  sparkPoints,
  splitUptime,
  toBytes,
  type MetricsResponse,
} from '@/lib/metrics';
import { cn } from '@/lib/utils';

/**
 * Состояние сервера на главном экране: процессор, память, диск того железа,
 * где стоит инсталляция. relay ставят на свою машину, и первое, что о ней
 * хочется знать, — дышит ли она.
 *
 * Главная забота этой панели — не соврать про свою живость. На спокойном
 * сервере проценты не меняются минутами, и панель без единого движущегося
 * знака читается как зависшая, хотя цифры свежие. Отсюда две вещи, без которых
 * её нельзя выпускать: спарклайн загрузки (видно и то, что уже прошло) и
 * посекундный аптайм, который клиент досчитывает сам между опросами.
 *
 * Метрика, которую не удалось снять, рисуется прочерком, а не нулём: пустая
 * шкала и «0%» — разные утверждения, и второе было бы враньём.
 */

/** Делений в шкале. */
const SEGMENTS = 32;
/** С этого процента шкала краснеет: не «скоро», а «уже пора смотреть». */
const ALARM_PERCENT = 85;
/** Запас сверху и снизу спарклайна, в единицах шкалы 0..100. */
const SPARK_PAD = 8;
/** Полная высота viewBox спарклайна с этим запасом. */
const VIEW_H = 100 + SPARK_PAD * 2;
/** Один интервал между замерами — в процентах ширины дорожки. */
const SPARK_STEP = 100 / (CPU_HISTORY - 1);

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** Загрузка в процентах → положение пера сверху дорожки, в процентах её высоты. */
function penPercent(value: number): number {
  return ((100 - clampPercent(value) + SPARK_PAD) / VIEW_H) * 100;
}

export function ServerStats() {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  /** История загрузки ЦП для спарклайна, самая свежая — в конце. */
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  /**
   * Сколько замеров ЦП пришло. Нужен как key слоя с графиком: смена key
   * перезапускает ход спарклайна, привязывая его к приходу данных.
   */
  const [samples, setSamples] = useState(0);
  /**
   * Аптайм: замер сервера и момент, когда он приехал. Между опросами
   * досчитываем локально — на экране ровный посекундный ход.
   */
  const [uptime, setUptime] = useState<{ base: number; at: number } | null>(null);
  const [now, setNow] = useState(0);

  const num = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const bytes = useCallback(
    (value: number) => {
      const { value: n, unit } = toBytes(value);
      return `${num.format(n)} ${t(`stats.unit.${unit}` as MessageKey)}`;
    },
    [num, t],
  );

  useEffect(() => {
    // Всё состояние опроса — внутри эффекта, а не в ref'ах: ref переживает
    // перемонтирование (StrictMode в деве монтирует дважды), и «запрос уже
    // идёт» от прошлой жизни компонента заблокировал бы первый тик новой —
    // навсегда, потому что следующий тик планирует как раз этот.
    let alive = true;
    let inFlight = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();

    // Планируем от начала прошлого запроса, а не от его конца: замеры должны
    // приходить ровно по такту, потому что этот же такт задаёт скорость хода
    // графика. Иначе каждый медленный ответ — заминка у правого края.
    const schedule = (spent: number) => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      const wait = Math.max(METRICS_POLL_MS / 4, METRICS_POLL_MS - spent);
      timer = setTimeout(() => void poll(), wait);
    };

    const poll = async () => {
      if (!alive || inFlight) return;
      const startedAt = Date.now();
      // Фоновая вкладка сервер не дёргает: смотреть на цифры некому, а вкладок,
      // открытых и забытых, у людей больше, чем живых. Первый заход —
      // исключение: без него человек, вернувшись на вкладку, увидит «измеряем…»
      // вместо готовой карточки.
      if (loaded && typeof document !== 'undefined' && document.hidden) {
        schedule(0);
        return;
      }
      inFlight = true;
      try {
        const next = await fetchMetrics(ctrl.signal);
        if (!alive) return;
        loaded = true;
        setData(next);
        setFailed(false);
        setUptime({ base: next.uptimeSec, at: Date.now() });
        if (next.cpu.usage !== null) {
          const value = Math.round(next.cpu.usage * 100);
          // Держим на один замер больше видимого окна — он подпирает линию
          // слева, пока та ползёт (см. sparkPoints).
          setCpuHistory((prev) => [...prev, value].slice(-(CPU_HISTORY + 1)));
          setSamples((n) => n + 1);
        }
      } catch (err) {
        if (alive && (err as Error)?.name !== 'AbortError') setFailed(true);
      } finally {
        inFlight = false;
        // Планируем в finally, а не после try: иначе любой отказ обрывал бы
        // цепочку опросов насовсем и карточка застывала бы на месте.
        schedule(Date.now() - startedAt);
      }
    };

    // Вернулись на вкладку — не ждём оставшийся такт, перечитываем сразу.
    const onVisible = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Секундный ход аптайма. Отдельно от опроса: сеть ради этого трогать незачем.
  // Стартовое значение 0, а не Date.now(): до первого ответа сервера аптайм
  // всё равно прочерк, и так сервер с клиентом гидрируются одинаково.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cpu = data ? (data.cpu.usage === null ? null : Math.round(data.cpu.usage * 100)) : null;
  const mem = data ? percent(data.mem.used, data.mem.total) : null;
  const disk = data?.disk ? percent(data.disk.used, data.disk.total) : null;
  const up = uptime ? splitUptime(uptime.base + Math.max(0, now - uptime.at) / 1000) : null;

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <section
        aria-label={t('stats.kicker')}
        className="glass glass-2 flex w-full max-w-[420px] animate-lobby-rise flex-col items-stretch px-7 py-8 sm:px-8"
      >
        <div className="flex flex-col items-center">
          <Logo size={52} animate nodeBg="#0d0f12" />
          <div className="mt-4 flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                failed ? 'bg-danger' : data ? 'animate-pulse-dot bg-ok' : 'bg-text-faint',
              )}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-faint">
              {failed && !data ? t('stats.error') : t('stats.kicker')}
            </span>
          </div>
        </div>

        <div className="mt-7 flex flex-col gap-6">
          {/* ЦП — единственная метрика, которая живёт в секундах, поэтому у неё
              не шкала заполнения, а история: всплеск, который уже кончился,
              иначе не увидеть вовсе. */}
          <Metric
            label={t('stats.cpu')}
            value={cpu}
            detail={
              data
                ? [
                    t('stats.cpu.cores', { count: data.cpu.cores }),
                    data.cpu.load1 !== null
                      ? t('stats.load', { value: num.format(data.cpu.load1) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('stats.measuring')
            }
          >
            <Spark
              values={cpuHistory}
              samples={samples}
              alarm={cpu !== null && cpu >= ALARM_PERCENT}
            />
          </Metric>

          <Metric
            label={t('stats.mem')}
            value={mem}
            detail={
              data
                ? t('stats.of', { used: bytes(data.mem.used), total: bytes(data.mem.total) })
                : t('stats.measuring')
            }
          >
            <Meter value={mem} />
          </Metric>

          <Metric
            label={t('stats.disk')}
            value={disk}
            detail={
              !data
                ? t('stats.measuring')
                : data.disk
                  ? t('stats.of', { used: bytes(data.disk.used), total: bytes(data.disk.total) })
                  : t('stats.disk.unknown')
            }
          >
            <Meter value={disk} />
          </Metric>
        </div>

        <div className="mt-7 flex items-baseline justify-between border-t border-line pt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">
            {t('stats.uptime')}
          </span>
          <span className="font-mono text-[12px] tabular-nums text-text-muted">
            {up
              ? `${up.days > 0 ? `${up.days}${t('stats.uptime.dayShort')} ` : ''}${pad(up.hours)}:${pad(up.minutes)}:${pad(up.seconds)}`
              : '—'}
          </span>
        </div>
      </section>
    </div>
  );
}

/** Строка метрики: подпись, процент, визуализация и абсолютные значения под ней. */
function Metric({
  label,
  value,
  detail,
  children,
}: {
  label: string;
  value: number | null;
  detail: string;
  children: ReactNode;
}) {
  const alarm = value !== null && value >= ALARM_PERCENT;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">
          {label}
        </span>
        <span
          className={cn(
            'font-mono text-[15px] leading-none tabular-nums transition-colors',
            alarm ? 'text-danger' : 'text-text-header',
          )}
        >
          {value === null ? '—' : `${value}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(value === null ? {} : { 'aria-valuenow': value })}
        className="mt-2.5"
      >
        {children}
      </div>
      <div className="mt-2 font-mono text-[11px] leading-none text-text-dim">{detail}</div>
    </div>
  );
}

/** Шкала заполнения — для того, что меряется «сколько занято из всего». */
function Meter({ value }: { value: number | null }) {
  const alarm = value !== null && value >= ALARM_PERCENT;
  const filled = value === null ? 0 : Math.round((value / 100) * SEGMENTS);
  return (
    <div aria-hidden className="flex h-[26px] items-center gap-[3px]">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          // Задержка по индексу — шкала наливается волной слева направо, а не
          // моргает целиком. 6 мс на деление: заметно, но не медленно.
          style={{ transitionDelay: `${i * 6}ms` }}
          className={cn(
            'h-2.5 flex-1 rounded-[2px] transition-colors duration-300',
            i < filled ? (alarm ? 'bg-danger' : 'bg-accent') : 'bg-line',
          )}
        />
      ))}
    </div>
  );
}

/**
 * История загрузки: свежие замеры входят справа, старые уходят за левый край.
 *
 * Скачками этот график двигаться не должен — раз в две секунды дёрнуться на
 * ширину интервала заметно неприятнее, чем не двигаться вовсе. Поэтому слой с
 * линией непрерывно ползёт влево ровно на один интервал за такт опроса, и
 * следующий замер приходит ровно в тот момент, когда он доехал: сдвиг данных и
 * возврат слоя на место гасят друг друга, шва не остаётся.
 *
 * Ход — CSS-анимация трансформа, а не пересчёт по кадрам: она идёт на
 * композиторе, ничего не стоит React'у и не замирает вместе с requestAnimation-
 * Frame. Перезапускает её смена key, то есть приход данных, — если ответ
 * запоздал, график спокойно постоит у края вместо рывка.
 */
function Spark({ values, samples, alarm }: { values: number[]; samples: number; alarm: boolean }) {
  // useId отдаёт идентификатор со служебными символами (`:r0:`, `«r0»`) —
  // чистим их: ссылка на градиент идёт через url(#…).
  const gradient = `spark-${useId().replace(/[^\w-]/g, '')}`;
  const points = sparkPoints(values, CPU_HISTORY);
  const line = smoothPath(points);
  // Заливку опускаем ниже нуля шкалы — иначе на запасе снизу (SPARK_PAD) между
  // ней и дном дорожки оставалась бы щель.
  const floor = 100 + SPARK_PAD;
  const area =
    points.length > 1
      ? `${line} L ${points[points.length - 1].x} ${floor} L ${points[0].x} ${floor} Z`
      : '';
  // Перо позиционируем ровно тем же отображением, что и viewBox, иначе оно
  // разъедется с концом линии. Едет от прошлого замера к свежему: пока слой
  // ползёт, край дорожки показывает как раз этот отрезок.
  const last = values.length - 1;
  const penTo = last >= 0 ? penPercent(values[last]) : null;
  const penFrom = last >= 1 ? penPercent(values[last - 1]) : penTo;

  return (
    <div
      aria-hidden
      // Утопленный фон, а не такой же светлый, как пустые деления шкал рядом:
      // ровная светлая плашка во всю ширину читалась бы как «шкала залита
      // под завязку», то есть ровно наоборот к тому, что показывает линия.
      // Выше шкал соседей намеренно: у ЦП здесь не «сколько занято», а форма
      // во времени, и на 26 пикселях всплеск в полшкалы читается как царапина.
      className={cn(
        'relative h-11 w-full rounded-[4px] border border-line bg-bg-deep transition-colors',
        alarm ? 'text-danger' : 'text-accent',
      )}
    >
      {/* Обрезаем только линию: перо у правого края живёт снаружи, чтобы его
          ореол не срезало рамкой. */}
      <div className="absolute inset-0 overflow-hidden rounded-[3px]">
        {/* Половина шкалы — единственная опорная линия: без неё высота всплеска
            читается только на глаз. Стоит вне ползущего слоя. */}
        <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
        <div
          key={samples}
          style={
            {
              '--spark-step': `${SPARK_STEP}%`,
              animationDuration: `${METRICS_POLL_MS}ms`,
            } as CSSProperties
          }
          // will-change здесь не нужен: слой живёт один такт и всё это время
          // анимируется трансформом — браузер поднимает его на композитор сам,
          // а подсказка заставляла бы пересоздавать слой каждые две секунды.
          className="absolute inset-0 animate-spark-slide"
        >
          <svg
            // Запас сверху и снизу: без него линия при 0% и 100% ложится ровно
            // на рамку дорожки, а перо наполовину вылезает наружу. Слева
            // добавлен интервал под тот самый запасной замер — сам элемент на
            // столько же шире и настолько же сдвинут, поэтому масштаб по
            // горизонтали остаётся прежним.
            viewBox={`-1 ${-SPARK_PAD} ${CPU_HISTORY} ${VIEW_H}`}
            preserveAspectRatio="none"
            style={{ left: `-${SPARK_STEP}%`, width: `${100 + SPARK_STEP}%` }}
            className="absolute inset-y-0 h-full"
          >
            <defs>
              {/* Градиент привязан к дорожке, а не к габаритам линии
                  (userSpaceOnUse): иначе на ровной загрузке он сжимался бы в
                  полоску и заливка меняла бы плотность вместе с данными. */}
              <linearGradient
                id={gradient}
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={-SPARK_PAD}
                x2="0"
                y2={floor}
              >
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.3} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            {area && <path d={area} fill={`url(#${gradient})`} />}
            {points.length > 1 && (
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                // Толщина линии живёт в координатах viewBox и растянулась бы
                // вместе с ним (по горизонтали в разы) — non-scaling-stroke
                // держит её одинаковой на любой ширине карточки.
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
          </svg>
        </div>
      </div>
      {/* Перо — обычным элементом, а не <circle>: viewBox растянут по
          горизонтали, и круг в нём превратился бы в лежачий овал. */}
      {penTo !== null && (
        <span
          key={samples}
          style={
            {
              '--pen-from': `${penFrom}%`,
              '--pen-to': `${penTo}%`,
              animationDuration: `${METRICS_POLL_MS}ms`,
            } as CSSProperties
          }
          className="absolute right-0 -translate-y-1/2 animate-pen-glide"
        >
          <span className="absolute -inset-1 rounded-full bg-current opacity-15" />
          <span className="relative block h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

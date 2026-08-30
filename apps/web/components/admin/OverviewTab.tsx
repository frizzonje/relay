'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminOverview, AdminRetention, MetricsResponse } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useLocale, useT, type MessageKey, type Translate } from '@/lib/i18n';
import { fetchMetrics, percent, splitUptime, toBytes } from '@/lib/metrics';
import { useAdminStore } from '@/stores/admin';

/**
 * Вкладка «Обзор»: инсталляция одним взглядом.
 *
 * ВСЕ ЧИСЛА ЗДЕСЬ ПОСЧИТАНЫ СЕРВЕРОМ, и это главное правило вкладки. Соблазн
 * посчитать людей по привезённой странице или сообщения по загруженной ленте
 * велик и обходится дорого: на трёх людях такая плитка неотличима от честной,
 * на тысяче — показывает пятьдесят, потому что страница именно столько и
 * привезла. Сводка приезжает готовой в `admin-state` (§9.1), и складывать в
 * браузере тут нечего.
 *
 * Плиток две группы, и берутся они из разных мест не по недосмотру.
 * Инсталляция (люди, сообщения, вложения, версия) — это `admin-state`. Машина
 * (процессор, память, диск, аптайм) в сводке панели не живёт вовсе: её меряет
 * `GET /api/metrics` — тот же запрос, которым дышит карточка на главном экране.
 * Второе место для тех же цифр однажды разошлось бы с первым, а считать их в
 * браузере нечем в принципе.
 *
 * Метрика, которую не удалось снять, рисуется прочерком, а не нулём: «0%» и «не
 * померили» — разные утверждения, и второе нулём не пишут.
 */

/** С этого процента плитка краснеет — как и шкалы на главном экране. */
const ALARM_PERCENT = 85;

export function OverviewTab() {
  const t = useT();
  const locale = useLocale();
  const overview = useAdminStore((s) => s.overview);
  /** Состояние машины: `null` — ещё спрашиваем, `false` — не ответила. */
  const [machine, setMachine] = useState<MetricsResponse | null | false>(null);

  const num = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const bytes = useMemo(
    () => (value: number) => {
      const { value: n, unit } = toBytes(value);
      const short = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
      return `${short.format(n)} ${t(`stats.unit.${unit}` as MessageKey)}`;
    },
    [locale, t],
  );

  // Один запрос на открытие вкладки, без опроса по таймеру: панель — не монитор,
  // за живыми цифрами человек идёт на главный экран, где они и тикают. Опрос
  // отсюда жёг бы запросы всё время, пока панель открыта, ради цифры, на
  // которую смотрят один раз.
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    void fetchMetrics(ctrl.signal)
      .then((res) => alive && setMachine(res))
      .catch(() => alive && setMachine(false));
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  if (!overview) return null;

  return (
    <div data-testid="admin-overview" className="flex flex-col gap-4">
      <Section title={t('admin.overview.section.installation')}>
        <Tile id="people" label={t('admin.overview.people')} value={num.format(overview.people)}>
          {t('admin.overview.online', { count: overview.online })}
        </Tile>
        <Tile
          id="messages"
          label={t('admin.overview.messages')}
          value={num.format(overview.messages)}
        >
          {retentionNote(t, overview)}
        </Tile>
        <Tile
          id="storage"
          label={t('admin.overview.storage')}
          value={bytes(overview.storageBytes)}
          alarm={quotaPercent(overview) !== null && quotaPercent(overview)! >= ALARM_PERCENT}
        >
          {overview.storageQuotaBytes
            ? t('admin.overview.storage.quota', { total: bytes(overview.storageQuotaBytes) })
            : t('admin.overview.storage.noQuota')}
        </Tile>
        <Tile id="servers" label={t('admin.overview.servers')} value={num.format(overview.servers)}>
          {t('admin.overview.channels', { count: overview.channels })}
        </Tile>
        <Tile
          id="bans"
          label={t('admin.overview.bans')}
          value={num.format(overview.bans)}
          alarm={overview.bans > 0}
        />
        <Tile
          id="version"
          label={t('admin.overview.version')}
          // Пустая версия — не пропажа: образ собран из исходников, и номера у
          // него нет. Прочерк на этом месте выглядел бы поломкой.
          value={overview.version || t('admin.overview.version.dev')}
          small={!overview.version}
        />
      </Section>

      <Section title={t('stats.kicker')}>
        <Tile
          id="cpu"
          label={t('stats.cpu')}
          value={machineValue(t, machine, (m) => dash(percent(m.cpu.usage ?? NaN, 1), '%'))}
          alarm={alarm(machine, (m) => percent(m.cpu.usage ?? NaN, 1))}
          small={machine === false}
        >
          {machine
            ? [
                t('stats.cpu.cores', { count: machine.cpu.cores }),
                machine.cpu.load1 === null
                  ? null
                  : t('stats.load', { value: machine.cpu.load1.toFixed(2) }),
              ]
                .filter(Boolean)
                .join(' · ')
            : null}
        </Tile>
        <Tile
          id="mem"
          label={t('stats.mem')}
          value={machineValue(t, machine, (m) => dash(percent(m.mem.used, m.mem.total), '%'))}
          alarm={alarm(machine, (m) => percent(m.mem.used, m.mem.total))}
          small={machine === false}
        >
          {machine
            ? t('stats.of', { used: bytes(machine.mem.used), total: bytes(machine.mem.total) })
            : null}
        </Tile>
        <Tile
          id="disk"
          label={t('stats.disk')}
          value={machineValue(t, machine, (m) =>
            m.disk ? dash(percent(m.disk.used, m.disk.total), '%') : t('stats.disk.unknown'),
          )}
          alarm={alarm(machine, (m) => (m.disk ? percent(m.disk.used, m.disk.total) : null))}
          small={machine === false || (machine !== null && !machine.disk)}
        >
          {machine && machine.disk
            ? t('stats.of', { used: bytes(machine.disk.used), total: bytes(machine.disk.total) })
            : null}
        </Tile>
        <Tile
          id="uptime"
          label={t('stats.uptime')}
          value={machineValue(t, machine, (m) => uptimeText(t, m.uptimeSec))}
          small={machine === false}
        />
      </Section>
    </div>
  );
}

/** Заголовок над группой плиток: инсталляция отдельно, железо отдельно. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">{title}</h3>
      <div className="grid grid-cols-3 gap-2 max-md:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * Одна плитка: подпись, число и строка под ним.
 *
 * Число крупное и моноширинное — плитки стоят решёткой, и цифры разной ширины
 * прыгали бы от значения к значению.
 */
function Tile({
  id,
  label,
  value,
  alarm,
  small,
  children,
}: {
  id: string;
  label: string;
  value: string;
  /** Красным — там, где пора смотреть: забитый диск, поставленные баны. */
  alarm?: boolean;
  /** Значение — не число, а слово: крупным моно оно не читается. */
  small?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={`admin-tile-${id}`}
      className="min-w-0 rounded-[10px] border border-line bg-bg-elev/60 px-3.5 py-3"
    >
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-text-faint">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 truncate font-mono tabular-nums',
          small ? 'text-[13px] leading-[1.5]' : 'text-[22px] leading-tight',
          alarm ? 'text-danger' : 'text-text-header',
        )}
      >
        {value}
      </div>
      {children ? (
        <div className="mt-0.5 truncate text-[12px] text-text-muted">{children}</div>
      ) : null}
    </div>
  );
}

/** Процент с подписью или прочерк: не померили — так и говорим. */
function dash(value: number | null, suffix: string): string {
  return value === null ? '—' : `${value}${suffix}`;
}

/** Значение машинной плитки с двумя её особыми состояниями. */
function machineValue(
  t: Translate,
  machine: MetricsResponse | null | false,
  of: (m: MetricsResponse) => string,
): string {
  if (machine === null) return t('stats.measuring');
  if (machine === false) return t('stats.error');
  return of(machine);
}

function alarm(
  machine: MetricsResponse | null | false,
  of: (m: MetricsResponse) => number | null,
): boolean {
  if (!machine) return false;
  const value = of(machine);
  return value !== null && value >= ALARM_PERCENT;
}

/** Насколько забита квота вложений. `null` — квоты нет вовсе. */
function quotaPercent(overview: AdminOverview): number | null {
  if (!overview.storageQuotaBytes) return null;
  return percent(overview.storageBytes, overview.storageQuotaBytes);
}

/** «12д 04:31:07» — дни числом (их подпись переводится), остальное временем. */
function uptimeText(t: Translate, seconds: number): string {
  const { days, hours, minutes, seconds: secs } = splitUptime(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return days ? `${days}${t('stats.uptime.dayShort')} ${clock}` : clock;
}

/**
 * Что инсталляция делает с историей — словами, а не числом дней.
 *
 * Политика личной переписки называется отдельно и только когда она СВОЯ:
 * «как у каналов» — это `null` в сводке, и повторять при нём общий срок значило
 * бы делать вид, что настроек две, когда действует одна.
 */
function retentionNote(t: Translate, overview: AdminOverview): string {
  const own = retentionText(t, overview.retention);
  if (!overview.directRetention) return own;
  return `${own} · ${t('admin.overview.retention.direct', {
    value: retentionText(t, overview.directRetention),
  })}`;
}

function retentionText(t: Translate, retention: AdminRetention): string {
  if (retention.mode === 'forever') return t('admin.overview.retention.forever');
  if (retention.mode === 'ephemeral') return t('admin.overview.retention.ephemeral');
  return t('admin.overview.retention.days', { count: retention.days ?? 0 });
}

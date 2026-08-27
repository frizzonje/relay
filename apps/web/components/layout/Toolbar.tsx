'use client';

import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-mobile';
import { useUiStore } from '@/stores/ui';
import { useT } from '@/lib/i18n';

/** Одна цель тулбара — общее описание для рейки и полосы. */
interface Target {
  key: 'direct' | 'call' | 'admin';
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
}

/**
 * Вторая, узкая рейка рядом с рейкой серверов — вариант размещения `1b` из
 * референса (`reference/direct-messages/direct-messages-reference.html`):
 * раздел ЛС равноправен серверам, а не спрятан внутри одного из них (см.
 * `docs/plans/relay-2.0.md`). На десктопе — вертикальная рейка 64px, на узком
 * экране — горизонтальная полоса тех же целей.
 *
 * `Call` и `Admin` нарисованы, но выключены: экран 1:1-звонка и админка
 * распахнутся в следующих этапах (B и C), а подвинуть тулбар второй раз дороже,
 * чем нарисовать под них место заранее неактивным.
 *
 * Бейдж непрочитанного на `Direct` и стек «кто в сети» внизу рейки сюда пока не
 * входят: обоим нечем наполниться до стора ЛС и presence-стора (этапы 9 и B) —
 * рисовать их раньше значило бы угадывать состав.
 */
export function Toolbar() {
  const t = useT();
  const mobile = useIsMobile();
  const dmSection = useUiStore((s) => s.dmSection);
  const openDmSection = useUiStore((s) => s.openDmSection);

  const targets: Target[] = [
    {
      key: 'direct',
      icon: 'message-square',
      label: t('toolbar.direct'),
      active: dmSection,
      onClick: openDmSection,
      testId: 'toolbar-direct',
    },
    { key: 'call', icon: 'phone', label: t('toolbar.call'), disabled: true },
    { key: 'admin', icon: 'shield', label: t('toolbar.admin'), disabled: true },
  ];

  return mobile ? <ToolbarStrip targets={targets} /> : <ToolbarRail targets={targets} />;
}

/**
 * Кнопка-цель. Выключенные цели не получают HTML `disabled`: этот атрибут
 * заодно глушит наведение мышью и фокус с клавиатуры, а тултип и «скоро» в
 * названии — единственное, что объясняет пустую с виду кнопку, — тогда были
 * бы недоступны ни мышью, ни клавиатурой.
 *
 * Отсюда два разных места для одного и того же «скоро»: `title` — для наведения
 * мышью (человек видит текст рядом с курсором), `aria-label` — для скринридера
 * (у него нет курсора, и всплывающая подсказка мимо него проходит).
 */
function TargetButton({
  target,
  tooltip,
  accessibleLabel,
  className,
  showLabel,
}: {
  target: Target;
  tooltip: string;
  accessibleLabel: string;
  className: string;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={target.testId}
      title={tooltip}
      aria-label={accessibleLabel}
      aria-disabled={target.disabled || undefined}
      onClick={target.disabled ? undefined : target.onClick}
      className={className}
    >
      <Icon name={target.icon} className="text-[20px]" strokeWidth={1.8} />
      {showLabel && <span className="text-[11px] font-medium leading-none">{target.label}</span>}
    </button>
  );
}

/** Название, которое озвучит скринридер: у выключенных целей — с пометкой «скоро». */
function accessibleLabel(target: Target, soon: string): string {
  return target.disabled ? `${target.label} — ${soon}` : target.label;
}

function ToolbarRail({ targets }: { targets: Target[] }) {
  const t = useT();
  const soon = t('dm.soon');
  return (
    <nav
      aria-label={t('toolbar.label')}
      className="panel panel-rail flex w-16 shrink-0 flex-col items-center gap-2 border-r border-line py-3"
    >
      {targets.map((target) => (
        <TargetButton
          key={target.key}
          target={target}
          tooltip={target.disabled ? soon : target.label}
          accessibleLabel={accessibleLabel(target, soon)}
          className={cn(
            // focus-visible живёт в базовой строке, а не в одной из веток: цель
            // остаётся фокусируемой (не получает HTML `disabled`, см. комментарий
            // TargetButton) во всех трёх состояниях, и кольцо обязано следовать за
            // ней везде — иначе таб останавливается на невидимой точке экрана.
            'grid h-11 w-11 shrink-0 place-items-center rounded-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
            target.disabled
              ? 'cursor-not-allowed text-text-faint'
              : target.active
                ? 'bg-bg-active text-text-header'
                : 'text-text-muted hover:bg-bg-hover hover:text-text-header',
          )}
        />
      ))}
      {/* Разделитель перед местом под стек присутствия (см. комментарий выше). */}
      <span className="my-1 h-0.5 w-8 shrink-0 rounded-full bg-white/10" />
    </nav>
  );
}

function ToolbarStrip({ targets }: { targets: Target[] }) {
  const t = useT();
  const soon = t('dm.soon');
  return (
    <nav
      aria-label={t('toolbar.label')}
      className="panel panel-sidebar flex shrink-0 gap-1.5 border-b border-line px-2 py-2"
    >
      {targets.map((target) => (
        <TargetButton
          key={target.key}
          target={target}
          tooltip={target.disabled ? soon : target.label}
          accessibleLabel={accessibleLabel(target, soon)}
          showLabel
          className={cn(
            // Та же логика, что и в рейке: кольцо — в базовой строке, вне веток.
            'flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
            target.disabled
              ? 'cursor-not-allowed text-text-faint'
              : target.active
                ? 'bg-bg-active text-text-header'
                : 'text-text-muted hover:bg-bg-hover hover:text-text-header',
          )}
        />
      ))}
    </nav>
  );
}

'use client';

import type { DmConversation } from '@relay/shared';
import { Icon, type IconName } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-mobile';
import { useUiStore } from '@/stores/ui';
import { useDmStore, useUnreadIn } from '@/stores/dm';
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
 * Узкая рейка у правого края экрана, за колонкой состава — вариант размещения
 * `1a` из референса (`reference/direct-messages/direct-messages-reference.html`):
 * раздел ЛС равноправен серверам, а не спрятан внутри одного из них (см.
 * `docs/plans/relay-2.0.md`). На десктопе — вертикальная рейка 64px, на узком
 * экране — горизонтальная полоса тех же целей НАД списком каналов (правого края
 * на телефоне нет: там колонки показываются по одной).
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
  const inDm = useUiStore((s) => s.view === 'dm');
  const toggleDmSection = useUiStore((s) => s.toggleDmSection);

  const targets: Target[] = [
    {
      key: 'direct',
      icon: 'message-square',
      label: t('toolbar.direct'),
      // Подсвечена и при свёрнутом списке: беседа на сцене — это тоже «ты в ЛС»,
      // и гаснуть кнопке в этот момент значит терять человека на экране.
      active: dmSection || inDm,
      onClick: toggleDmSection,
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
      className="panel panel-rail flex w-16 shrink-0 flex-col items-center gap-2 border-l border-line py-3"
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
      <RecentPeers />
    </nav>
  );
}

/**
 * Сколько лиц помещается в рейку, не превращая её в список переписок.
 *
 * Шесть — не вкус, а высота: три цели с разделителем занимают ~180px, каждое
 * лицо ещё 52, и на шестом рейка укладывается примерно в 490px. Прокрутки тут
 * нарочно нет — `overflow-y` обрезал бы и всплывающие подсказки с ником, и
 * пилюлю непрочитанного: по CSS прокрутка по одной оси делает `visible` по
 * второй недостижимым.
 */
const RAIL_PEERS = 6;

/**
 * Стек лиц под разделителем: с кем говорили последними.
 *
 * Это не украшение, а вторая половина того же решения, что свернуло список
 * переписок при входе в беседу (см. `openDm` в stores/ui.ts). Список подменяет
 * собой каналы, поэтому держать его раскрытым нельзя; но и уходить в ЛС через
 * два клика каждый раз — плохой размен. Лица закрывают частый случай: перейти
 * к тому, с кем и так переписываешься, — один клик, не открывая ничего.
 *
 * Порядок — тот же, что в списке (свежие сверху): `useDmStore` держит
 * `conversations` отсортированными, здесь берётся только начало.
 */
function RecentPeers() {
  const conversations = useDmStore((s) => s.conversations);
  const recent = conversations.slice(0, RAIL_PEERS);
  if (recent.length === 0) return null;

  return (
    <>
      {/* Разделитель появляется вместе с лицами: пустой он отчёркивал бы
          пустоту — на свежей установке рейка и так короткая. */}
      <span className="my-1 h-0.5 w-8 shrink-0 rounded-full bg-white/10" />
      <div className="flex flex-col items-center gap-2">
        {recent.map((c) => (
          <PeerFace key={c.slug} conversation={c} />
        ))}
      </div>
    </>
  );
}

/**
 * Одно лицо в рейке. Ник — во всплывающей подсказке слева (рейка стоит у
 * правого края, и подсказка вправо ушла бы за экран), отпечаток — нет: на
 * четырёх десятках пикселей он нечитаем, а само лицо и есть отпечаток, только
 * рисунком (см. lib/identicon.ts).
 */
function PeerFace({ conversation }: { conversation: DmConversation }) {
  const active = useUiStore((s) => s.dmRoom === conversation.slug);
  const openDm = useUiStore((s) => s.openDm);
  const unread = useUnreadIn(conversation.slug, active);
  const nick = conversation.peer.nick;

  return (
    <div className="group/face relative shrink-0">
      <button
        type="button"
        onClick={() => openDm(conversation.slug, conversation.peer.fingerprint, nick)}
        aria-label={nick}
        aria-current={active || undefined}
        className={cn(
          'grid h-11 w-11 place-items-center rounded-[14px] outline-none transition-[background-color,box-shadow,transform] duration-200',
          'hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-line-strong active:scale-95',
          active && 'bg-bg-active ring-1 ring-inset ring-white/15',
        )}
      >
        <Identicon fingerprint={conversation.peer.fingerprint} size={30} />
      </button>

      {/* Пилюля справа, а не слева: рейка съехала к правому краю экрана, и
          метка «здесь есть непрочитанное» должна лежать на внешней стороне,
          иначе она упирается в сцену. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-2 top-1/2 w-1 -translate-y-1/2 rounded-l bg-white transition-all duration-200',
          active ? 'h-8' : 'h-0 opacity-0 group-hover/face:h-4 group-hover/face:opacity-100',
          unread && !active && 'h-2 opacity-100',
        )}
      />

      <span
        role="tooltip"
        className={cn(
          'glass glass-3 pointer-events-none absolute right-full top-1/2 z-30 mr-3 -translate-y-1/2',
          'translate-x-[6px] scale-95 whitespace-nowrap px-3 py-1.5 text-[13px] font-semibold text-text-header opacity-0 shadow-xl',
          'transition-all duration-150 group-hover/face:translate-x-0 group-hover/face:scale-100 group-hover/face:opacity-100',
        )}
      >
        {nick}
        <span className="absolute left-full top-1/2 -ml-px h-2 w-2 -translate-y-1/2 rotate-45 bg-bg-elev" />
      </span>
    </div>
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

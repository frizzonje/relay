'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { DmConversation } from '@relay/shared';
import { Icon, type IconName } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { cn } from '@/lib/utils';
import { springPop } from '@/lib/motion';
import { useIsMobile } from '@/lib/use-mobile';
import { useUiStore } from '@/stores/ui';
import { useDmStore, useUnreadCount, useUnreadIn } from '@/stores/dm';
import { useT } from '@/lib/i18n';

/** Одна цель тулбара — общее описание для рейки и полосы. */
interface Target {
  key: 'direct' | 'admin';
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
  /** Непрочитанное на цели. 0 — бейджа нет вовсе (см. `TargetButton`). */
  badge?: number;
}

/**
 * Узкая рейка у правого края экрана, за колонкой состава — вариант размещения
 * `1a` из референса (`reference/direct-messages/direct-messages-reference.html`):
 * раздел ЛС равноправен серверам, а не спрятан внутри одного из них (см.
 * `docs/plans/relay-2.0.md`). На десктопе — вертикальная рейка 64px, на узком
 * экране — горизонтальная полоса тех же целей НАД списком каналов (правого края
 * на телефоне нет: там колонки показываются по одной).
 *
 * Целей две: ЛС и админка. Звонка среди них нет — звонят не «вообще», а
 * человеку, и кнопка для этого стоит там, где он назван: в шапке беседы и в
 * карточке собеседника. Отдельная цель в рейке вела бы в никуда: выбирать
 * собеседника пришлось бы всё равно, то есть открывать те же ЛС.
 * `Admin` нарисован, но выключен: админка распахнётся этапом C.
 *
 * На `Direct` висит бейдж непрочитанного, под целями — лица тех, с кем говорили
 * последними (`RecentPeers`). Бейдж нужен ровно там, где лиц не хватает: их
 * шесть, а бесед может быть больше, и без него непрочитанное в седьмой не видно
 * НИГДЕ, пока раздел свёрнут. Присутствие («кто в сети») по-прежнему ждёт
 * своего стора — этап B.
 */
export function Toolbar() {
  const t = useT();
  const mobile = useIsMobile();
  const dmSection = useUiStore((s) => s.dmSection);
  const inDm = useUiStore((s) => s.view === 'dm');
  const toggleDmSection = useUiStore((s) => s.toggleDmSection);
  const unread = useUnreadCount();

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
      badge: unread,
    },
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
  badgeRing,
}: {
  target: Target;
  tooltip: string;
  accessibleLabel: string;
  className: string;
  showLabel?: boolean;
  /** Чем обвести бейдж — цветом той панели, на которой он лежит. */
  badgeRing: string;
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
      {/* Число, а не точка: цель одна на все беседы, и «где-то одно» с «везде
          понемногу» человек решает по-разному. Больше девяти не пишем — на
          16 точках это уже не число, а пятно; `aria-label` кнопки при этом
          несёт точный счёт (см. accessibleLabel). */}
      <AnimatePresence initial={false}>
        {!!target.badge && (
          <motion.span
            aria-hidden
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={springPop}
            className={cn(
              'absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white ring-2',
              badgeRing,
            )}
          >
            {target.badge > 9 ? '9+' : target.badge}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/**
 * Название, которое озвучит скринридер: у выключенных целей — с пометкой
 * «скоро», у цели с бейджем — со счётом. Бейдж нарисован `aria-hidden`: цифра
 * без своего названия («3») диктору ничего не говорит, а вот «ЛС, 3
 * непрочитанные переписки» — говорит.
 */
function accessibleLabel(target: Target, soon: string, unread: string): string {
  if (target.disabled) return `${target.label} — ${soon}`;
  return target.badge ? `${target.label} — ${unread}` : target.label;
}

function ToolbarRail({ targets }: { targets: Target[] }) {
  const t = useT();
  const soon = t('dm.soon');
  return (
    <nav
      aria-label={t('toolbar.label')}
      // `relative z-30` — чтобы панель ЛС уезжала ЗА рейку, а не поверх неё
      // (см. DmDrawer): у позиционированного соседа иначе стопка выше.
      className="panel panel-rail relative z-30 flex w-16 shrink-0 flex-col items-center gap-2 border-l border-line py-3"
    >
      {targets.map((target) => (
        <TargetButton
          key={target.key}
          target={target}
          tooltip={target.disabled ? soon : target.label}
          accessibleLabel={accessibleLabel(
            target,
            soon,
            t('toolbar.direct.unread', { count: target.badge ?? 0 }),
          )}
          badgeRing="ring-bg-rail"
          className={cn(
            // focus-visible живёт в базовой строке, а не в одной из веток: цель
            // остаётся фокусируемой (не получает HTML `disabled`, см. комментарий
            // TargetButton) во всех трёх состояниях, и кольцо обязано следовать за
            // ней везде — иначе таб останавливается на невидимой точке экрана.
            'relative grid h-11 w-11 shrink-0 place-items-center rounded-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
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
 * Сколько лиц показывать. Одно число на обе раскладки — «последние, с кем
 * говорил» не должно значить разное в зависимости от ширины экрана.
 *
 * Шесть — не вкус, а мера: в рейке две цели с разделителем занимают ~130px,
 * каждое лицо ещё 52, и на шестом она укладывается примерно в 440px; в полосе
 * на телефоне шесть лиц по 44px с зазорами — это 304px, то есть ровно та
 * ширина, что остаётся от 375 за вычетом полей.
 */
const RECENT_PEERS = 6;

/**
 * Стек лиц: с кем говорили последними.
 *
 * Это не украшение: панель со списком уезжает, стоит войти в канал (см.
 * `openText` в stores/ui.ts), и возвращаться к переписке через раскрытие
 * списка каждый раз — плохой размен. Лица закрывают частый случай: перейти к
 * тому, с кем и так переписываешься, — один клик, не открывая ничего.
 *
 * Порядок — тот же, что в списке (свежие первыми): `useDmStore` держит
 * `conversations` отсортированными, здесь берётся только начало.
 *
 * `strip` — раскладка полосы (телефон): лица встают в строку под тремя целями,
 * а не столбцом под разделителем. Компонент один на обе: выбор переписок,
 * непрочитанное и переход — одно и то же решение, и разъехаться этим двум
 * представлениям нельзя.
 */
function RecentPeers({ strip }: { strip?: boolean }) {
  const conversations = useDmStore((s) => s.conversations);
  const recent = conversations.slice(0, RECENT_PEERS);
  if (recent.length === 0) return null;

  if (strip) {
    return (
      // Прокрутка по X здесь допустима: в рейке её запрещала всплывающая
      // подсказка (`overflow` по одной оси делает `visible` по второй
      // недостижимым), а на телефоне подсказки нет — ховера не бывает.
      // Полоса строго одна строка: разрастись во вторую значит съесть список
      // каналов, ради которого этот экран и открыт.
      <div className="-mx-2 mt-1.5 flex gap-1.5 overflow-x-auto border-t border-line px-2 pt-1.5">
        {recent.map((c) => (
          <PeerFace key={c.slug} conversation={c} strip />
        ))}
      </div>
    );
  }

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
 * Одно лицо. Ник — во всплывающей подсказке слева (рейка стоит у правого края,
 * и подсказка вправо ушла бы за экран), отпечаток — нет: на четырёх десятках
 * пикселей он нечитаем, а само лицо и есть отпечаток, только рисунком (см.
 * lib/identicon.ts).
 *
 * В полосе (`strip`) от этого остаётся только цель и метка непрочитанного:
 * подсказки на телефоне не бывает — она держится на ховере, — а метку нельзя
 * вешать на внешний край, потому что внешнего края у горизонтальной полосы
 * нет: соседнее лицо стоит вплотную. Поэтому там точка ВНУТРИ цели.
 */
function PeerFace({ conversation, strip }: { conversation: DmConversation; strip?: boolean }) {
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

      {strip ? (
        // Точка у самого лица, а не в углу цели: цель 44px, лицо в ней 30px, и
        // метка в углу коробки висела бы в пустоте отдельно от того, к чему
        // относится. Знак и цвет — те же, что у строки списка переписок
        // (см. DmList); кольцо по цвету полосы отделяет её от рисунка лица.
        unread && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent-strong ring-2 ring-bg-sidebar"
          />
        )
      ) : (
        <>
          {/* Пилюля справа, а не слева: рейка съехала к правому краю экрана, и
              метка «здесь есть непрочитанное» должна лежать на внешней стороне,
              иначе она упирается в сцену. */}
          <span
            aria-hidden
            className={cn(
              // Токен, а не `bg-white`: в светлой теме рейка сама почти белая
              // (--color-bg-rail: #e8eaee), и белая метка на ней исчезала —
              // контраст 1.13:1. `accent-strong` инвертируется вместе с темой и
              // красит те же три остальных места, где нарисовано непрочитанное.
              'pointer-events-none absolute -right-2 top-1/2 w-1 -translate-y-1/2 rounded-l bg-accent-strong transition-all duration-200',
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
        </>
      )}
    </div>
  );
}

function ToolbarStrip({ targets }: { targets: Target[] }) {
  const t = useT();
  const soon = t('dm.soon');
  return (
    <nav
      aria-label={t('toolbar.label')}
      className="panel panel-sidebar flex shrink-0 flex-col border-b border-line px-2 py-2"
    >
      <div className="flex gap-1.5">
        {targets.map((target) => (
          <TargetButton
            key={target.key}
            target={target}
            tooltip={target.disabled ? soon : target.label}
            accessibleLabel={accessibleLabel(
              target,
              soon,
              t('toolbar.direct.unread', { count: target.badge ?? 0 }),
            )}
            badgeRing="ring-bg-sidebar"
            showLabel
            className={cn(
              // Та же логика, что и в рейке: кольцо — в базовой строке, вне веток.
              'relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
              target.disabled
                ? 'cursor-not-allowed text-text-faint'
                : target.active
                  ? 'bg-bg-active text-text-header'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-header',
            )}
          />
        ))}
      </div>
      <RecentPeers strip />
    </nav>
  );
}

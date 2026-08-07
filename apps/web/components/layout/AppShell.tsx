'use client';

import { useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-mobile';
import { useUiStore, type MobilePanel } from '@/stores/ui';
import { ServerRail } from '@/components/layout/ServerRail';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';
import { Controls } from '@/components/layout/Controls';
import { Members } from '@/components/layout/Members';
import { OnlineMembers } from '@/components/layout/OnlineMembers';
import { MobileNav } from '@/components/layout/MobileNav';
import { Stage } from '@/components/stage/Stage';

/**
 * Мягкое проявление панели, ставшей активной на мобиле. Только прозрачность:
 * сдвиг создал бы у панели transform, а внутри неё живут `position: fixed`
 * (лайтбокс картинки, плитка на весь экран) — их бы прибило к панели.
 */
const panelFade = {
  in: { opacity: 1, transition: { duration: 0.18, ease: [0.2, 0.8, 0.3, 1] as const } },
  out: { opacity: 0, transition: { duration: 0.1 } },
};

/**
 * Каркас приложения с адаптивной раскладкой.
 *
 * Десктоп (`md:`): привычные колонки в ряд — рейка+сайдбар · сцена · состав.
 * Обёртка панелей на `md:` становится `display:contents`, поэтому три группы
 * встают прямыми детьми внешнего ряда.
 *
 * Мобайл (`< md`): по одной панели на экран, сверху — шапка (MobileNav) со
 * стрелкой назад. Активную панель держит ui-стор (`mobilePanel`); неактивные —
 * `max-md:hidden`.
 */
export function AppShell() {
  const panel = useUiStore((s) => s.mobilePanel);
  const view = useUiStore((s) => s.view);
  const textRoom = useUiStore((s) => s.textRoom);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const setMobilePanel = useUiStore((s) => s.setMobilePanel);
  const mobile = useIsMobile();

  // Открыли канал (текст/голос) — на мобиле сразу показываем сцену, чтобы не
  // приходилось тапать «Сцена» руками. На десктопе панель игнорируется.
  useEffect(() => {
    if (view === 'text' || view === 'voice') setMobilePanel('stage');
  }, [view, textRoom, voiceRoom, setMobilePanel]);

  // Состав есть только в канале; если вкладка «Состав» осталась активной после
  // ухода в лобби — показываем сцену вместо пустого экрана.
  const hasPeople = view === 'voice' || view === 'text';
  const effective: MobilePanel = panel === 'people' && !hasPeople ? 'stage' : panel;

  // На десктопе видны все колонки разом — там анимации смены панели быть не должно.
  const shown = (which: MobilePanel) => (mobile ? (effective === which ? 'in' : 'out') : 'in');

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden md:flex-row">
      <MobileNav />

      {/* Обёртка панелей: ряд на мобиле (одна видимая панель), contents на десктопе */}
      <div className="flex min-h-0 flex-1 md:contents">
        {/* Навигация: рейка + сайдбар */}
        <Panel
          className={cn('shrink-0 max-md:w-full', effective !== 'nav' && 'max-md:hidden')}
          state={shown('nav')}
        >
          <ServerRail />
          <Sidebar />
        </Panel>

        {/* Сцена. Топбар — только на десктопе: на мобиле имя канала в шапке */}
        <Panel
          as="main"
          className={cn('min-w-0 flex-1 flex-col', effective !== 'stage' && 'max-md:hidden')}
          state={shown('stage')}
        >
          <Topbar />
          <Stage />
          <Controls />
        </Panel>

        {/* Состав: голосовой (Members) или текстовый (OnlineMembers) — рендерится
            один в зависимости от вида; на мобиле занимает всю ширину */}
        <Panel
          className={cn('shrink-0 max-md:w-full', effective !== 'people' && 'max-md:hidden')}
          state={shown('people')}
        >
          <Members />
          <OnlineMembers />
        </Panel>
      </div>
    </div>
  );
}

/** Колонка каркаса: на мобиле проявляется, когда становится активной. */
function Panel({
  as,
  className,
  state,
  children,
}: {
  as?: 'main';
  className?: string;
  state: 'in' | 'out';
  children: ReactNode;
}) {
  const Tag = as === 'main' ? motion.main : motion.div;
  return (
    <Tag
      variants={panelFade}
      initial={false}
      animate={state}
      className={cn('flex min-h-0', className)}
    >
      {children}
    </Tag>
  );
}

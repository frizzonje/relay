'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useUiStore, type MobilePanel } from '@/stores/ui';
import { ServerRail } from '@/components/layout/ServerRail';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';
import { Controls } from '@/components/layout/Controls';
import { Members } from '@/components/layout/Members';
import { OnlineMembers } from '@/components/layout/OnlineMembers';
import { MobileBar } from '@/components/layout/MobileBar';
import { JoinByCodeSheet } from '@/components/layout/JoinByCodeSheet';
import { Stage } from '@/components/stage/Stage';

/**
 * Каркас приложения с адаптивной раскладкой.
 *
 * Десктоп (`md:`): привычные колонки в ряд — рейка+сайдбар · сцена · состав.
 * Обёртка панелей на `md:` становится `display:contents`, поэтому три группы
 * встают прямыми детьми внешнего ряда.
 *
 * Мобайл (`< md`): по одной панели на экран, снизу — таб-бар (MobileBar).
 * Активную панель держит ui-стор (`mobilePanel`); неактивные — `max-md:hidden`.
 */
export function AppShell() {
  const panel = useUiStore((s) => s.mobilePanel);
  const view = useUiStore((s) => s.view);
  const textRoom = useUiStore((s) => s.textRoom);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const setMobilePanel = useUiStore((s) => s.setMobilePanel);

  // Открыли канал (текст/голос) — на мобиле сразу показываем сцену, чтобы не
  // приходилось тапать «Сцена» руками. На десктопе панель игнорируется.
  useEffect(() => {
    if (view === 'text' || view === 'voice') setMobilePanel('stage');
  }, [view, textRoom, voiceRoom, setMobilePanel]);

  // Состав есть только в канале; если вкладка «Состав» осталась активной после
  // ухода в лобби — показываем сцену вместо пустого экрана.
  const hasPeople = view === 'voice' || view === 'text';
  const effective: MobilePanel = panel === 'people' && !hasPeople ? 'stage' : panel;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden md:flex-row">
      {/* Обёртка панелей: ряд на мобиле (одна видимая панель), contents на десктопе */}
      <div className="flex min-h-0 flex-1 md:contents">
        {/* Навигация: рейка + сайдбар */}
        <div
          className={cn(
            'flex min-h-0 shrink-0 max-md:w-full',
            effective !== 'nav' && 'max-md:hidden',
          )}
        >
          <ServerRail />
          <Sidebar />
        </div>

        {/* Сцена */}
        <main
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col',
            effective !== 'stage' && 'max-md:hidden',
          )}
        >
          <Topbar />
          <Stage />
          <Controls />
        </main>

        {/* Состав: голосовой (Members) или текстовый (OnlineMembers) — рендерится
            один в зависимости от вида; на мобиле занимает всю ширину */}
        <div
          className={cn(
            'flex min-h-0 shrink-0 max-md:w-full',
            effective !== 'people' && 'max-md:hidden',
          )}
        >
          <Members />
          <OnlineMembers />
        </div>
      </div>

      <MobileBar />
      <JoinByCodeSheet />
    </div>
  );
}

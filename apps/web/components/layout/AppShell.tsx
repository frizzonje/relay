'use client';

import { useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { readOwnerToken, readPairCode } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-mobile';
import { targetView, useUiStore, type MobilePanel } from '@/stores/ui';
import { useOwnerStore } from '@/stores/owner';
import { usePairingStore } from '@/stores/pairing';
import { AdmitDeviceDialog } from '@/components/layout/AdmitDeviceDialog';
import { OwnerClaimDialog } from '@/components/layout/OwnerClaimDialog';
import { BannedGate } from '@/components/layout/BannedGate';
import { OutdatedGate } from '@/components/layout/OutdatedGate';
import { ServerRail } from '@/components/layout/ServerRail';
import { Toolbar } from '@/components/layout/Toolbar';
import { Sidebar } from '@/components/layout/Sidebar';
import { DmList } from '@/components/dm/DmList';
import { DmDrawer } from '@/components/dm/DmDrawer';
import { PeoplePicker } from '@/components/dm/PeoplePicker';
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
  // Раздел ЛС. На телефоне он подменяет сайдбар целиком — там панели показаны
  // по одной, и втащить второй список рядом некуда. На десктопе не подменяет
  // ничего: список выезжает справа своей панелью (см. DmDrawer), а каналы
  // остаются на месте.
  const dmSection = useUiStore((s) => s.dmSection);
  const pickerOpen = useUiStore((s) => s.peoplePickerOpen);
  const setPickerOpen = useUiStore((s) => s.setPeoplePickerOpen);
  // Куда идём — по нему решаем про панели: ждать конца анимации сцены им незачем.
  const going = useUiStore(targetView);
  const textRoom = useUiStore((s) => s.textRoom);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const setMobilePanel = useUiStore((s) => s.setMobilePanel);
  const mobile = useIsMobile();

  // Открыли канал (текст/голос) — на мобиле сразу показываем сцену, чтобы не
  // приходилось тапать «Сцена» руками. На десктопе панель игнорируется.
  useEffect(() => {
    if (going === 'text' || going === 'voice') setMobilePanel('stage');
  }, [going, textRoom, voiceRoom, setMobilePanel]);

  // Ссылка из QR: код связки приезжает во фрагменте адреса — так его снимает
  // системная камера телефона, минуя сканер внутри приложения. Фрагмент сразу
  // стираем: иначе экран впуска открывался бы заново на каждой перезагрузке,
  // а код к тому времени давно мёртв.
  useEffect(() => {
    const code = readPairCode(window.location.hash);
    if (!code) return;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    usePairingStore.getState().admit(code);
  }, []);

  // Тем же путём приезжает ключ владельца — тот, что напечатал установщик. Здесь
  // стереть фрагмент важнее вдвойне: ключ одноразовый и настоящий секрет, а
  // адресная строка — самое видное место в браузере.
  useEffect(() => {
    const token = readOwnerToken(window.location.hash);
    if (!token) return;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    useOwnerStore.getState().claim(token);
  }, []);

  // Владелец ли — спрашиваем один раз на вход. Ответ нужен не одному экрану:
  // по нему карточка личности рисует значок, а лента — бан на всю инсталляцию.
  useEffect(() => {
    void useOwnerStore.getState().refresh();
  }, []);

  // Состав есть только в канале; если вкладка «Состав» осталась активной после
  // ухода в лобби — показываем сцену вместо пустого экрана.
  const hasPeople = view === 'voice' || view === 'text';
  const effective: MobilePanel = panel === 'people' && !hasPeople ? 'stage' : panel;

  // Ширину колонка состава меняет не вместе с кликом, а когда сцена догасла:
  // `view` — это то, что НА ЭКРАНЕ (см. pendingScene). Место она забирает у
  // сцены, и раньше это происходило под ЕЩЁ ВИДИМЫМ лобби: карточка состояния
  // сервера на глазах съезжала к центру нового, узкого места, а на неширокoм
  // окне ещё и ужималась — за мгновение до того, как исчезнуть вовсе. Само
  // содержимое колонки при этом решает за себя: лишние доли секунды оно
  // обрезано нулевой шириной, а не показано впустую.
  const roomForPeople = view === 'voice' || view === 'text';

  // На десктопе видны все колонки разом — там анимации смены панели быть не должно.
  const shown = (which: MobilePanel) => (mobile ? (effective === which ? 'in' : 'out') : 'in');

  return (
    // `relative` — рамка отсчёта для панели ЛС: она встаёт по правому краю
    // ЭКРАНА, за рейкой тулбара, а не внутри ряда колонок (см. DmDrawer).
    <div className="relative flex h-[100dvh] flex-col overflow-hidden md:flex-row">
      <MobileNav />

      {/* Обёртка панелей: ряд на мобиле (одна видимая панель), contents на десктопе */}
      <div className="flex min-h-0 flex-1 md:contents">
        {/* Навигация: рейка серверов + тулбар ЛС/звонков + сайдбар */}
        <Panel
          className={cn('shrink-0 max-md:w-full', effective !== 'nav' && 'max-md:hidden')}
          state={shown('nav')}
        >
          <ServerRail />
          {/* `md:flex-row` обязателен и при одном ребёнке: сайдбар тянется в
              полную высоту не сам по себе, а поперечной осью этой обёртки. В
              колонку она вытягивает по ширине, а по высоте отдаёт содержимому —
              и карточка своей личности отлипает от низа экрана, повисая сразу
              под последним каналом.

              Полосы тулбара здесь больше нет: на телефоне она стоит ВНУТРИ
              сайдбара, под именем сервера (кадр `2a` референса), и потому не
              появляется над списком переписок, к которому отношения не имеет. */}
          <div className="flex min-w-0 flex-1 flex-col md:flex-row">
            {mobile && dmSection ? <DmList /> : <Sidebar />}
          </div>
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
          className={cn(
            'shrink-0 overflow-hidden max-md:w-full',
            roomForPeople ? 'md:w-[232px]' : 'md:w-0',
            effective !== 'people' && 'max-md:hidden',
          )}
          state={shown('people')}
        >
          <Members />
          <OnlineMembers />
        </Panel>

        {/* Тулбар ЛС/звонков/админки — крайняя правая рейка, за колонкой
            состава (вариант размещения `1a` из референса). Стоит последним и
            в разметке: рейка держится правого края экрана, а не уезжает вместе
            с колонкой состава, которая на лобби схлопывается в ноль ширины.
            На мобиле его здесь нет — там он полоса над списком каналов выше. */}
        {!mobile && <Toolbar />}
      </div>

      {/* Панель ЛС — поверх колонки состава, у правого края экрана. Вне обёртки
          панелей: на десктопе та превращается в `display:contents` и рамкой
          отсчёта для `absolute` быть не может. */}
      {!mobile && <DmDrawer />}

      {/* Выбор собеседника — здесь, а не внутри списка переписок: список ездит
          вместе с панелью (transform), и палитра внутри него ездила бы следом,
          вопреки своему `position: fixed`. */}
      <PeoplePicker open={pickerOpen} onOpenChange={setPickerOpen} />

      {/* Одно на приложение: зовут его и из панели устройств, и из ссылки. */}
      <AdmitDeviceDialog />
      <OwnerClaimDialog />
      <BannedGate />
      <OutdatedGate />
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

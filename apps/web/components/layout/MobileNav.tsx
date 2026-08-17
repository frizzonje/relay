'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { navTitle, springLayout } from '@/lib/motion';
import { Icon } from '@/components/ui/icon';
import { AnimatedCount } from '@/components/ui/AnimatedCount';
import { avatarStyle } from '@/lib/avatar';
import { useUiStore, type MobilePanel } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';
import { useChatStore } from '@/stores/chat';
import { useSearchStore } from '@/stores/search';
import { toggleMic, leaveVoice, showVoiceStage } from '@/lib/voice';
import { useT } from '@/lib/i18n';

/** Порядок экранов стопки: по нему считаем направление хода для анимации. */
const DEPTH: Record<MobilePanel, number> = { nav: 0, stage: 1, people: 2 };

/**
 * Стек аватарок справа в шапке — кто сейчас в канале. Тап открывает «Состав»
 * (как тап по шапке чата в мессенджерах открывает карточку собеседников).
 */
function PeopleButton({
  names,
  onClick,
  label,
}: {
  names: string[];
  onClick: () => void;
  label: string;
}) {
  const shown = names.slice(0, 3);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-bg-active/70 py-1 pl-1 pr-2.5 text-text-muted outline-none transition-colors active:bg-bg-active"
    >
      {shown.length > 0 ? (
        <span className="flex -space-x-2">
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((n) => (
              <motion.span
                key={n}
                layout
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={springLayout}
                className="h-6 w-6 rounded-full bg-cover bg-center ring-2 ring-bg-sidebar"
                style={avatarStyle(n)}
              />
            ))}
          </AnimatePresence>
        </span>
      ) : (
        <span className="grid h-6 w-6 place-items-center">
          <Icon name="users" className="text-[18px]" strokeWidth={1.8} />
        </span>
      )}
      <span className="text-[13px] font-semibold tabular-nums text-text">
        <AnimatedCount value={names.length} />
      </span>
    </button>
  );
}

/**
 * Шапка мобильного веба (`md:hidden`) — стопка экранов, как в мессенджерах:
 * слева стрелка назад (состав → сцена → каналы), по центру имя открытого канала
 * с живым подзаголовком, справа состав канала аватарками.
 *
 * Раньше это был таб-бар внизу экрана. Внизу он мешал: клавиатура выталкивала
 * его прямо над строкой ввода, и печатать приходилось сквозь навигацию. Сверху
 * он не спорит ни с клавиатурой, ни с панелью звонка.
 *
 * На экране каналов шапки нет вовсе: у сайдбара своя (имя сервера), а вторая
 * строка над ней — пустая трата высоты.
 */
export function MobileNav() {
  const t = useT();
  const panel = useUiStore((s) => s.mobilePanel);
  const setPanel = useUiStore((s) => s.setMobilePanel);
  const view = useUiStore((s) => s.view);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const textLabel = useUiStore((s) => s.textLabel);
  const micOn = useVoiceStore((s) => s.micOn);
  const tiles = useVoiceStore((s) => s.tiles);
  const roster = useChatStore((s) => s.roster);
  const typing = useChatStore((s) => s.typing);

  // Состав осмыслен только в канале (голос/текст). В лобби вкладку прячем, а
  // если она была активной — считаем активной сцену (иначе пустой экран).
  const hasPeople = view === 'voice' || view === 'text';
  const effective: MobilePanel = panel === 'people' && !hasPeople ? 'stage' : panel;

  // Направление хода стопки: вперёд (+1) или назад по стрелке (−1).
  const depth = DEPTH[effective];
  const prevDepth = useRef(depth);
  const [dir, setDir] = useState(1);
  useEffect(() => {
    if (depth !== prevDepth.current) {
      setDir(depth > prevDepth.current ? 1 : -1);
      prevDepth.current = depth;
    }
  }, [depth]);

  // Мини-бар звонка не нужен, когда ты и так смотришь сетку звонка.
  const onCallStage = effective === 'stage' && view === 'voice';
  const showMiniCall = !!voiceRoom && !onCallStage;

  // На экране каналов шапку не рисуем — см. комментарий к компоненту.
  if (effective === 'nav') return null;

  const people = effective === 'people';
  const names = view === 'voice' ? tiles.map((tile) => tile.name) : roster;

  // Заголовок и подпись экрана. key — по нему AnimatePresence меняет заголовок.
  let key: string;
  let title: string;
  let icon: 'hash' | 'voice' | null = null;
  let sub = '';
  if (people) {
    key = 'people';
    title = t(view === 'voice' ? 'members.title.inChannel' : 'members.title.online');
  } else if (view === 'voice') {
    key = `voice:${voiceLabel}`;
    title = voiceLabel;
    icon = 'voice';
    sub = t('mobile.sub.inChannel', { count: tiles.length });
  } else if (view === 'text') {
    key = `text:${textLabel}`;
    title = textLabel;
    icon = 'hash';
    sub =
      typing.length > 0 ? t('mobile.sub.typing') : t('mobile.sub.online', { count: roster.length });
  } else {
    key = 'lobby';
    title = t('mobile.title.server');
  }

  return (
    <nav className="z-30 shrink-0 border-b border-line bg-bg-sidebar pt-[env(safe-area-inset-top)] shadow-[0_1px_2px_rgba(0,0,0,0.2)] md:hidden">
      <div className="flex h-[52px] items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setPanel(people ? 'stage' : 'nav')}
          aria-label={t('mobile.back')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors active:bg-bg-hover active:text-text-header"
        >
          <Icon name="chevron-left" className="text-[22px]" />
        </button>

        {/* Заголовок экрана: тап по нему открывает состав — как карточка чата */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <motion.button
              key={key}
              type="button"
              custom={dir}
              variants={navTitle}
              initial="hidden"
              animate="show"
              exit="exit"
              disabled={!hasPeople || people}
              onClick={() => setPanel('people')}
              className="block w-full min-w-0 px-1 text-left outline-none disabled:cursor-default"
            >
              <span className="flex items-center gap-1 text-[15px] font-bold leading-tight text-text-header">
                {icon === 'hash' && <span className="text-text-faint">#</span>}
                {icon === 'voice' && (
                  <Icon name="volume-2" className="shrink-0 text-[16px] text-text-muted" />
                )}
                <span className="truncate">{title}</span>
              </span>
              {sub && (
                <span
                  className={cn(
                    'block truncate text-[11.5px] leading-tight',
                    typing.length > 0 && view === 'text' ? 'text-accent-strong' : 'text-text-muted',
                  )}
                >
                  {sub}
                </span>
              )}
            </motion.button>
          </AnimatePresence>
        </div>

        {/* Поиск живёт в шапке канала — там же, где он на десктопе. На мобиле
            он откроется во весь экран: делить 375 точек между лентой и
            результатами не на что. */}
        {view === 'text' && !people && (
          <button
            type="button"
            onClick={() => useSearchStore.getState().setOpen(true)}
            aria-label={t('search.open')}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors active:bg-bg-hover active:text-text-header"
          >
            <Icon name="search" className="text-[19px]" />
          </button>
        )}

        {hasPeople && !people && (
          <PeopleButton
            names={names}
            label={t('mobile.people')}
            onClick={() => setPanel('people')}
          />
        )}
      </div>

      {/* Мини-бар активного звонка: виден, когда ты в голосе, но смотришь не на
          сетку звонка. Тап возвращает к ней, рядом быстрый mute и отбой. */}
      <AnimatePresence initial={false}>
        {showMiniCall && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 border-t border-black/30 bg-bg-deep/80 px-3 py-2">
              <button
                type="button"
                onClick={showVoiceStage}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title={t('mobile.backToCall')}
              >
                <span className="h-2 w-2 shrink-0 animate-pulse-dot rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold leading-tight text-ok">
                    {t('voice.panel.connected')}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-text-muted">
                    {voiceLabel}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={toggleMic}
                aria-label={t(micOn ? 'voice.mic.turnOff' : 'voice.mic.turnOn')}
                aria-pressed={!micOn}
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-bg-active text-text outline-none transition-colors active:scale-95',
                  !micOn && '!bg-accent-strong !text-bg-app',
                )}
              >
                <Icon name={micOn ? 'mic' : 'mic-off'} className="text-[18px]" />
              </button>
              <button
                type="button"
                onClick={() => leaveVoice()}
                aria-label={t('voice.leave')}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-danger text-white outline-none transition-[filter] active:brightness-110"
              >
                <Icon name="phone-off" className="text-[18px]" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}

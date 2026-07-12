'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { useUiStore, type MobilePanel } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';
import { toggleMic, leaveVoice, showVoiceStage } from '@/lib/voice';

/* Инлайновые line-иконки таб-бара (набор Icon — CSS-маски — не содержит hash/
   users/grid, поэтому рисуем сами, в общей стилистике GearIcon: stroke 1.8). */
function IconHash() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </svg>
  );
}
function IconStage() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </svg>
  );
}
function IconPeople() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
      <circle cx="9" cy="7" r="3" />
      <path d="M22 19v-1a4 4 0 0 0-3-3.87M16 4.13A4 4 0 0 1 16 12" />
    </svg>
  );
}

function Tab({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium outline-none transition-colors',
        active ? 'text-text-header' : 'text-text-muted',
      )}
    >
      {children}
      <span className="tracking-wide">{label}</span>
    </button>
  );
}

/**
 * Нижняя навигация мобильного веба (`md:hidden`). Сверху — мини-бар активного
 * звонка (виден, когда ты в голосе, но смотришь не на сцену звонка): тап
 * возвращает к сетке, рядом быстрый mute и отбой. Ниже — таб-бар переключения
 * панелей: Каналы / Сцена / Состав (последняя — только в канале). На десктопе
 * весь компонент скрыт: там колонки видны разом.
 */
export function MobileBar() {
  const panel = useUiStore((s) => s.mobilePanel);
  const setPanel = useUiStore((s) => s.setMobilePanel);
  const view = useUiStore((s) => s.view);
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const voiceLabel = useUiStore((s) => s.voiceLabel);
  const micOn = useVoiceStore((s) => s.micOn);

  // Состав осмыслен только в канале (голос/текст). В лобби вкладку прячем, а
  // если она была активной — считаем активной сцену (иначе пустой экран).
  const hasPeople = view === 'voice' || view === 'text';
  const effective: MobilePanel = panel === 'people' && !hasPeople ? 'stage' : panel;

  // Мини-бар не нужен, когда ты и так смотришь сетку звонка.
  const onCallStage = effective === 'stage' && view === 'voice';
  const showMiniCall = !!voiceRoom && !onCallStage;

  return (
    <nav className="z-30 shrink-0 border-t border-line bg-bg-sidebar md:hidden">
      {showMiniCall && (
        <div className="flex items-center gap-2 border-b border-black/30 bg-bg-deep/80 px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setPanel('stage');
              showVoiceStage();
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title="Вернуться к звонку"
          >
            <span className="h-2 w-2 shrink-0 animate-pulse-dot rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-bold leading-tight text-ok">
                Голос подключён
              </span>
              <span className="block truncate text-[11px] leading-tight text-text-muted">
                {voiceLabel}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={toggleMic}
            aria-label={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
            aria-pressed={!micOn}
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-bg-active text-text outline-none transition-colors',
              !micOn && '!bg-accent-strong !text-bg-app',
            )}
          >
            <Icon name={micOn ? 'mic' : 'mic-off'} className="text-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => leaveVoice()}
            aria-label="Отключиться"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-danger text-white outline-none transition-[filter] active:brightness-110"
          >
            <Icon name="phone-off" className="text-[18px]" />
          </button>
        </div>
      )}

      <div className="flex items-stretch pb-[env(safe-area-inset-bottom)]">
        <Tab active={effective === 'nav'} label="Каналы" onClick={() => setPanel('nav')}>
          <IconHash />
        </Tab>
        <Tab active={effective === 'stage'} label="Сцена" onClick={() => setPanel('stage')}>
          <IconStage />
        </Tab>
        {hasPeople && (
          <Tab active={effective === 'people'} label="Состав" onClick={() => setPanel('people')}>
            <IconPeople />
          </Tab>
        )}
      </div>
    </nav>
  );
}

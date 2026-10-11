'use client';

import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { usePinsStore } from '@/stores/pins';
import { useSearchStore } from '@/stores/search';
import { useT } from '@/lib/i18n';

/**
 * Действия открытой ленты — закреплённые и поиск. Одни и те же у канала и у
 * беседы, в шапке десктопа и телефона: раньше это были две копии, и на
 * телефоне беседа осталась без поиска, а закреплённые там только открывались,
 * но не закрывались той же кнопкой.
 */
export function FeedActions({ touch }: { touch?: boolean }) {
  const t = useT();
  const pins = usePinsStore((s) => s.count);
  const pinsOpen = usePinsStore((s) => s.open);
  // С пальца цель крупнее, и подсветка — на нажатии, а не на наведении.
  const hit = touch
    ? 'active:bg-bg-hover active:text-text-header'
    : 'hover:bg-bg-hover hover:text-text-header';

  return (
    <>
      {/* Закреплённых нет — нет и кнопки: пустой список за ней означал бы,
          что человек сходил проверить и ничего не нашёл. Тому, кто может
          закрепить, вход всё равно нужен из меню сообщения, а не отсюда. */}
      {pins > 0 && (
        <button
          type="button"
          onClick={() => usePinsStore.getState().setOpen(!pinsOpen)}
          aria-label={t('pins.open')}
          aria-pressed={pinsOpen}
          title={t('pins.count', { count: pins })}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full text-text-muted outline-none transition-colors',
            touch ? 'h-9 px-1.5' : 'h-8 px-2',
            hit,
            pinsOpen && 'bg-bg-active text-text-header',
          )}
        >
          <Icon name="pin" className={touch ? 'text-[18px]' : 'text-[17px]'} />
          <span className="text-[12px] font-semibold tabular-nums">{pins}</span>
        </button>
      )}
      {/* На телефоне поиск откроется во весь экран: делить 375 точек между
          лентой и результатами не на что. */}
      <button
        type="button"
        onClick={() => useSearchStore.getState().setOpen(true)}
        aria-label={t('search.open')}
        title={t('search.open.hint')}
        className={cn(
          'grid shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors',
          touch ? 'h-9 w-9' : 'h-8 w-8',
          hit,
        )}
      >
        <Icon name="search" className={touch ? 'text-[19px]' : 'text-[18px]'} />
      </button>
    </>
  );
}

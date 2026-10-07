'use client';

import type { ChatMessage } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { ChatDrawer, DrawerClose, MessageExcerpt } from '@/components/chat/ChatDrawer';
import { fmtDayTime } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useRetention } from '@/lib/use-sfu';
import { usePinsStore } from '@/stores/pins';

/**
 * Закреплённое канала.
 *
 * Живёт там же, где поиск, и выглядит так же — колонкой у правого края ленты, а
 * на мобиле во весь экран. Это не экономия на вёрстке: и то и другое отвечает на
 * один вопрос — «где это было», — и ведёт обратно в разговор. Два разных облика
 * у одного жеста человек читал бы как два разных места.
 *
 * Строка ведёт к самой реплике в ленте. Открепить может тот же, кто закрепил, —
 * модератор сервера; остальным кнопки не показываем вовсе, а не показываем
 * отказ.
 */

function Pin({
  msg,
  canUnpin,
  onOpen,
  onUnpin,
}: {
  msg: ChatMessage;
  canUnpin: boolean;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const t = useT();
  return (
    <div className="group/pin relative">
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-[10px] border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-bg-hover"
      >
        {/* Дата с временем, как в поиске: вырванная из ленты строка сама по
            себе не отвечает на «когда это было». */}
        <span className="text-[11px] text-text-muted">{fmtDayTime(msg.ts)}</span>
        <MessageExcerpt msg={msg} />
      </button>
      {canUnpin && (
        <button
          type="button"
          onClick={onUnpin}
          title={t('pins.action.unpin')}
          aria-label={t('pins.action.unpin')}
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-text-muted opacity-0 transition-colors hover:bg-bg-active hover:text-text-header focus:opacity-100 group-hover/pin:opacity-100"
        >
          <Icon name="pin-off" className="text-[13px]" />
        </button>
      )}
    </div>
  );
}

export function PinsPanel({
  moderated,
}: {
  /** Этот канал модерируешь ты — значит можешь и открепить. */
  moderated: boolean;
}) {
  const t = useT();
  const open = usePinsStore((s) => s.open);
  const list = usePinsStore((s) => s.list);
  const loading = usePinsStore((s) => s.loading);
  const asked = usePinsStore((s) => s.asked);
  const failed = usePinsStore((s) => s.failed);
  const { days: retentionDays } = useRetention();

  return (
    <ChatDrawer open={open} label={t('pins.title')}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="pin" className="shrink-0 text-[16px] text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text-header">
          {t('pins.title')}
        </span>
        <DrawerClose onClose={() => usePinsStore.getState().setOpen(false)} />
      </div>

      {/* Что именно обещает закрепление — сказано здесь, а не подразумевается.
              При выключенной ретенции обещать нечего: ничего и не исчезает. */}
      {retentionDays > 0 && (
        <p className="shrink-0 border-b border-line px-3 py-2 text-[11.5px] leading-[1.45] text-text-muted">
          {t('pins.kept', { count: retentionDays })}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* Четыре разных ответа: ещё спрашиваем, сервер не ответил, здесь
                ничего не закрепляли, вот закреплённое. Одно пустое место на все
                четыре — это молчание на четыре разных вопроса. */}
        {loading && !list.length ? (
          <p className="px-3 py-6 text-[13px] text-text-muted">{t('pins.loading')}</p>
        ) : failed ? (
          <p className="px-3 py-6 text-[13px] text-text-muted">{t('pins.failed')}</p>
        ) : asked && !list.length ? (
          <p className="px-3 py-6 text-[13px] leading-relaxed text-text-muted">
            {t(moderated ? 'pins.empty.can' : 'pins.empty')}
          </p>
        ) : (
          list.map((msg) => (
            <Pin
              key={msg.id ?? msg.ts}
              msg={msg}
              canUnpin={moderated}
              onOpen={() => msg.id && void usePinsStore.getState().openPin(msg.id)}
              onUnpin={() => msg.id && void usePinsStore.getState().toggle(msg.id, false)}
            />
          ))
        )}
      </div>
    </ChatDrawer>
  );
}

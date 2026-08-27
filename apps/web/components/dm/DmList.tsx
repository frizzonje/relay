'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { DmConversation } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { PeoplePicker } from '@/components/dm/PeoplePicker';
import { cn } from '@/lib/utils';
import { fmtClock, shortFingerprint } from '@/lib/format';
import { listItem, springLayout } from '@/lib/motion';
import { useT } from '@/lib/i18n';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';
import { sceneTarget, useUiStore } from '@/stores/ui';

/**
 * Непрочитанное строки: сверяем `activity` беседы (useDmStore) с отметкой
 * чтения (useUnreadStore) — тем же способом, что `unreadIn` из stores/dm.ts,
 * только через подписку на оба стора, а не через разовое чтение `getState()`
 * — иначе строка не перерисовалась бы ни на входящую реплику, ни на отметку
 * чтения. Открытая беседа не считается непрочитанной: точка гаснет сразу, не
 * дожидаясь, пока `DmThread` (задача 11) отметит её прочитанной на сервере.
 */
function useRowUnread(slug: string, active: boolean): boolean {
  const activityTs = useDmStore((s) => s.activity[slug] ?? 0);
  const lastRead = useUnreadStore((s) => s.lastRead[slug] ?? 0);
  return !active && activityTs > lastRead;
}

function DmRow({
  conversation,
  active,
  onOpen,
}: {
  conversation: DmConversation;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const unread = useRowUnread(conversation.slug, active);
  const { peer } = conversation;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-2 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/70',
        !active && 'hover:bg-bg-hover',
        active && 'bg-bg-active',
      )}
    >
      <Identicon fingerprint={peer.fingerprint} size={34} className="shrink-0" />
      <div className="min-w-0 flex-1">
        {/* Ник один не годится — тёзки в реестре не редкость, и отпечаток тут
            не мелкий шрифт для эстетов, а единственное, чем два «Аня» различимы. */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[14px]',
              unread ? 'font-semibold text-text-header' : 'text-text',
            )}
          >
            {peer.nick}
          </span>
          <span className="shrink-0 truncate font-mono text-[10px] tracking-[0.06em] text-text-faint">
            {shortFingerprint(peer.fingerprint)}
          </span>
        </div>
        <div className="truncate text-[12.5px] text-text-muted">
          {conversation.preview
            ? conversation.previewMine
              ? t('dm.you', { preview: conversation.preview })
              : conversation.preview
            : ' '}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 flex-col items-end gap-1.5">
        {conversation.lastTs > 0 && (
          <span className="text-[11px] text-text-faint">{fmtClock(conversation.lastTs)}</span>
        )}
        {unread && (
          <span
            data-testid="dm-unread"
            aria-hidden
            className="h-2 w-2 rounded-full bg-accent-strong"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Раздел ЛС в сайдбаре: список переписок вместо реестра каналов (см.
 * `AppShell` — подмена решается там, по `dmSection`). Кнопка «+» в шапке
 * открывает выбор собеседника (`PeoplePicker`); клик по строке открывает саму
 * беседу — `useDmStore` её уже знает, второго запроса на сервер не нужно.
 */
export function DmList() {
  const t = useT();
  const conversations = useDmStore((s) => s.conversations);
  // По `sceneTarget`, а не по голому `dmRoom`: подсветка обязана прыгнуть на
  // строку сразу по клику, не дожидаясь, пока прежняя сцена догаснет (та же
  // причина, по которой Sidebar подсвечивает текстовый канал через `targetRoom`).
  const activeSlug = useUiStore((s) => sceneTarget(s).dmRoom);
  const openDm = useUiStore((s) => s.openDm);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <aside className="panel panel-sidebar relative flex w-[238px] shrink-0 flex-col border-r border-line max-md:grow">
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        <span className="truncate font-bold text-text-header">{t('dm.title')}</span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title={t('dm.new')}
          aria-label={t('dm.new')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-text-muted outline-none transition-colors hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Icon name="plus" className="text-[16px]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {conversations.length === 0 ? (
          <div className="mx-1 mt-2 rounded-[10px] border border-dashed border-line px-3 py-6 text-center">
            <p className="text-[13px] font-semibold text-text-header">{t('dm.empty.title')}</p>
            <p className="mt-1 text-[12.5px] leading-snug text-text-muted">{t('dm.empty.body')}</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {conversations.map((c) => (
              <motion.div
                key={c.slug}
                layout
                variants={listItem}
                initial="hidden"
                animate="show"
                exit="exit"
                transition={springLayout}
              >
                <DmRow
                  conversation={c}
                  active={activeSlug === c.slug}
                  onOpen={() => openDm(c.slug, c.peer.fingerprint, c.peer.nick)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      <PeoplePicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </aside>
  );
}

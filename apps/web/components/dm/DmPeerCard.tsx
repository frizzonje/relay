'use client';

import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';

/**
 * Правая колонка беседы (232px) — по месту и ширине ровно там, где у
 * голосового/текстового канала стоят `Members`/`OnlineMembers` (см. Stage:
 * этот компонент встаёт рядом с `DmThread`, а не в колонке состава каркаса —
 * у беседы нет ни ростера, ни списка «в сети», которым та колонка служит).
 *
 * Присутствия для беседы в этапе A нет: живой статус собеседника приедет
 * вместе со звонком 1:1 (план B, docs/plans/relay-2.0-calls.md). До тех пор
 * карточка честно говорит «неизвестно», а не подставляет чужое (голосовое)
 * присутствие или молчит о нём. Кнопка звонка нарисована, но выключена — тем
 * же приёмом, что Call/Admin в Toolbar (задача 8): без HTML `disabled`
 * кнопка осталась бы фокусируемой, а тултип и `aria-label` — единственное,
 * что объясняет, почему она ничего не делает.
 */
export function DmPeerCard() {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);

  // Беседа ещё не выбрана (переходный кадр смены сцены) — рисовать чужое
  // лицо или пустую карточку нечем.
  if (!peer) return null;

  const soon = t('dm.soon');
  const call = t('toolbar.call');

  return (
    <aside className="panel panel-sidebar flex w-[232px] shrink-0 flex-col items-center gap-3 overflow-hidden border-l border-line px-4 py-8 max-md:hidden">
      <Identicon fingerprint={peer} size={64} />
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="max-w-full truncate text-[15px] font-bold text-text-header">{nick}</span>
        <span className="font-mono text-[11px] tracking-[0.06em] text-text-faint">
          {shortFingerprint(peer)}
        </span>
        <span className="text-[12px] text-text-muted">{t('dm.header.status.unknown')}</span>
      </div>
      <button
        type="button"
        aria-disabled
        disabled
        title={soon}
        aria-label={`${call} — ${soon}`}
        className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-line px-3 py-2 text-[13px] font-medium text-text-faint"
      >
        <Icon name="phone" className="text-[15px]" strokeWidth={1.8} />
        {call}
      </button>
    </aside>
  );
}

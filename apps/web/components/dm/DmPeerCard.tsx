'use client';

import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Identicon } from '@/components/ui/Identicon';
import { shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';
import { useSetting } from '@/stores/config';

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
 * же приёмом, что Call/Admin в Toolbar (задача 8): HTML `disabled` ей НЕ
 * ставится. Этот атрибут заодно выбрасывает кнопку из обхода табом и глушит
 * наведение мышью, а тултип и `aria-label` — единственное, что объясняет, почему
 * она ничего не делает; с `disabled` объяснение стало бы недоступно ни мышью,
 * ни с клавиатуры. Отсюда `aria-disabled` вместо него и кольцо фокуса на месте.
 */
export function DmPeerCard() {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);
  const dmSection = useUiStore((s) => s.dmSection);
  const showFingerprints = useSetting<boolean>('people.showFingerprints');

  // Беседа ещё не выбрана (переходный кадр смены сцены) — рисовать чужое
  // лицо или пустую карточку нечем.
  if (!peer) return null;

  const soon = t('dm.soon');
  const call = t('toolbar.call');

  return (
    <aside
      className={cn(
        'panel panel-sidebar flex w-[232px] shrink-0 flex-col items-center gap-3 overflow-hidden border-l border-line px-4 py-8 max-md:hidden',
        // Та же уступка, что у колонки состава в каркасе (см. AppShell): пока
        // раскрыт док ЛС, на узком десктопе карточке места нет — она несжимаема
        // и просто выдавила бы ленту беседы в ноль, вылезши на соседа. Личность
        // собеседника при этом с экрана не пропадает: лицо, ник, отпечаток и
        // статус стоят в шапке ленты (см. DmThread).
        dmSection && 'max-lg:hidden',
      )}
    >
      {/* Самое крупное лицо на экране — и оно не дышит. Дрейф пересчитывает
          размытие каждый кадр (см. lib/identicon.ts), а здесь рядом и так
          написано словами, в сети человек или нет: движение тут ничего не
          добавляет, кроме счёта. */}
      <Identicon fingerprint={peer} size={64} />
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="max-w-full truncate text-[15px] font-bold text-text-header">{nick}</span>
        {showFingerprints && (
          <span className="font-mono text-[11px] tracking-[0.06em] text-text-faint">
            {shortFingerprint(peer)}
          </span>
        )}
        <span className="text-[12px] text-text-muted">{t('dm.header.status.unknown')}</span>
      </div>
      <button
        type="button"
        aria-disabled
        title={soon}
        aria-label={`${call} — ${soon}`}
        className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-full border border-line px-3 py-2 text-[13px] font-medium text-text-faint outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      >
        <Icon name="phone" className="text-[15px]" strokeWidth={1.8} />
        {call}
      </button>
    </aside>
  );
}

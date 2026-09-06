'use client';

import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Identicon } from '@/components/ui/Identicon';
import { PresenceDot } from '@/components/ui/PresenceDot';
import { shortFingerprint } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';
import { PRESENCE_LABEL_KEY, usePresence } from '@/stores/presence';
import { useSetting } from '@/stores/config';
import { useCallGate, useCallVideoAllowed, useRingStore } from '@/stores/ring';

/**
 * Правая колонка беседы (232px) — по месту и ширине ровно там, где у
 * голосового/текстового канала стоят `Members`/`OnlineMembers` (см. Stage:
 * этот компонент встаёт рядом с `DmThread`, а не в колонке состава каркаса —
 * у беседы нет ни ростера, ни списка «в сети», которым та колонка служит).
 *
 * Присутствие («в сети / в голосе / недавно») — из глобального
 * `stores/presence.ts` (задача 2 плана B), тот же стор, что и точка в шапке
 * беседы (см. DmThread) и в списке переписок (см. DmList).
 *
 * Кнопка звонка теперь живая (задача 6 плана B: раньше она была нарисована,
 * но выключена насовсем — «скоро»). Выключить её всё ещё может инсталляция:
 * `useCallGate` (stores/ring.ts) гасит её при `calls.enabled: false` или
 * `calls.whoCanCall: 'nobody'`, и тем же приёмом, что раньше был здесь и
 * остался в Toolbar/MobileNav — HTML `disabled` кнопке НЕ ставится. Этот
 * атрибут заодно выбрасывает кнопку из обхода табом и глушит наведение
 * мышью, а тултип и `aria-label` — единственное, что объясняет, почему она
 * ничего не делает; с `disabled` объяснение стало бы недоступно ни мышью, ни
 * с клавиатуры. Отсюда `aria-disabled` вместо него и кольцо фокуса на месте.
 * `calls.whoCanCall: 'conversation'` здесь не проверяется отдельно: карточка
 * стоит внутри уже открытой переписки, и условие «есть беседа» этим самим
 * фактом уже выполнено (см. комментарий у `useCallGate`).
 *
 * Видеозвонок — вторая, узкая кнопка рядом, и только когда инсталляция его
 * пускает (`calls.videoAllowed`, тот же `useCallVideoAllowed`): предлагать
 * камеру, которую сервер всё равно снимет с вызова, значило бы обещать не то,
 * что случится.
 */
export function DmPeerCard() {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);
  const dmSection = useUiStore((s) => s.dmSection);
  const showFingerprints = useSetting<boolean>('people.showFingerprints');
  // Хук вызывается безусловно (правило хуков), даже когда peer ещё пуст —
  // usePresence('') просто читает несуществующую запись и вернёт `offline`.
  const presence = usePresence(peer ?? '');
  const gate = useCallGate();
  const videoAllowed = useCallVideoAllowed();

  // Беседа ещё не выбрана (переходный кадр смены сцены) — рисовать чужое
  // лицо или пустую карточку нечем.
  if (!peer) return null;

  const call = t('toolbar.call');
  const reason = !gate.allowed ? t(gate.reasonKey) : '';

  function dial(video: boolean) {
    if (!gate.allowed || !peer) return;
    void useRingStore.getState().start({ fingerprint: peer, nick }, video);
  }

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
      <div className="relative h-16 w-16">
        <Identicon fingerprint={peer} size={64} />
        <PresenceDot
          state={presence}
          size={16}
          className="absolute -bottom-0.5 -right-0.5 ring-[3px] ring-bg-sidebar"
        />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="max-w-full truncate text-[15px] font-bold text-text-header">{nick}</span>
        {showFingerprints && (
          <span className="font-mono text-[11px] tracking-[0.06em] text-text-faint">
            {shortFingerprint(peer)}
          </span>
        )}
        <span className="text-[12px] text-text-muted">{t(PRESENCE_LABEL_KEY[presence])}</span>
      </div>
      <div className="mt-2 flex w-full items-center gap-2">
        <button
          type="button"
          aria-disabled={gate.allowed ? undefined : true}
          title={gate.allowed ? undefined : reason}
          aria-label={gate.allowed ? call : `${call} — ${reason}`}
          onClick={gate.allowed ? () => dial(false) : undefined}
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-full border border-line px-3 py-2 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
            gate.allowed ? 'text-ok hover:bg-ok/10' : 'cursor-not-allowed text-text-faint',
          )}
        >
          <Icon name="phone" className="text-[15px]" strokeWidth={1.8} />
          {call}
        </button>
        {gate.allowed && videoAllowed && (
          <button
            type="button"
            onClick={() => dial(true)}
            title={t('call.videoCall')}
            aria-label={t('call.videoCall')}
            className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-line text-ok outline-none transition-colors hover:bg-ok/10 focus-visible:ring-2 focus-visible:ring-line-strong"
          >
            <Icon name="video" className="text-[15px]" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </aside>
  );
}

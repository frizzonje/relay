'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { cn } from '@/lib/utils';
import { inShell } from '@/lib/shell-bridge';
import { useT } from '@/lib/i18n';
import { outgoingCaption, outgoingLive, useRingStore } from '@/stores/ring';

/**
 * Экран исходящего вызова (задача 6 плана B, «Дозвон», экран 4 референса).
 *
 * Растянут на весь экран — не тост и не баннер: это НЕ противоречит
 * ограничению «входящий не модалка» (docs/plans/relay-2.0.md), потому что оно
 * про ВХОДЯЩИЙ (его можно проигнорировать и продолжать пользоваться
 * интерфейсом, см. `IncomingToast`, задача 7). Исходящий — другое: это сам
 * набор номера, начатый нажатием кнопки, и весь смысл экрана — показать, чем
 * он кончится.
 *
 * Мировоззрение стора описано в `stores/ring.ts` — здесь только показ.
 * `outgoingCaption`/`outgoingLive` читают ОДНУ таблицу состояние → подпись →
 * цвет: экран не решает сам, как назвать «занято» или когда погасить кольца.
 *
 * Цвет — по глобальному правилу плана: зелёного и красного тут нет ни разу,
 * кроме нижней кнопки (danger — она про «отбой»/«закрыть»); «дозваниваемся»,
 * «занято» и «не в сети» — не «дозвон возможен» и не «отбой/отклонён/
 * пропущен», а нейтральные состояния, и красить их этими двумя было бы
 * решить за план то, чего он не решал.
 */
export function OutgoingCall() {
  const t = useT();
  const outgoing = useRingStore((s) => s.outgoing);
  const hangUp = useRingStore((s) => s.hangUp);
  const writeInstead = useRingStore((s) => s.writeInstead);
  const hangUpRef = useRef<HTMLButtonElement>(null);
  const open = outgoing !== null;

  /**
   * Фокус переезжает в оверлей сам — на кнопку отбоя.
   *
   * Без этого экран лгал бы дважды. Во-первых, Escape: React разносит события
   * по дереву КОМПОНЕНТОВ от того, на ком они случились, а случаются они на
   * том, что в фокусе, — а в фокусе осталась кнопка «позвонить» из карточки
   * собеседника, стоящая ПОД экраном. Обработчик на диалоге не сработал бы ни
   * разу (в тесте — сработал бы, если событие отправить прямо в диалог: см.
   * `OutgoingCall.test.tsx`, там оно нарочно шлётся тому, кто в фокусе).
   * Во-вторых, `aria-modal`: экран во весь экран, а человек с клавиатурой или
   * читалкой продолжал бы табать по интерфейсу за ним.
   *
   * Уходя, фокус возвращаем туда, откуда взяли: экран гаснет и по своей
   * кнопке, и сам (ответили, отклонили) — и фокус, брошенный в `body`, стоил
   * бы человеку места в интерфейсе.
   */
  useEffect(() => {
    if (!open) return;
    const from = document.activeElement as HTMLElement | null;
    hangUpRef.current?.focus();
    return () => from?.focus?.();
  }, [open]);

  if (!outgoing) return null;

  const caption = outgoingCaption(outgoing);
  const live = outgoingLive(outgoing);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('call.outgoing.title', { nick: outgoing.peer.nick })}
      onKeyDown={(e) => {
        // Тот же путь, что у кнопки «отбой»/«закрыть» — один обработчик,
        // одна проверка «жив ли ещё вызов» (см. `stores/ring.ts` про то, почему
        // `hangUp` безопасен на уже кончившемся экране).
        if (e.key === 'Escape') hangUp();
      }}
      className="fixed inset-0 z-[70] flex flex-col items-center justify-between bg-bg-app/97 px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-center backdrop-blur-sm"
    >
      <div />

      <div className="flex flex-col items-center gap-5">
        <div className="relative grid h-[104px] w-[104px] shrink-0 place-items-center">
          {/* Расходящиеся кольца — только пока вызов реально жив: погасший
              пульс сам по себе уже говорит «тут больше ничего не происходит»,
              раньше, чем человек дочитает подпись. */}
          {live && (
            <>
              <span className="absolute inset-0 animate-ping rounded-full border border-text-muted/50 [animation-duration:1.8s]" />
              <span className="absolute inset-0 animate-ping rounded-full border border-text-muted/40 [animation-delay:0.6s] [animation-duration:1.8s]" />
            </>
          )}
          <Identicon fingerprint={outgoing.peer.fingerprint} size={104} />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <span className="max-w-[280px] truncate text-[20px] font-bold text-text-header">
            {outgoing.peer.nick}
          </span>
          <span className={cn('text-[15px] font-medium', caption.color)}>{t(caption.key)}</span>
        </div>
      </div>

      <div className="flex w-full max-w-[360px] flex-col items-center gap-6">
        {/* Честное ограничение (глобальное ограничение плана 2.0): сказано
            здесь, на экране исходящего, а не только в документации. Экран
            один на обе раскладки — на телефоне это та же строка на том же
            месте, а не десктопная роскошь. */}
        <div className="flex flex-col items-center gap-2">
          <p className="text-[12px] leading-relaxed text-text-faint">{t('call.delivery')}</p>

          {/* Вторая строка — про ЭТО устройство (задача 9). Первая говорит про
            собеседника, а на мобильном вебе ровно то же верно и про тебя
            самого: пушей нет, и входящий не придёт, пока страница закрыта или
            в фоне. Узнавать это опытом — двумя пропущенными звонками — плохой
            способ, поэтому сказано словами, там же и сразу.

            `md:hidden` — тот же способ делить мобилку и десктоп, что и во всём
            остальном каркасе (см. MobileNav, DmPeerCard), без второго
            источника истины о ширине экрана.

            В нативной оболочке строки нет намеренно: там входящий как раз
            доходит — окно поднимается, окошко показывается (см. `notifyCall`
            и `shellRingStart`), — и та же строка была бы просто неправдой. */}
          {!inShell() && (
            <p className="text-[12px] leading-relaxed text-text-faint md:hidden">
              {t('call.delivery.mobile')}
            </p>
          )}
        </div>

        <div className="flex w-full items-center justify-center gap-6">
          {/* `min-h-[44px]` — не запас, а нижняя граница цели из референса
              (reference/direct-messages/README.md: «Все цели ≥44px»): одни
              отступы давали ~40px, и на телефоне эта кнопка промахивалась бы
              там, где соседние 68px и 104px попадают. */}
          <button
            type="button"
            onClick={writeInstead}
            className="flex min-h-[44px] items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-medium text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header focus-visible:ring-2 focus-visible:ring-line-strong"
          >
            <Icon name="message-square" className="text-[15px]" strokeWidth={1.8} />
            {t('call.writeInstead')}
          </button>

          {/* 68px — в зоне большого пальца на мобиле (мобильные кадры `2f`
              референса); на десктопе, где кнопку берут мышью, не нужно так
              много места — 56px. */}
          <button
            ref={hangUpRef}
            type="button"
            onClick={hangUp}
            aria-label={live ? t('call.hangUp') : t('common.close')}
            className="grid h-[68px] w-[68px] shrink-0 place-items-center rounded-full bg-danger text-white outline-none transition-[filter] focus-visible:ring-2 focus-visible:ring-line-strong active:brightness-110 md:h-14 md:w-14"
          >
            <Icon
              name={live ? 'phone-off' : 'x'}
              className="text-[26px] md:text-[22px]"
              strokeWidth={1.8}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

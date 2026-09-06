'use client';

import { useEffect } from 'react';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { getSfx } from '@/lib/sfx';
import { notifyCall } from '@/lib/notify';
import { useT } from '@/lib/i18n';
import { useRingStore } from '@/stores/ring';

/**
 * Тост входящего вызова (задача 7 плана B, экран 5 референса / кадр `2g`
 * мобилки). Угол экрана — НЕ модалка, и это не формулировка стиля, а
 * буквальный текст глобального ограничения плана 2.0: «вызов должно быть
 * можно проигнорировать и продолжать пользоваться интерфейсом». Отсюда три
 * вещи, которых в этом файле нет НИ ОДНОЙ:
 *
 *  - `role="dialog"` / `aria-modal` — они здесь были бы ложью: ничего не
 *    заблокировано, и всё, что под тостом, остаётся кликабельным (проверяет
 *    `IncomingToast.test.tsx`, кликом по кнопке, лежащей ПОД тостом на
 *    экране, а не отсутствием класса оверлея);
 *  - фокус, забираемый программно. `OutgoingCall` фокус ЗАБИРАЕТ — там это
 *    оправданно (весь экран его, Escape обязан работать), здесь — нет:
 *    входящий вправе прозвонить, пока человек как ни в чём не бывало печатает
 *    в открытой переписке, и выдёргивать курсор из поля вводом тоста
 *    означало бы устроить ту самую модалку, от которой план прямо
 *    отказывается;
 *  - таймер, который сам всё закрывает. Тост живёт, пока стор говорит, что
 *    вызов жив (`incoming` в `stores/ring.ts`), — от `call-incoming` до
 *    ЛЮБОГО исхода (принят, отклонён, отбой звонящего, не ответили, обрыв
 *    сокета), а не отведённые секунды библиотеки тостов.
 *
 * Разметка на десктопе — карточка в правом нижнем углу; на мобиле —
 * баннер под шапкой (кадр `2g`), а не фуллскрин-захват. «Принять» и
 * «отклонить» — 48px в обоих случаях: бриф задачи 7 требует ≥44px
 * КАТЕГОРИЧЕСКИ, и это сильнее самого референса (там кружки 40–46px).
 *
 * Видео названо ДО ответа: `incoming.video` рисуется бейджем рядом с
 * «звонит вам» — протокол зажимает его настройкой `calls.videoAllowed` ещё на
 * сервере (§4.2), но кнопка «принять», включающая камеру молча, была бы
 * враньём независимо от того, кто именно решил, что видео разрешено.
 *
 * Звук и системное уведомление живут РОВНО столько же, сколько сам тост —
 * не по отдельному сигналу на каждый из пяти путей закрытия, а по факту
 * размонтирования: стор гасит `incoming` на любом из них одинаково (см.
 * `applyState`/`applyEnded`/`lost`/`acceptIncoming`/`declineIncoming` в
 * `stores/ring.ts`), и эффект ниже реагирует не на ПРИЧИНУ, а на ФАКТ.
 * Ключ эффекта — сам объект `incoming`: он меняется ровно тогда же, когда
 * тост должен появиться или исчезнуть, и не меняется, пока вызов тот же.
 */
export function IncomingToast() {
  const t = useT();
  const incoming = useRingStore((s) => s.incoming);
  const acceptIncoming = useRingStore((s) => s.acceptIncoming);
  const declineIncoming = useRingStore((s) => s.declineIncoming);

  useEffect(() => {
    if (!incoming) return;
    getSfx().play('ring');
    const notification = notifyCall(incoming.from, incoming.video);
    return () => {
      getSfx().stop('ring');
      notification.close();
    };
  }, [incoming]);

  if (!incoming) return null;

  return (
    <div
      // `status`/`aria-live` — объявить читалке, что что-то появилось, не
      // требуя ответа немедленно и не перехватывая фокус: ровно то поведение,
      // которого просит план («можно проигнорировать»).
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 top-[calc(52px+env(safe-area-inset-top))] z-40 flex items-center gap-3.5 rounded-[15px] border border-line bg-bg-elev p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)] md:inset-x-auto md:top-auto md:bottom-6 md:right-6 md:w-[322px]"
    >
      <span className="relative grid h-[52px] w-[52px] shrink-0 place-items-center">
        {/* Кольцо — тот же приём, что у `OutgoingCall`: пульс сам по себе
            говорит «сейчас звонит», раньше, чем прочитана подпись. */}
        <span className="absolute inset-0 animate-ping rounded-full border border-ok/60 [animation-duration:1.8s]" />
        <Identicon fingerprint={incoming.from.fingerprint} size={52} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-bold text-text-header">
          {incoming.from.nick}
        </span>
        <span className="text-[11px] font-medium text-text-muted">
          {t('call.incoming.ringing')}
        </span>
        {incoming.video && (
          <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-text-faint">
            <Icon name="video" className="text-[12px]" strokeWidth={2} />
            {t('call.videoCall')}
          </span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-2">
        {/* Красный — только «отбой/отклонён/пропущен» (глобальное правило
            цвета плана 2.0): здесь он на кнопке ОТКЛОНЕНИЯ, а не украшением. */}
        <button
          type="button"
          onClick={declineIncoming}
          aria-label={t('call.incoming.decline')}
          className="grid h-12 w-12 place-items-center rounded-full bg-danger/16 text-danger outline-none transition-colors hover:bg-danger/28 focus-visible:ring-2 focus-visible:ring-line-strong active:brightness-110"
        >
          <Icon name="phone-off" className="text-[20px]" strokeWidth={1.8} />
        </button>
        {/* Зелёный — только «дозвон возможен/принять/в сети»: здесь это ровно
            кнопка «принять», и больше в тосте зелёного нет нигде. */}
        <button
          type="button"
          onClick={acceptIncoming}
          aria-label={t('call.incoming.accept')}
          className="grid h-12 w-12 place-items-center rounded-full bg-ok text-white outline-none transition-[filter] focus-visible:ring-2 focus-visible:ring-line-strong active:brightness-110"
        >
          <Icon name="phone" className="text-[20px]" strokeWidth={1.8} />
        </button>
      </span>
    </div>
  );
}

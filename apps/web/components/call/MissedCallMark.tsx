'use client';

import type { CallMark } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { fmtClock } from '@/lib/format';
import { useT, type MessageKey } from '@/lib/i18n';
import { useCallGate, useRingStore } from '@/stores/ring';
import { useUiStore } from '@/stores/ui';

/**
 * Отметка о пропущенном звонке в переписке (задача 8 плана B, экран 3
 * референса).
 *
 * Плашка, а не пузырь, и это не вкусовщина: пропущенный звонок — не то, что
 * кто-то сказал, и выглядеть как сказанное он не должен. Отсюда пунктир вместо
 * фона реплики, отсутствие лица и подписи автора и красный `danger` — по
 * правилу цвета плана 2.0 (`ok` = дозвон возможен, `danger` = отбой, отклонён,
 * пропущен; декоративного этими цветами не красим ничего).
 *
 * Строку собирает клиент, а не сервер: в ленту отметка приезжает структурой
 * (`ChatMessage.call` — почему пропущен и сколько звонило), потому что язык
 * читающего серверу неизвестен, а «21:04 · 38 секунд дозвона» из готовой фразы
 * обратно не разобрать. Время берётся из `ts` самой реплики — того же числа, по
 * которому она стоит в ленте: второе время разъехалось бы с её местом в
 * разговоре.
 *
 * «Перезвонить» ведёт ровно туда же, куда кнопка звонка в шапке беседы, — в
 * `useRingStore.start()` (задача 6), а не во второй emit мимо стора: два пути к
 * одному звонку однажды разошлись бы, и один из них перестал бы открывать
 * экран исходящего. Кому звонить, спрашивается у самой беседы (`dmPeer`), а не
 * у отметки: отметка одна на двоих, и звонит по ней каждый ВТОРОЙ стороне —
 * пропустивший звонившему, звонивший тому, кто не ответил.
 */
export function MissedCallMark({ call, ts, byMe }: { call: CallMark; ts: number; byMe: boolean }) {
  const t = useT();
  const peer = useUiStore((s) => s.dmPeer);
  const nick = useUiStore((s) => s.textLabel);
  // Тот же источник правды, что у кнопки в шапке беседы и в карточке
  // собеседника: развести проверку «можно ли звонить» по местам значило бы
  // однажды оставить здесь живую кнопку, которая всегда получает `forbidden`.
  const gate = useCallGate();
  // Секунды, а не миллисекунды: «38 с дозвона» — это про то, сколько человек
  // ждал у гудка, и точность до миллисекунды здесь была бы шумом.
  const seconds = Math.max(0, Math.round(call.ms / 1000));

  return (
    <div className="mx-4 my-1 flex items-center gap-3 rounded-[11px] border border-dashed border-danger/40 bg-danger/[0.05] px-3 py-2.5">
      <Icon name="phone-off" className="shrink-0 text-[16px] text-danger" strokeWidth={1.9} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px] font-medium text-danger">
          {t(byMe ? 'call.mark.outgoing' : 'call.mark.missed')} · {t(REASON[call.state])}
        </span>
        <span className="truncate font-mono text-[10.5px] text-text-faint">
          {fmtClock(ts)} · {t('call.mark.ringing', { count: seconds })}
        </span>
      </span>
      {/* Собеседника у отметки может не быть только вне беседы — а вне беседы
          отметок не бывает вовсе (пишутся они в переписку двоих). Проверка
          стоит потому, что `dmPeer` пуст в обычном канале, и звонить оттуда
          было бы некому. */}
      {peer && gate.allowed && (
        <button
          type="button"
          onClick={() => void useRingStore.getState().start({ fingerprint: peer, nick }, false)}
          className="shrink-0 rounded-md bg-white/[0.04] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-text-muted outline-none transition-colors hover:bg-white/[0.08] hover:text-text-header focus-visible:ring-2 focus-visible:ring-line-strong"
        >
          {t('call.mark.callBack')}
        </button>
      )}
    </div>
  );
}

/**
 * Почему звонок пропущен — своими словами на каждый исход.
 *
 * Исходов ровно два, и `Record` от них полон по построению: отметку оставляют
 * только «не ответили» и «не в сети» (см. `missed` в `@relay/shared`), а
 * «отклонён», «отбой», «занято» и «принят» её не оставляют вовсе. Появись
 * третий — здесь не соберётся, и это правильно: новую причину надо назвать
 * словом, а не показать пустотой.
 */
const REASON: Record<CallMark['state'], MessageKey> = {
  'no-answer': 'call.mark.noAnswer',
  failed: 'call.mark.offline',
};

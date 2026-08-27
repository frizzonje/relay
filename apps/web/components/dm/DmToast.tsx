'use client';

import { toast } from 'sonner';
import type { DmActivityRelay } from '@relay/shared';
import { Identicon } from '@/components/ui/Identicon';
import { Icon } from '@/components/ui/icon';
import { tx } from '@/lib/i18n';
import { useUiStore } from '@/stores/ui';

/**
 * Облачко о входящей реплике — угол экрана, а не модалка.
 *
 * Точка в списке говорит «где-то есть непрочитанное», и этого мало: чтобы
 * узнать, кто и о чём написал, приходилось раскрывать раздел и читать список.
 * Облачко отвечает на оба вопроса сразу — лицом, ником и первой строкой — и
 * уходит само, ничего не требуя. Клик открывает беседу.
 *
 * Показываем только то, что уже прислал сервер в `dm-activity` (см.
 * DmActivityRelay): превью там обрезано на сервере, и разворачивать его тут
 * нечем и незачем — облачко не лента.
 */

/** Сколько живёт облачко. Хватает прочитать две строки и не мешает дольше. */
const TOAST_MS = 6000;

export function showDmToast(relay: DmActivityRelay) {
  const nick = relay.peer.nick || tx('common.anonymous');

  toast.custom(
    (id) => (
      <button
        type="button"
        onClick={() => {
          toast.dismiss(id);
          useUiStore.getState().openDm(relay.slug, relay.peer.fingerprint, nick);
        }}
        // Кнопка, а не div с onClick: облачко — обычная цель для клавиатуры,
        // и таб должен на неё попадать, пока она на экране.
        // Сдвиг на ширину рейки тулбара: она стоит у правого края, и облачко
        // без него ложится прямо на неё (замерено: налезало на 13px). Именно
        // сдвиг, а не отступ: sonner держит тост в своей позиционированной
        // строке, и margin ему только ширину раздувает, не двигая с места.
        // На узком экране рейки справа нет — там тулбар полосой сверху.
        className="group flex w-[336px] max-w-[86vw] items-start gap-3 rounded-[14px] border border-line bg-bg-elev px-3 py-2.5 text-left shadow-[0_20px_60px_rgba(0,0,0,0.5)] outline-none transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-line-strong md:-translate-x-16"
      >
        <span className="mt-0.5 shrink-0">
          <Identicon fingerprint={relay.peer.fingerprint} size={34} />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-bold text-text-header">{nick}</span>
          {/* Две строки и обрыв: облачко показывает, о чём речь, а не всю реплику. */}
          <span className="line-clamp-2 text-[12.5px] leading-snug text-text-muted">
            {relay.preview}
          </span>
        </span>

        {/* Стрелка проявляется на наведении — знак, что облачко ведёт внутрь,
            а не просто сообщает. Без наведения она бы спорила с ником за глаз. */}
        <Icon
          name="chevron-right"
          className="mt-1 shrink-0 text-[16px] text-text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          strokeWidth={1.8}
        />
      </button>
    ),
    {
      duration: TOAST_MS,
      position: 'bottom-right',
      // Глобальный Toaster одевает каждый тост в `glass glass-3` (см.
      // app/providers.tsx). Облачко рисует свою карточку само, и чужой фон под
      // ней вылезал бы прямоугольником сбоку — тем заметнее, что карточка ещё
      // и сдвинута от края. Гасим ровно то, что рисует контейнер.
      className: 'border-0 bg-transparent shadow-none',
    },
  );
}

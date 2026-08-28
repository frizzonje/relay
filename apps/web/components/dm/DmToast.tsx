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
        // На десктопе облачко занимает ровно колонку состава: 232px в ширину
        // и правым краем вплотную к ней. Справа от состава остаётся одна рейка
        // тулбара (64px) — свёрнутый док ЛС не занимает ничего (см. DmDrawer).
        // sonner держит тост в 32px от края экрана, отсюда сдвиг на 64 − 32 =
        // 32; margin на его месте раздувал бы ширину, не двигая карточку. В
        // итоге границы облачка совпадают с границами колонки состава — оно
        // встроено в ту же сетку, а не висит в углу само по себе. Раскрытый док
        // съезжает под облачко: гнаться за уехавшей колонкой значило бы двигать
        // облачко на каждый чужой клик.
        // На узком экране рейки справа нет — там тулбар полосой сверху.
        className="group flex w-[336px] max-w-[86vw] items-start gap-2.5 rounded-[14px] border border-line bg-bg-elev px-3 py-2.5 text-left shadow-[0_20px_60px_rgba(0,0,0,0.5)] outline-none transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-line-strong md:w-[232px] md:-translate-x-8"
      >
        <span className="mt-0.5 shrink-0">
          <Identicon fingerprint={relay.peer.fingerprint} size={30} />
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
      // Прижать к ПРАВОМУ краю строки sonner. Своей ширины (356px) она не
      // отдаёт, а карточку кладёт absolute-left: узкое облачко висело бы у
      // левого края строки, то есть в 156 точках от края экрана, и никакой
      // сдвиг этого бы не исправил — он считается от того же левого края.
      // Так привязка остаётся к одному числу sonner (отступ 32px), а не к
      // двум, и ширину карточки можно менять, ничего больше не пересчитывая.
      style: { left: 'auto', right: 0 },
    },
  );
}

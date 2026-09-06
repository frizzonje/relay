'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { DmConversation } from '@relay/shared';
import { callMarkLabel } from '@/components/call/MissedCallMark';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { PresenceDot } from '@/components/ui/PresenceDot';
import { cn } from '@/lib/utils';
import { fmtListWhen, shortFingerprint } from '@/lib/format';
import { listItem, springLayout } from '@/lib/motion';
import { useT } from '@/lib/i18n';
import { useDmStore, useUnreadIn } from '@/stores/dm';
import { usePresence } from '@/stores/presence';
import { useSetting } from '@/stores/config';
import { sceneTarget, useUiStore } from '@/stores/ui';

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
  const unread = useUnreadIn(conversation.slug, active);
  const showFingerprints = useSetting<boolean>('people.showFingerprints');
  const { peer } = conversation;
  const presence = usePresence(peer.fingerprint);
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
      <div className="relative h-[34px] w-[34px] shrink-0">
        <Identicon fingerprint={peer.fingerprint} size={34} />
        <PresenceDot
          state={presence}
          size={11}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-sidebar"
        />
      </div>
      {/* Две строки с ясным делением: кто (ник и отпечаток) и что (превью,
          когда, непрочитано). Прежде время и метка стояли отдельным столбцом
          справа, забирая ширину у обоих рядов разом, — на 232 точках панели
          (см. DmDrawer) от имени оставалось «Ма…». */}
      <div className="min-w-0 flex-1">
        {/* Ник один не годится — тёзки в реестре не редкость, и отпечаток тут
            не мелкий шрифт для эстетов, а единственное, чем два «Аня» различимы. */}
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'truncate text-[14px]',
              unread ? 'font-semibold text-text-header' : 'text-text',
            )}
          >
            {peer.nick}
          </span>
          {showFingerprints && (
            <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-text-faint">
              {shortFingerprint(peer.fingerprint)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-muted">
            {/* Отметка о пропущенном звонке несёт в `preview` непереведённую
                серверную запаску (см. `ChatMessage.call` в протоколе) — само
                слово подбираем здесь, тем же путём, что и плашка в ленте
                (`MissedCallMark`), а не показываем чужой язык читающему. */}
            {conversation.call
              ? callMarkLabel(conversation.previewMine, t)
              : conversation.preview
                ? conversation.previewMine
                  ? t('dm.you', { preview: conversation.preview })
                  : conversation.preview
                : ' '}
          </span>
          {conversation.lastTs > 0 && (
            <span className="shrink-0 text-[11px] text-text-faint">
              {fmtListWhen(conversation.lastTs)}
            </span>
          )}
          {unread && (
            <span
              data-testid="dm-unread"
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-accent-strong"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Список переписок. Живёт в двух местах и своей ширины не назначает: на
 * десктопе его несёт выехавшая справа панель (`DmDrawer`), на телефоне — экран
 * вместо каналов (`AppShell`). Размер даёт носитель, список только заполняет
 * его целиком, — иначе одно и то же «238px» пришлось бы держать в трёх файлах.
 *
 * Кнопка «+» в шапке открывает выбор собеседника: сама палитра стоит в каркасе
 * (`peoplePickerOpen` в сторе), потому что панель ездит трансформацией и
 * прибила бы её к себе. Клик по строке открывает беседу — `useDmStore` её уже
 * знает, второго запроса на сервер не нужно.
 */
export function DmList() {
  const t = useT();
  const conversations = useDmStore((s) => s.conversations);
  // Три разных ответа на «почему тут пусто»: ещё спрашиваем, спросили и не
  // получили, получили и переписок правда нет. Раньше все три выглядели
  // одинаково — уверенным «переписок пока нет», то есть утверждением о чужих
  // данных, которого стор в двух случаях из трёх не знает.
  const loading = useDmStore((s) => s.loading);
  const failed = useDmStore((s) => s.failed);
  // По `sceneTarget`, а не по голому `dmRoom`: подсветка обязана прыгнуть на
  // строку сразу по клику, не дожидаясь, пока прежняя сцена догаснет (та же
  // причина, по которой Sidebar подсвечивает текстовый канал через `targetRoom`).
  const activeSlug = useUiStore((s) => sceneTarget(s).dmRoom);
  const openDm = useUiStore((s) => s.openDm);
  const toggleDmSection = useUiStore((s) => s.toggleDmSection);
  const setPickerOpen = useUiStore((s) => s.setPeoplePickerOpen);

  return (
    <aside className="panel panel-sidebar relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-1 border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] max-md:pl-1.5">
        {/* Шеврон назад — только на телефоне и только здесь: полоса тулбара, из
            которой сюда пришли, живёт внутри сайдбара (см. Sidebar) и на этом
            экране её нет вовсе. Без него выйти из раздела было бы нечем.
            `md:hidden` вместо useIsMobile: до гидрации хук отвечает «широкий»,
            и кнопка мигала бы появлением на первом кадре. */}
        <button
          type="button"
          onClick={() => useUiStore.getState().toggleDmSection()}
          aria-label={t('mobile.back')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors active:bg-bg-hover active:text-text-header md:hidden"
        >
          <Icon name="chevron-left" className="text-[22px]" />
        </button>
        <span className="mr-auto truncate font-bold text-text-header">{t('dm.title')}</span>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title={t('dm.new')}
          aria-label={t('dm.new')}
          // На телефоне цель вырастает до 44px — нижняя граница, ниже которой
          // палец начинает промахиваться (референс, кадр 2c). Значок остаётся
          // прежнего кегля: расти должна область нажатия, а не рисунок.
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-text-muted outline-none transition-colors hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent max-md:h-11 max-md:w-11 max-md:-mr-2.5"
        >
          <Icon name="plus" className="text-[16px]" />
        </button>
        {/* Свернуть панель — только на десктопе: там она выехала справа и
            уезжает обратно за рейку целиком, не оставляя на экране ничего
            (см. DmDrawer); вернуть её — той же кнопкой ЛС в рейке, откуда
            открывали. На телефоне тот же ход делает шеврон слева — там панель
            не ездит, а занимает экран целиком. */}
        <button
          type="button"
          onClick={toggleDmSection}
          title={t('dm.collapse')}
          aria-label={t('dm.collapse')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-text-muted outline-none transition-colors hover:text-text-header focus-visible:ring-2 focus-visible:ring-accent max-md:hidden"
        >
          <Icon name="chevron-right" className="text-[18px]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {conversations.length === 0 && loading ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-text-muted">
            {t('dm.list.loading')}
          </p>
        ) : conversations.length === 0 && failed ? (
          <div className="mx-1 mt-2 rounded-[10px] border border-dashed border-line px-3 py-5 text-center">
            <p className="text-[12.5px] leading-snug text-text-muted">{t('dm.list.failed')}</p>
            <button
              type="button"
              onClick={() => useDmStore.getState().reload()}
              className="mt-2 rounded-full border border-line px-3 py-1 text-[12.5px] text-text outline-none transition-colors hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t('dm.list.retry')}
            </button>
          </div>
        ) : conversations.length === 0 ? (
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
    </aside>
  );
}

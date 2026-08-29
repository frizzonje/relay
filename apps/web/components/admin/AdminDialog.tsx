'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SETTING_GROUPS, type SettingGroup, type SettingSpec } from '@relay/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { springTab, tabPanel } from '@/lib/motion';
import { useT, type MessageKey } from '@/lib/i18n';
import { adminRefusalKey } from '@/lib/refusals';
import { useAdminStore } from '@/stores/admin';
import { useOwnerStore } from '@/stores/owner';
import { useUiStore } from '@/stores/ui';
import { SettingField } from '@/components/admin/SettingField';

/**
 * Панель инсталляции — окно владельца.
 *
 * Родной брат окна личных настроек (`SettingsDialog`): те же 860×600 поверх
 * блюра, та же колонка вкладок слева, та же лента вкладок на телефоне. Разница
 * ровно одна и она по существу: там человек настраивает свою вкладку, здесь —
 * всю инсталляцию, и каждое поле рисуется по КАТАЛОГУ, приехавшему с сервера.
 *
 * Вкладка = группа каталога. Список групп берётся из того же ответа сервера, а
 * `SETTING_GROUPS` задаёт лишь ПОРЯДОК: группа, о которой панель не знает
 * (сервер новее), встаёт в конец, а не пропадает вместе со своими полями.
 *
 * Прав панель не раздаёт: их проверяет сервер на каждом событии (§9). Кнопка,
 * которую клиент не нарисовал, ничего не запрещает — поэтому здесь только «есть
 * ли смысл рисовать», а не «можно ли».
 */
export function AdminDialog() {
  const t = useT();
  const open = useUiStore((s) => s.adminOpen);
  const setOpen = useUiStore((s) => s.setAdminOpen);
  const owner = useOwnerStore((s) => s.owner);
  const loaded = useAdminStore((s) => s.loaded);
  const catalog = useAdminStore((s) => s.catalog);
  const error = useAdminStore((s) => s.error);
  const [tab, setTab] = useState<SettingGroup | null>(null);
  const [resetting, setResetting] = useState(false);

  // Открылась — спрашиваем состояние; закрылась — забываем его. Стор пережил бы
  // закрытие, и тогда бывший владелец увидел бы в панели вчерашние значения, а
  // сегодняшний — те, что приехали до его правок со второго устройства.
  useEffect(() => {
    setResetting(false);
    if (open) void useAdminStore.getState().load();
    else useAdminStore.getState().reset();
  }, [open]);

  // Власть ушла под живым сокетом (кто-то открыл новую ссылку владельца).
  // Сервер с этого мгновения отвечает `forbidden` на каждое событие панели, а
  // открытое окно продолжало бы показывать снимок — уже чужой инсталляции.
  useEffect(() => {
    if (owner) return;
    setOpen(false);
    useAdminStore.getState().reset();
  }, [owner, setOpen]);

  // На телефоне лента вкладок прокручивается, и выбранная легко оказывается за
  // краем: подтягиваем её в поле зрения (на десктопе колонка не прокручивается,
  // и вызов ничего не делает). Тот же приём, что в личных настройках.
  const navRef = useRef<HTMLElement>(null);
  const groups = useMemo(() => groupsOf(catalog), [catalog]);
  const active = tab && groups.includes(tab) ? tab : (groups[0] ?? null);
  useEffect(() => {
    // `scrollIntoView?.` — не перестраховка: в jsdom его нет вовсе, и без
    // вопросительного знака открытие панели падало бы в тестах, ничего не
    // сообщая о самой панели.
    navRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [active]);

  if (!owner) return null;

  const fields = catalog.filter((spec) => spec.group === active);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className={cn(
          'flex h-[600px] max-h-[92vh] w-[860px] max-w-[94vw] gap-0 overflow-hidden !p-0',
          // Мобайл: лист во весь экран и колонкой — как у личных настроек.
          'max-md:h-[100dvh] max-md:max-h-none max-md:w-screen max-md:max-w-none',
          'max-md:flex-col max-md:rounded-none max-md:border-0',
        )}
      >
        <DialogTitle className="sr-only">{t('admin.title')}</DialogTitle>

        <nav
          ref={navRef}
          aria-label={t('admin.title')}
          className={cn(
            'flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-bg-deep/60 p-3',
            'max-md:w-full max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden',
            'max-md:border-b max-md:border-r-0 max-md:p-2',
            'max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden',
          )}
        >
          <div className="px-2 pb-2 pt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint max-md:hidden">
            {t('admin.title')}
          </div>
          {groups.map((group) => (
            <button
              key={group}
              type="button"
              data-testid={`admin-tab-${group}`}
              onClick={() => setTab(group)}
              aria-current={group === active}
              className={cn(
                'relative rounded-[8px] px-3 py-2 text-left text-[14px] outline-none transition-colors',
                'max-md:shrink-0 max-md:whitespace-nowrap',
                group === active
                  ? 'text-text-header'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text',
              )}
            >
              {/* Подложка одна на всю группу: общий layoutId — и она переезжает
                  к выбранной вкладке, а не мигает на новом месте. */}
              {group === active && (
                <motion.span
                  layoutId="admin-tab"
                  transition={springTab}
                  className="absolute inset-0 rounded-[8px] bg-bg-active"
                />
              )}
              <span className="relative">{groupName(t, group)}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-5 max-md:px-4">
            <h2 className="overflow-hidden text-[15px] font-semibold text-text-header">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={active ?? 'none'}
                  variants={tabPanel}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="block"
                >
                  {active ? groupName(t, active) : t('admin.title')}
                </motion.span>
              </AnimatePresence>
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('admin.close')}
              className="grid h-7 w-7 place-items-center rounded-[7px] text-lg leading-none text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text-header"
            >
              ×
            </button>
          </div>

          {/* Отказ на всю панель и «ещё спрашиваем» стоят ВНЕ анимации смены
              вкладок: у `mode="wait"` следующий кадр ждёт, пока уйдёт прежний,
              и поля появлялись бы только после того, как догаснет заглушка. */}
          <div className="flex-1 overflow-y-auto p-5 max-md:p-4">
            {error ? (
              <Notice>{t(adminRefusalKey(error))}</Notice>
            ) : !loaded ? (
              <Notice>{t('admin.loading')}</Notice>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active ?? 'none'}
                  variants={tabPanel}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  className="flex flex-col gap-2.5"
                >
                  {fields.map((spec) => (
                    <SettingField key={spec.key} spec={spec} />
                  ))}

                  {active && (
                    <button
                      type="button"
                      data-testid="admin-reset-group"
                      onClick={() => setResetting(true)}
                      className="mt-2 self-start rounded-[8px] px-3 py-2 text-[13px] text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      {t('admin.reset')}
                    </button>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </div>
      </DialogContent>

      {active && resetting && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setResetting(false)}
          title={t('admin.reset.title', { group: groupName(t, active) })}
          description={t('admin.reset.body')}
          confirmLabel={t('admin.reset.apply')}
          onConfirm={() => {
            setResetting(false);
            void useAdminStore.getState().resetGroup(active);
          }}
        />
      )}
    </Dialog>
  );
}

/** Пустое место с объяснением: панель грузится или сервер отказал. */
function Notice({ children }: { children: string }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center font-mono text-[12px] uppercase tracking-[0.18em] text-text-faint">
      {children}
    </div>
  );
}

/**
 * Группы, у которых есть хоть одно поле, в порядке каталога.
 *
 * Порядок берётся из клиентской копии, а сам состав — из серверной: группа, о
 * которой этот клиент не знает, встаёт в конец. Пропустить её значило бы
 * спрятать её поля целиком, и владелец искал бы параметр, который сервер ему
 * прислал.
 */
function groupsOf(catalog: SettingSpec[]): SettingGroup[] {
  const present = new Set(catalog.map((spec) => spec.group));
  const known = SETTING_GROUPS.filter((group) => present.has(group));
  const unknown = [...present].filter((group) => !SETTING_GROUPS.includes(group));
  return [...known, ...unknown];
}

/** Имя вкладки — по имени группы, как и всё остальное в панели. */
function groupName(t: (key: MessageKey) => string, group: SettingGroup): string {
  const message = `settings.group.${group}` as MessageKey;
  const text = t(message);
  return text === message ? group : text;
}

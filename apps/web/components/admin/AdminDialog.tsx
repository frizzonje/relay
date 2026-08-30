'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { PeopleTab } from '@/components/admin/PeopleTab';
import { BansTab } from '@/components/admin/BansTab';
import { OverviewTab } from '@/components/admin/OverviewTab';
import { AuditTab } from '@/components/admin/AuditTab';
import { UpkeepTab } from '@/components/admin/UpkeepTab';

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
 * Кроме них есть вкладки, у которых параметров нет вовсе: люди и баны. Они
 * стоят за чертой в конце списка и живут своими событиями (`admin-people`,
 * `admin-bans`, `admin-action`), а не каталогом, — потому и отделены: «сбросить
 * эту вкладку к умолчаниям» на списке людей не значит ничего.
 *
 * Прав панель не раздаёт: их проверяет сервер на каждом событии (§9). Кнопка,
 * которую клиент не нарисовал, ничего не запрещает — поэтому здесь только «есть
 * ли смысл рисовать», а не «можно ли».
 */

/**
 * Вкладки, которых в каталоге нет.
 *
 * Названы `identities`, а не `people`: `people` — это ГРУППА ПАРАМЕТРОВ о людях
 * (длина ника, показывать ли отпечатки), и две вкладки с одним именем спорили
 * бы и на экране, и в разметке.
 */
const LEAD_TABS = ['overview'] as const;

/**
 * Обслуживание зовётся `upkeep`, а не `maintenance`, по той же причине, что и
 * `identities`: `maintenance` — это ГРУППА ПАРАМЕТРОВ (режим обслуживания и
 * текст к нему). Имя, занятое группой, здесь занять нельзя.
 */
const TAIL_TABS = ['identities', 'bans', 'audit', 'upkeep'] as const;

const EXTRA_TABS = [...LEAD_TABS, ...TAIL_TABS] as const;

type ExtraTab = (typeof EXTRA_TABS)[number];
type AdminTab = SettingGroup | ExtraTab;

const isExtra = (tab: AdminTab): tab is ExtraTab => (EXTRA_TABS as readonly string[]).includes(tab);

export function AdminDialog() {
  const t = useT();
  const open = useUiStore((s) => s.adminOpen);
  const setOpen = useUiStore((s) => s.setAdminOpen);
  const owner = useOwnerStore((s) => s.owner);
  const loaded = useAdminStore((s) => s.loaded);
  const catalog = useAdminStore((s) => s.catalog);
  const error = useAdminStore((s) => s.error);
  const [tab, setTab] = useState<AdminTab | null>(null);
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
  // Сводка первой: панель чаще всего открывают вопросом «жива ли машина и
  // сколько там всего», и начинать с поля настройки значило бы прятать ответ.
  const tabs = useMemo<AdminTab[]>(() => [...LEAD_TABS, ...groups, ...TAIL_TABS], [groups]);
  const active = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
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
          {tabs.map((item, at) => (
            <Fragment key={item}>
              {/* Черта отделяет параметры от того, что параметрами не правится:
                  на списке людей нечего сбрасывать к умолчаниям. */}
              {(at === LEAD_TABS.length || at === LEAD_TABS.length + groups.length) && (
                <div
                  aria-hidden
                  className="my-1.5 border-t border-line max-md:my-0 max-md:ml-1 max-md:mr-1 max-md:border-l max-md:border-t-0"
                />
              )}
              <button
                type="button"
                data-testid={`admin-tab-${item}`}
                onClick={() => setTab(item)}
                aria-current={item === active}
                className={cn(
                  'relative rounded-[8px] px-3 py-2 text-left text-[14px] outline-none transition-colors',
                  'max-md:shrink-0 max-md:whitespace-nowrap',
                  item === active
                    ? 'text-text-header'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text',
                )}
              >
                {/* Подложка одна на всю колонку: общий layoutId — и она
                    переезжает к выбранной вкладке, а не мигает на новом месте. */}
                {item === active && (
                  <motion.span
                    layoutId="admin-tab"
                    transition={springTab}
                    className="absolute inset-0 rounded-[8px] bg-bg-active"
                  />
                )}
                <span className="relative">{tabName(t, item)}</span>
              </button>
            </Fragment>
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
                  {active ? tabName(t, active) : t('admin.title')}
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
                  {active === 'overview' ? (
                    <OverviewTab />
                  ) : active === 'identities' ? (
                    <PeopleTab />
                  ) : active === 'bans' ? (
                    <BansTab />
                  ) : active === 'audit' ? (
                    <AuditTab />
                  ) : active === 'upkeep' ? (
                    <UpkeepTab />
                  ) : (
                    <>
                      {fields.map((spec) => (
                        <SettingField key={spec.key} spec={spec} />
                      ))}

                      {/* «Вернуть к умолчаниям» — только у вкладки параметров:
                          у списка людей умолчаний нет, и кнопка там означала бы
                          неизвестно что. */}
                      {active && !isExtra(active) && (
                        <button
                          type="button"
                          data-testid="admin-reset-group"
                          onClick={() => setResetting(true)}
                          className="mt-2 self-start rounded-[8px] px-3 py-2 text-[13px] text-text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger"
                        >
                          {t('admin.reset')}
                        </button>
                      )}
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </div>
      </DialogContent>

      {active && !isExtra(active) && resetting && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setResetting(false)}
          title={t('admin.reset.title', { group: tabName(t, active) })}
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

/**
 * Имя вкладки — по её ключу, как и всё остальное в панели: группа берёт его из
 * словаря групп, внекаталожная — из своего. Ключа нет в словаре только у
 * группы, заведённой сервером новее, — она называется машинным именем, и это
 * лучше пустого места, за которое не взяться.
 */
function tabName(t: (key: MessageKey) => string, tab: AdminTab): string {
  const message = (isExtra(tab) ? `admin.tab.${tab}` : `settings.group.${tab}`) as MessageKey;
  const text = t(message);
  return text === message ? tab : text;
}

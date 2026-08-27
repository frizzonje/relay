'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { DmList } from '@/components/dm/DmList';
import { springDrawer } from '@/lib/motion';
import { useT } from '@/lib/i18n';
import { useUnreadCount } from '@/stores/dm';
import { useUiStore } from '@/stores/ui';

/**
 * Панель ЛС на десктопе: выезжает справа, из-под рейки тулбара, и встаёт ровно
 * на место колонки состава — та же ширина 232px, те же верх и низ. Отсюда и
 * «встроена, а не наложена»: раскладка вокруг не дёргается ни на точку, а
 * список садится в уже знакомую глазу колонку.
 *
 * Раньше раздел подменял собой каналы в сайдбаре — на другом конце экрана от
 * кнопки, которой его открывали, и ценой всего списка каналов. Теперь каналы
 * не трогаются вовсе, а панель уезжает сама, стоит войти в канал (`openText`
 * гасит `dmSection`), оставляя за собой язычок.
 *
 * Язычок — не украшение: панель уехала не потому, что её закрыли, а потому что
 * человек занялся другим, и вернуть её должно быть нечем иным, кроме одного
 * движения к тому самому краю, откуда она ушла. Кнопка в рейке делает то же,
 * но она в 64 точках выше и говорит «раздел ЛС», а не «верни, что уехало».
 */
export function DmDrawer() {
  const t = useT();
  const open = useUiStore((s) => s.dmSection);
  const showDmList = useUiStore((s) => s.showDmList);
  const unread = useUnreadCount();

  return (
    <>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="dm-drawer"
            data-testid="dm-drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springDrawer}
            // `right-16` — ширина рейки: панель стоит вплотную к ней, а уезжает
            // ЗА неё (рейка выше по стопке, см. z-30 в Toolbar). Тень слева —
            // единственное, чем панель отделена от сцены: границы там уже две.
            className="absolute inset-y-0 right-16 z-20 flex w-[232px] border-l border-line shadow-[-10px_0_30px_rgba(0,0,0,0.32)] max-md:hidden"
          >
            <DmList />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!open && (
          <motion.button
            key="dm-tab"
            type="button"
            data-testid="dm-tab"
            onClick={showDmList}
            title={t('dm.expand')}
            aria-label={t('dm.expand')}
            // `y` держим здесь, а не классом `-translate-y-1/2`: Framer пишет
            // transform целиком в style и класс бы затёр.
            initial={{ opacity: 0, x: 8, y: '-50%' }}
            animate={{ opacity: 1, x: 0, y: '-50%' }}
            exit={{ opacity: 0, x: 8, y: '-50%' }}
            transition={{ duration: 0.16, ease: [0.2, 0.8, 0.3, 1] }}
            className="group absolute right-16 top-1/2 z-20 grid h-16 w-3.5 place-items-center rounded-l-[8px] border border-r-0 border-line bg-bg-sidebar text-text-faint shadow-[-3px_0_8px_rgba(0,0,0,0.18)] outline-none transition-[width,background-color,color] duration-150 hover:w-5 hover:bg-bg-hover hover:text-text-header focus-visible:ring-2 focus-visible:ring-line-strong max-md:hidden"
          >
            <Icon name="chevron-left" className="text-[13px]" strokeWidth={2} />
            {/* Непрочитанное на язычке — тем же цветом, что бейдж в рейке: пока
                панель уехала, точка в её списке никому не видна. */}
            {unread > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute -left-1 top-2 h-2 w-2 rounded-full bg-danger"
              />
            )}
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

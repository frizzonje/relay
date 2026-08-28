import type { Transition, Variants } from 'framer-motion';

/**
 * Общие пресеты движения для Framer Motion — чтобы «плавность» по всему
 * интерфейсу была одинаковой на ощупь. Циклические/тяжёлые анимации глушит
 * <MotionConfig reducedMotion="user"> в app/providers.tsx (prefers-reduced-motion).
 */

/**
 * Сколько гаснет и проявляется сцена (лобби ↔ канал). Короче обычного: за это
 * время не только меняется картинка, но и переставляется раскладка вокруг неё
 * (колонка состава забирает ширину у сцены), а раскладка ждать не любит.
 */
export const STAGE_FADE_MS = 160;

/** Пружина для layout-перестроек — тот же профиль, что на видеоплитках. */
export const springLayout: Transition = { type: 'spring', stiffness: 360, damping: 34 };

/** Короткая пружина «с отскоком» для мелких появлений (чипы реакций, бейджи). */
export const springPop: Transition = { type: 'spring', stiffness: 520, damping: 28 };

/**
 * Строка списка (участники, каналы): въезд снизу вверх, выход — вверх с
 * растворением. Соседи плавно занимают место за счёт `layout` на элементе.
 */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.2, 0.8, 0.3, 1] } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.14 } },
};

/** Появление сообщения в ленте чата — мягкий подъём. */
export const chatMessage: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.2, 0.8, 0.3, 1] } },
};

/**
 * «Едущая» подложка активной вкладки (общий `layoutId` на всех вкладках группы).
 * Жёстче springLayout: индикатор должен догонять палец, а не догонять с оттяжкой.
 */
export const springTab: Transition = { type: 'spring', stiffness: 520, damping: 42 };

/** Смена содержимого вкладки: старое гаснет, новое приезжает снизу. */
export const tabPanel: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.2, 0.8, 0.3, 1] } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

/**
 * Заголовок мобильной шапки при переходе между экранами. `custom` — направление
 * хода стопки: +1 вглубь (каналы → канал → состав), −1 назад по стрелке. Новый
 * заголовок въезжает со стороны хода, старый уходит в противоположную — как в
 * навигации нативных мессенджеров.
 */
export const navTitle: Variants = {
  hidden: (dir: number) => ({ opacity: 0, x: dir * 18 }),
  show: { opacity: 1, x: 0, transition: { duration: 0.22, ease: [0.2, 0.8, 0.3, 1] } },
  exit: (dir: number) => ({ opacity: 0, x: dir * -18, transition: { duration: 0.14 } }),
};

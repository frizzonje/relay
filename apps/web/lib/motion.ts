import type { Transition, Variants } from 'framer-motion';

/**
 * Общие пресеты движения для Framer Motion — чтобы «плавность» по всему
 * интерфейсу была одинаковой на ощупь. Циклические/тяжёлые анимации глушит
 * <MotionConfig reducedMotion="user"> в app/providers.tsx (prefers-reduced-motion).
 */

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

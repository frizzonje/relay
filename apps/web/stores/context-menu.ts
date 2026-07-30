import { create } from 'zustand';

/**
 * Значок пункта. Не свободная картинка, а имя из закрытого набора: рисует их
 * ContextMenu.tsx одним контуром (Feather, 14px), поэтому начинка меню остаётся
 * обычными данными — её можно собирать и проверять без рендера.
 */
export type MenuIcon =
  | 'copy'
  | 'cut'
  | 'download'
  | 'edit'
  | 'link'
  | 'link-open'
  | 'paste'
  | 'refresh'
  | 'reply'
  | 'select-all'
  | 'settings'
  | 'trash';

/**
 * Пункт нашего контекстного меню: значок слева, подпись, моно-подсказка
 * горячей клавиши справа.
 */
export interface MenuAction {
  id: string;
  label: string;
  /** Значок слева. Без него пункт встаёт в тот же столбец подписей. */
  icon?: MenuIcon;
  /** Горячая клавиша справа: «⌘C» / «Ctrl+C». */
  hint?: string;
  /** Красный пункт (удаление). */
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** Разделитель групп. */
export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuAction | MenuSeparator;

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

export interface OpenMenu {
  /** Координаты курсора (viewport). Прижимание к краям — на рендерере. */
  x: number;
  y: number;
  entries: MenuEntry[];
  /** Моно-заголовок над списком: чем именно щёлкнули («Сообщение от …»). */
  label?: string;
}

interface ContextMenuState {
  menu: OpenMenu | null;
  open: (menu: OpenMenu) => void;
  close: () => void;
}

/**
 * Одно меню на приложение: открытие поверх уже открытого просто заменяет его,
 * поэтому «застрявших» панелей не бывает.
 */
export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null }),
}));

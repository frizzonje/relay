// Тема оформления (тёмная/светлая). Хранится в localStorage и применяется
// атрибутом data-theme на <html>; светлые значения токенов — в globals.css
// (:root[data-theme='light']). По умолчанию — тёмная (историческая тема relay).

export type Theme = 'dark' | 'light';

const KEY = 'relay-theme';

/** Текущая тема из localStorage (вне браузера — тёмная). */
export function getTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark';
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

/** Применить тему к документу (без записи в хранилище). */
export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/** Сохранить выбор и применить его немедленно. */
export function setTheme(theme: Theme): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

// Инлайн-скрипт для <head>: ставит data-theme ДО первой отрисовки, чтобы при
// светлой теме не мигало тёмным. Вставляется через dangerouslySetInnerHTML
// (app/layout.tsx). Держим строкой — исполняется до гидрации React.
export const THEME_INIT_SCRIPT =
  "try{var t=localStorage.getItem('relay-theme');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}catch(e){}";

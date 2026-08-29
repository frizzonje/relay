import { setting } from '@/stores/config';

// Тема оформления (тёмная/светлая). Хранится в localStorage и применяется
// атрибутом data-theme на <html>; светлые значения токенов — в globals.css
// (:root[data-theme='light']). Не выбрал человек — решает инсталляция
// (`appearance.defaultTheme`), а её умолчание — тёмная, историческая тема relay.

export type Theme = 'dark' | 'light';

const KEY = 'relay-theme';

/** Выбор человека в этом браузере или `null` — не выбирал. */
function stored(): Theme | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(KEY);
  return raw === 'light' || raw === 'dark' ? raw : null;
}

/**
 * Тема инсталляции: `system` означает «как в системе», и разворачивается она
 * здесь, а не в каталоге, — про `prefers-color-scheme` знает только браузер.
 */
function installTheme(): Theme {
  const choice = setting<string>('appearance.defaultTheme');
  if (choice === 'light' || choice === 'dark') return choice;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/**
 * Действующая тема: выбор человека главнее умолчания инсталляции. Владелец
 * задаёт, с чего начинают те, кто не выбирал, а не отбирает выбор у тех, кто
 * выбрал, — иначе переключатель в настройках возвращался бы к чужому значению
 * при каждой перезагрузке.
 */
export function getTheme(): Theme {
  return stored() ?? installTheme();
}

/** Не выбирал ли человек тему сам — по этому решается, слушать ли инсталляцию. */
export function themeIsInstallDefault(): boolean {
  return stored() === null;
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

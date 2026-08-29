'use client';

import { useEffect } from 'react';
import { applyTheme, getTheme, themeIsInstallDefault } from '@/lib/theme';
import { useSetting } from '@/stores/config';

/**
 * Вид, который инсталляция задаёт всем: имя и значок в заголовке вкладки и тема
 * по умолчанию.
 *
 * Заголовок — единственное место, где имя видно, когда на relay не смотрят:
 * человек с десятком вкладок узнаёт свою по нему, а держи мы там общее «relay»,
 * два разных сервера выглядели бы одинаково. Значок ставим перед именем — в
 * узкой вкладке до текста дело может и не дойти.
 *
 * Всё из эффекта, а не с сервера: заголовок рисуется до того, как известна
 * личность, а снимок настроек спрашивает пропуск. Компонент ничего не рисует.
 */
export function InstallAppearance() {
  const name = useSetting<string>('appearance.installName').trim();
  const emoji = useSetting<string>('appearance.installEmoji').trim();
  const defaultTheme = useSetting<string>('appearance.defaultTheme');

  useEffect(() => {
    if (!name) return;
    document.title = emoji ? `${emoji} ${name}` : name;
  }, [name, emoji]);

  // Тему инсталляции применяем только тому, кто своей не выбирал: владелец
  // задаёт, с чего начинают остальные, а не отбирает у человека переключатель.
  // Инлайн-скрипт в <head> к этому моменту уже поставил тёмную (снимок к нему
  // не успевает), поэтому светлую приходится доставлять сюда — один кадр
  // мигания честнее, чем настройка, которая не действует.
  useEffect(() => {
    if (themeIsInstallDefault()) applyTheme(getTheme());
  }, [defaultTheme]);

  return null;
}

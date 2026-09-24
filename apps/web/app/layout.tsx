import './globals.css';
/**
 * Шрифты relay лежат в npm-пакетах @fontsource и едут в бандл сами. Не
 * next/font/google: тот качает CSS у Google прямо во время `next build`, и
 * когда Google отвечает раннеру CI не тем, сборка образа падает на ровном
 * месте. Каждый файл — все подмножества с unicode-range: браузер берёт только
 * нужные (latin, cyrillic). Семейства потребляют токены --font-sans/--font-mono
 * в globals.css. IBM Plex Sans — UI; IBM Plex Mono — лейблы/метрики/таймстампы.
 */
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@relay/shared';
import { Background } from '@/components/layout/Background';
import { getLocale, getT } from '@/lib/i18n/server';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { Providers } from './providers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: APP_NAME, description: t('app.description') };
}

export const viewport: Viewport = {
  themeColor: '#08090b',
  width: 'device-width',
  initialScale: 1,
  // Раскладка под вырезы/скруглённые углы: даёт работать env(safe-area-inset-*)
  // (таб-бар и bottom sheet мобильного веба уводят контент из-под системных панелей).
  viewportFit: 'cover',
};

/**
 * Локаль решается здесь, на сервере (кука → Accept-Language), и уезжает вниз
 * пропом: серверный HTML и первый клиентский рендер обязаны совпасть, иначе
 * React ругается на гидрацию, а язык моргает при загрузке.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} data-theme="dark">
      <head>
        {/* Применяем сохранённую тему до отрисовки — иначе светлая мигнёт тёмным. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Background />
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}

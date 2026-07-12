import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { APP_NAME } from '@relay/shared';
import { Background } from '@/components/layout/Background';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { Providers } from './providers';

/**
 * Шрифты relay через next/font (self-hosted, без FOUT-запроса к Google в
 * рантайме). IBM Plex Sans — UI; IBM Plex Mono — лейблы/метрики/таймстампы.
 * Переменные --font-plex-* потребляют токены --font-sans/--font-mono в globals.css.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Закрытый канал связи',
};

export const viewport: Viewport = {
  themeColor: '#08090b',
  width: 'device-width',
  initialScale: 1,
  // Раскладка под вырезы/скруглённые углы: даёт работать env(safe-area-inset-*)
  // (таб-бар и bottom sheet мобильного веба уводят контент из-под системных панелей).
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" data-theme="dark" className={`${plexSans.variable} ${plexMono.variable}`}>
      <head>
        {/* Применяем сохранённую тему до отрисовки — иначе светлая мигнёт тёмным. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Background />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

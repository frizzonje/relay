'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { Toaster } from 'sonner';
import { SocketProvider } from '@/components/providers/SocketProvider';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { I18nProvider, type Locale } from '@/lib/i18n';

/**
 * Клиентские провайдеры приложения.
 * I18nProvider — язык интерфейса; локаль приходит с сервера (app/layout.tsx),
 * поэтому первый рендер уже на нужном языке.
 * MotionConfig reducedMotion="user" — глобально гасит тяжёлые/циклические
 * анимации Framer Motion для пользователей с prefers-reduced-motion (план §3.3).
 * ContextMenu — одно контекстное меню на всё приложение (и глушитель меню движка).
 */
export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <MotionConfig reducedMotion="user">
        <SocketProvider>{children}</SocketProvider>
        <ContextMenu />
        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{ className: 'glass glass-3' }}
        />
      </MotionConfig>
    </I18nProvider>
  );
}

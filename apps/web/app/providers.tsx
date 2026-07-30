'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { Toaster } from 'sonner';
import { SocketProvider } from '@/components/providers/SocketProvider';
import { ContextMenu } from '@/components/ui/ContextMenu';

/**
 * Клиентские провайдеры приложения.
 * MotionConfig reducedMotion="user" — глобально гасит тяжёлые/циклические
 * анимации Framer Motion для пользователей с prefers-reduced-motion (план §3.3).
 * ContextMenu — одно контекстное меню на всё приложение (и глушитель меню движка).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SocketProvider>{children}</SocketProvider>
      <ContextMenu />
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{ className: 'glass glass-3' }}
      />
    </MotionConfig>
  );
}

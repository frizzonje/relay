'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { Toaster } from 'sonner';
import { SocketProvider } from '@/components/providers/SocketProvider';

/**
 * Клиентские провайдеры приложения.
 * MotionConfig reducedMotion="user" — глобально гасит тяжёлые/циклические
 * анимации Framer Motion для пользователей с prefers-reduced-motion (план §3.3).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SocketProvider>{children}</SocketProvider>
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{ className: 'glass glass-3' }}
      />
    </MotionConfig>
  );
}

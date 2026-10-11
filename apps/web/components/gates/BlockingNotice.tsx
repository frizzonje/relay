'use client';

import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Объяснение вместо приложения: значок, заголовок, пара строк и, если есть,
 * действие под ними. Им говорят ворота — бан, закрытый адрес, обслуживание,
 * разошедшиеся версии, неузнанная личность. Пять экранов обязаны выглядеть
 * одним: человек видит их редко и сравнивает между собой, а не с чатом.
 */
export function NoticeBody({
  icon,
  title,
  body,
  bodyTestId,
  multiline,
  children,
}: {
  icon: string;
  title: ReactNode;
  body: ReactNode;
  bodyTestId?: string;
  /** Текст пишет человек (владелец) — его переводы строк сохраняются. */
  multiline?: boolean;
  /** Под текстом: отпечаток, кнопка. */
  children?: ReactNode;
}) {
  return (
    <div className="px-7 pb-6 pt-6 text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
        {icon}
      </div>
      <DialogTitle className="text-xl">{title}</DialogTitle>
      <DialogDescription
        className={cn(
          'mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed',
          multiline && 'whitespace-pre-line',
        )}
        data-testid={bodyTestId}
      >
        {body}
      </DialogDescription>
      {children}
    </div>
  );
}

/**
 * То же объяснение окном, которое не закрыть: ни Esc, ни клика мимо. Закрывать
 * тут нечего — сокета нет, и за окном приложение, которое всё равно не
 * работает. Уходит окно само, когда пропадает причина.
 */
export function BlockingNotice({
  open,
  ...notice
}: { open: boolean } & Parameters<typeof NoticeBody>[0]) {
  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-[420px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <NoticeBody {...notice} />
      </DialogContent>
    </Dialog>
  );
}

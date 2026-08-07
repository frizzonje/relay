'use client';

import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * Подтверждение необратимого действия. Один диалог на всё приложение — вместо
 * window.confirm, который в нативной оболочке выдаёт себя системным окном
 * браузера и выглядит чужеродно.
 *
 * Уговор простой: заголовок называет действие, описание — последствия («у всех
 * участников», «сообщения пропадут»), а `details` — то, что известно только на
 * момент открытия (сколько человек внутри, сколько сообщений). Кнопка
 * подтверждения одна и красная: пути назад не будет.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  confirmLabel,
  confirmVariant = 'danger',
  busy,
  confirmDisabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Живые подробности под описанием (счётчики, предупреждения). */
  details?: ReactNode;
  confirmLabel?: string;
  /**
   * Красная кнопка — про необратимость, а не про «внимание»: заливкой цветом
   * останавливают руку там, где отменить будет нечем. Действие обратимое, но
   * дорогое (обрыв разговора на переключении транспорта) спрашивает тем же
   * диалогом, но обычной кнопкой — иначе красное перестанет что-либо значить.
   */
  confirmVariant?: 'danger' | 'primary';
  /** Ждём ответа сервера — кнопки заблокированы, чтобы не жать дважды. */
  busy?: boolean;
  /** Подтверждать пока нельзя (данные ещё грузятся, действие запрещено).
      «Отмена» при этом остаётся живой — из диалога всегда есть выход. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {details}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {/* Фокус по умолчанию радикс отдаёт первой кнопке (Отмена) — так
              Enter сразу после открытия ничего не сносит. */}
          <Button
            type="button"
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {confirmLabel ?? t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

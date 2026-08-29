'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useContractStore } from '@/stores/contract';
import { useT } from '@/lib/i18n';

/**
 * Инсталляция закрыта на обслуживание, и внутрь не пустили.
 *
 * Экран, а не полоска сверху, по той же причине, что у бана и разошедшихся
 * версий: сокета после такого отказа нет вовсе, и всё вокруг — каналы, состав,
 * поле ввода — остаётся декорацией, которая молча ничего не делает. Полоска
 * (`MaintenanceBanner`) — для тех, кого пустили: она предупреждает, а этот
 * экран объясняет уже случившееся.
 *
 * Текст пишет владелец (`maintenance.message`) и приезжает он вместе с отказом
 * двери. Не написал — говорим своими словами: «закрыто, зайдите позже» лучше,
 * чем пустой прямоугольник, и куда лучше, чем вечное «переподключаюсь».
 *
 * Кнопки «повторить» здесь нет намеренно: клиент и так стучится сам, и в тот
 * миг, когда владелец выключит режим, экран пропадёт без единого нажатия.
 */
export function MaintenanceGate() {
  const t = useT();
  const message = useContractStore((s) => s.maintenance);

  return (
    <Dialog open={message !== null}>
      <DialogContent
        className="max-w-[420px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="px-7 pb-6 pt-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
            🛠
          </div>
          <DialogTitle className="text-xl">{t('maintenance.title')}</DialogTitle>
          <DialogDescription
            className="mx-auto mt-1.5 max-w-[320px] whitespace-pre-line text-[13px] leading-relaxed"
            data-testid="maintenance-message"
          >
            {message || t('maintenance.body')}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}

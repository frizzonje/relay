'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useContractStore } from '@/stores/contract';
import { useT } from '@/lib/i18n';

/**
 * Клиент и сервер разошлись версиями контракта.
 *
 * Экран, а не тост, и без крестика: сервер отказал во входе, сокета нет, и всё
 * вокруг — рейка, каналы, поле ввода — работать не будет. Показать декорацию
 * вместо объяснения значит заставить человека гадать, сломался relay или
 * интернет.
 *
 * Сторон две, и советы у них противоположные. Устаревший клиент — это чаще
 * всего вкладка, открытая до обновления сервера: она держит скачанный тогда
 * бандл, и лечится это перезагрузкой. Устаревший сервер человек не починит
 * ничем — там relay старее, чем приложение, которым в него стучатся, и звать
 * его жать «обновить» значило бы советовать бесполезное.
 */
export function OutdatedGate() {
  const t = useT();
  const outdated = useContractStore((s) => s.outdated);

  return (
    <Dialog open={outdated !== null}>
      <DialogContent
        className="max-w-[420px]"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="px-7 pb-6 pt-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
            ⏳
          </div>
          <DialogTitle className="text-xl">
            {t(outdated === 'server' ? 'outdated.server.title' : 'outdated.client.title')}
          </DialogTitle>
          <DialogDescription className="mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed">
            {t(outdated === 'server' ? 'outdated.server.body' : 'outdated.client.body')}
          </DialogDescription>
          {outdated === 'client' && (
            <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
              {t('outdated.reload')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

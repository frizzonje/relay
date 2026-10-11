'use client';

import { BlockingNotice } from '@/components/gates/BlockingNotice';
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
    <BlockingNotice
      open={outdated !== null}
      icon="⏳"
      title={t(outdated === 'server' ? 'outdated.server.title' : 'outdated.client.title')}
      body={t(outdated === 'server' ? 'outdated.server.body' : 'outdated.client.body')}
    >
      {outdated === 'client' && (
        <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
          {t('outdated.reload')}
        </Button>
      )}
    </BlockingNotice>
  );
}

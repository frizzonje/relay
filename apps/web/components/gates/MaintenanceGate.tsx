'use client';

import { BlockingNotice } from '@/components/gates/BlockingNotice';
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
    <BlockingNotice
      open={message !== null}
      icon="🛠"
      title={t('maintenance.title')}
      body={message || t('maintenance.body')}
      bodyTestId="maintenance-message"
      multiline
    />
  );
}

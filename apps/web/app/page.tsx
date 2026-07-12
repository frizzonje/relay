import { AppShell } from '@/components/layout/AppShell';
import { AudioUnlock } from '@/components/layout/AudioUnlock';
import { IdentityGate } from '@/components/layout/IdentityGate';

/**
 * Главный экран. Каркас (рейка / сайдбар / сцена / состав) живёт в AppShell —
 * он же отвечает за адаптив (десктоп-колонки ↔ мобильные панели + таб-бар).
 * Поверх — кнопка разблокировки автоплей-звука и гейт выбора @-тега.
 */
export default function Page() {
  return (
    <>
      <AppShell />
      <AudioUnlock />
      <IdentityGate />
    </>
  );
}

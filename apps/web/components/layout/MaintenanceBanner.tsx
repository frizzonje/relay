'use client';

import { useSetting } from '@/stores/config';

/**
 * Полоса объявления от владельца инсталляции (`maintenance.bannerText`).
 *
 * Отдельно от режима обслуживания и намеренно: тот закрывает вход всем, кроме
 * владельца, и объясняется отказом на входе. Полоса нужна ровно до этого — «в
 * субботу переезжаем, сохраните важное», — и потому висит над работающим
 * приложением, а не вместо него.
 *
 * Пустой текст — умолчание каталога, и тогда полосы нет вовсе: место она
 * забирает у сцены, и висеть без повода не должна. Текст пишет владелец, поэтому
 * он не переводится — на каком языке написали, на таком и висит.
 */
export function MaintenanceBanner() {
  const text = useSetting<string>('maintenance.bannerText').trim();
  if (!text) return null;
  return (
    <div
      // `whitespace-pre-line`: поле в панели многострочное, и абзацы, которые
      // владелец там расставил, обязаны доехать до экрана.
      className="shrink-0 whitespace-pre-line border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-[13px] leading-relaxed text-warn"
      role="status"
    >
      {text}
    </div>
  );
}

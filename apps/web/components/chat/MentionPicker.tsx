'use client';

import { useEffect, useState } from 'react';
import type { MentionSuggestResult } from '@relay/shared';
import { cn } from '@/lib/utils';
import { ask } from '@/lib/channels';
import { Identicon } from '@/components/ui/Identicon';
import { useT } from '@/lib/i18n';

/**
 * Подсказка после набранного `@`: кого можно позвать.
 *
 * Список приходит с сервера и им же ограничен — предлагать людей, которым канал
 * не виден, нельзя, а знать, кому он виден, может только он. Своего имени в
 * списке нет: позвать себя незачем.
 *
 * Выбор мышью и с клавиатуры равноправны, и это не вежливость к любителям
 * хоткеев: `@` набирают, не отрывая рук от клавиатуры, и тянуться за мышью
 * посреди фразы — ровно то, чего подсказка должна избавить.
 */

/** Кто-то из подсказки. */
export type MentionCandidate = MentionSuggestResult['people'][number];

/** Пауза перед запросом: человек печатает быстрее, чем сервер отвечает. */
const TYPING_PAUSE_MS = 120;

/**
 * Спросить сервер, кого предложить. Ответ на устаревший запрос отбрасываем:
 * набранное «ан» и «аня» уходят почти одновременно, и прийти они могут в любом
 * порядке — список под курсором не должен зависеть от того, в каком.
 */
export function useMentionSuggest(query: string | null): {
  people: MentionCandidate[];
  asked: boolean;
} {
  const [state, setState] = useState<{ people: MentionCandidate[]; asked: boolean }>({
    people: [],
    asked: false,
  });

  useEffect(() => {
    if (query === null) {
      setState({ people: [], asked: false });
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      const res = await ask<MentionSuggestResult>('mention-suggest', { prefix: query });
      if (!live) return;
      setState({ people: res?.people ?? [], asked: true });
    }, TYPING_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  return state;
}

export function MentionPicker({
  people,
  active,
  asked,
  onPick,
  onHover,
}: {
  people: MentionCandidate[];
  /** Кто выбран стрелками — его же выберет Enter. */
  active: number;
  /** Сервер уже ответил: до этого «никого не нашлось» было бы враньём. */
  asked: boolean;
  onPick: (person: MentionCandidate) => void;
  onHover: (index: number) => void;
}) {
  const t = useT();
  if (!asked && !people.length) return null;
  return (
    <div
      role="listbox"
      aria-label={t('mention.title')}
      className="panel absolute bottom-full left-0 z-30 mb-2 max-h-[240px] w-[280px] overflow-y-auto rounded-[12px] border border-line p-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
    >
      {people.length === 0 ? (
        <p className="px-3 py-2.5 text-[13px] text-text-muted">{t('mention.empty')}</p>
      ) : (
        people.map((person, i) => (
          <button
            key={person.fingerprint}
            type="button"
            role="option"
            aria-selected={i === active}
            // mousedown, а не click: клик приходит после blur, а blur у поля
            // ввода закрывает подсказку — выбор мышью так не срабатывал бы.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(person);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors',
              i === active ? 'bg-bg-hover' : 'hover:bg-bg-hover/60',
            )}
          >
            <Identicon fingerprint={person.fingerprint} size={22} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-text-header">
              {person.nick}
            </span>
            {person.online && (
              <span
                aria-hidden
                title={t('mention.online')}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"
              />
            )}
          </button>
        ))
      )}
    </div>
  );
}

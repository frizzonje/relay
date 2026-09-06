'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  DM_PEOPLE_LIMIT,
  type DmOpenResult,
  type DmPeopleResult,
  type DmPerson,
} from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { ask } from '@/lib/channels';
import { fmtSince, shortFingerprint } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { useDmStore } from '@/stores/dm';
import { useUiStore } from '@/stores/ui';
import { useSetting } from '@/stores/config';

/** Пауза перед запросом при наборе — как в поиске по истории (SearchPanel). */
const TYPING_PAUSE_MS = 280;

function PersonRow({ person, onOpen }: { person: DmPerson; onOpen: () => void }) {
  const t = useT();
  const showFingerprints = useSetting<boolean>('people.showFingerprints');
  // «Был в сети» инсталляция вправе не показывать (`people.lastSeenVisible`):
  // это не про удобство, а про то, сколько чужой распорядок дня виден
  // посторонним. Скрыто — строки нет вовсе, а не «никогда»: подделанный ответ
  // хуже отсутствующего.
  const showLastSeen = useSetting<boolean>('people.lastSeenVisible');
  // «Когда видели» — то самое поле `lastSeenTs`, ради которого `DmPerson`
  // вообще отличается от `DmPeer` (см. комментарий у типа в packages/shared).
  // 0 не «сегодня в полночь», а «никогда»: presence ещё не заведён (см. README
  // референса — стор придёт этапом B), и `lastSeenTs` — единственное, что можно
  // честно сказать о собеседнике прямо сейчас.
  const seen = person.lastSeenTs
    ? t('dm.person.seen', { when: fmtSince(new Date(person.lastSeenTs).toISOString()) })
    : t('dm.person.never');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex h-[60px] w-full cursor-pointer select-none items-center gap-3 rounded-[10px] px-2 outline-none transition-colors hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <Identicon fingerprint={person.fingerprint} size={40} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-text-header">{person.nick}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
          {showFingerprints && (
            <span className="shrink-0 font-mono tracking-[0.06em] text-text-faint">
              {shortFingerprint(person.fingerprint)}
            </span>
          )}
          {showFingerprints && showLastSeen && (
            <span aria-hidden className="shrink-0 text-text-faint">
              ·
            </span>
          )}
          {showLastSeen && <span className="truncate">{seen}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Выбор собеседника — палитра-адрес нового ЛС. Десктоп: панель 330px справа
 * от сайдбара (фрейм `1b` референса). Мобилка: bottom sheet с ручкой-полоской
 * (те же классы, переключённые `max-md:`, — заводить два компонента ради
 * одной раскладки незачем).
 *
 * Список людей приходит из `dm-people` — реестра, а не из уже открытых
 * переписок (`useDmStore.conversations`): написать можно и тому, с кем ещё
 * не было ни слова. Выбор шлёт `dm-open`, кладёт беседу в `useDmStore.remember`
 * (иначе она не попала бы в список, пока сервер не пришлёт `dm-activity`) и
 * открывает её `useUiStore.openDm`.
 *
 * Кнопки «позвонить» в строке НЕТ, и это решение, а не пропуск (задача 6
 * плана B, «Дозвон»). Строка здесь — адрес НОВОЙ переписки, а не собеседник, с
 * которым уже говорят: список приходит из реестра людей целиком. Позвонить же
 * можно не всякому — `calls.whoCanCall: 'conversation'` разрешает дозвон
 * ровно тем, с кем беседа уже заведена, и кнопка в строке либо звонила бы
 * туда, где настройка это запрещает, либо стояла бы серой у половины списка,
 * объясняя посторонним, с кем у меня есть переписка. Поэтому звонок начинают
 * там, где собеседник уже назван, — в карточке `DmPeerCard`, в шапке
 * `DmThread` и в мобильной `MobileNav`; сюда приходят, чтобы написать
 * впервые, а позвонить можно и следующим движением, уже изнутри беседы. То же
 * рассуждение, что и у рейки в `Toolbar.tsx` (там — почему нет цели «Звонок»).
 */
export function PeoplePicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<DmPerson[]>([]);
  const [asked, setAsked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Номер последнего отправленного запроса. Человек печатает быстрее, чем
   * отвечает сервер, и ответы возвращаются не в том порядке, в каком уходили:
   * без этого счётчика на экране оседал бы список по половине слова (см.
   * тот же приём в stores/search.ts).
   */
  const seqRef = useRef(0);

  // Открыли — курсор сразу в поле поиска, список стерт: прошлый выбор больше
  // ни при чём. Закрыли — сбрасываем всё, чтобы следующее открытие не мигнуло
  // прежним запросом на долю секунды до первого ответа сервера.
  useEffect(() => {
    if (!open) {
      // Счётчик двигается и здесь: панель закрыли, а запрос остался в пути.
      // Без этого он вернулся бы уже при закрытой панели, прошёл проверку и
      // тихо сложил бы в список тех, кого больше не ищут, — они бы и мигнули
      // при следующем открытии. Сброс состояния сам по себе от этого не спасает:
      // ответ приходит уже после него. Так же поступает и stores/search.ts,
      // когда поле опустело.
      seqRef.current += 1;
      setQuery('');
      setPeople([]);
      setAsked(false);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  // Первый запрос (пустая строка — просто список) уходит сразу; дальше —
  // с паузой на наборе, как в поиске по истории: человек печатает наощупь,
  // и список должен идти следом за словом, а не за каждой буквой.
  useEffect(() => {
    if (!open) return;
    const delay = query.trim() ? TYPING_PAUSE_MS : 0;
    const mine = (seqRef.current += 1);
    const timer = setTimeout(() => {
      void ask<DmPeopleResult>('dm-people', query.trim() ? { query: query.trim() } : {}).then(
        (res) => {
          // Ответ мог прийти позже более свежего запроса (следующая буква,
          // очередной сброс паузой) — тогда он уже не про то, что набрано
          // сейчас, и подменять список или флаг «спрашивали» им нельзя.
          if (mine !== seqRef.current) return;
          setAsked(true);
          setPeople(res?.ok ? res.people : []);
        },
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [open, query]);

  async function choose(person: DmPerson) {
    const res = await ask<DmOpenResult>('dm-open', { fingerprint: person.fingerprint });
    if (!res?.ok) return;
    useDmStore.getState().remember(res.conversation);
    useUiStore.getState().openDm(res.conversation.slug, person.fingerprint, person.nick);
    onOpenChange(false);
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Клик мимо панели закрывает её — на телефоне это ещё и подсказка,
              что лист можно смахнуть, хотя жест здесь не ловится: тап по
              затемнению работает тем же способом, что и на десктопе. */}
          <motion.div
            key="picker-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenChange(false)}
            aria-hidden
            className="fixed inset-0 z-30 max-md:bg-black/45"
          />
          <motion.div
            key="picker-panel"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.16 }}
            role="dialog"
            aria-label={t('dm.new')}
            className={cn(
              'panel fixed z-40 flex flex-col border-line shadow-[-8px_0_24px_rgba(0,0,0,0.28)]',
              // Правый край занят рейкой тулбара (w-16) — панель встаёт
              // ВПЛОТНУЮ к ней, а не поверх: иначе она накрыла бы собой ту самую
              // кнопку «Направления», которой её и открыли.
              'md:inset-y-0 md:right-16 md:w-[330px] md:border-l md:border-r',
              'max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[75vh] max-md:rounded-t-[15px] max-md:border-t',
            )}
          >
            {/* Ручка-полоска — знак, что лист можно закрыть свайпом (только
                мобилка: на десктопе панель не листается, а выезжает и уезжает). */}
            <div aria-hidden className="hidden shrink-0 justify-center pt-2 max-md:flex">
              <span className="h-1 w-9 rounded-full bg-line-strong" />
            </div>

            <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
              <Icon name="search" className="shrink-0 text-[15px] text-text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onOpenChange(false);
                }}
                maxLength={100}
                autoComplete="off"
                placeholder={t('dm.search.placeholder')}
                className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-text outline-none placeholder:text-text-muted/70"
              />
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label={t('common.close')}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon name="x" className="text-[13px]" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {people.length === 0 && asked ? (
                <p className="px-3 py-6 text-[13px] leading-relaxed text-text-muted">
                  {t('dm.search.empty')}
                </p>
              ) : (
                people.map((person) => (
                  <PersonRow
                    key={person.fingerprint}
                    person={person}
                    onOpen={() => void choose(person)}
                  />
                ))
              )}
            </div>

            {/* Сервер режет список на DM_PEOPLE_LIMIT молча (см. dm.service.ts),
                и ровно тридцать человек не отличить от трёхсот по одному ответу.
                Подсказка не утверждает, что скрытые есть, — только что список не
                весь и стоит сузить поиск, если нужного человека не видно. */}
            {people.length === DM_PEOPLE_LIMIT && (
              <p className="shrink-0 border-t border-line px-3 py-2 text-[12px] text-text-faint">
                {t('dm.search.limited', { limit: DM_PEOPLE_LIMIT })}
              </p>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

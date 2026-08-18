'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { SearchHit, SearchScope } from '@relay/shared';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ui/icon';
import { Identicon } from '@/components/ui/Identicon';
import { fmtDayTime } from '@/lib/format';
import { excerpt, highlight } from '@/lib/search';
import { useT } from '@/lib/i18n';
import { useChannelsStore } from '@/stores/channels';
import { useSearchStore } from '@/stores/search';
import { useUiStore } from '@/stores/ui';

/**
 * Поиск по истории.
 *
 * На десктопе — колонка справа от ленты: разговор остаётся на экране, и
 * найденное читается рядом с тем местом, куда оно ведёт. На мобиле — во весь
 * экран: 375 точек нельзя поделить между лентой и результатами так, чтобы обе
 * половины остались читаемыми, и попытка кончается двумя нечитаемыми.
 *
 * Результат — не конечная точка, а дорога: строка ведёт в свой канал, к своему
 * сообщению, в его окружении. Поэтому у каждой находки написан канал (в поиске
 * по серверу их несколько) и время с датой — в ленте дату видно по её ходу, а
 * вырванная из потока строка без неё не отвечает на «когда это было».
 */

/** Пауза перед запросом: человек печатает быстрее, чем сервер успевает искать. */
const TYPING_PAUSE_MS = 280;

function HitText({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(excerpt(text, terms), terms).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded-[3px] bg-accent-strong/25 px-0.5 text-text-header">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function Hit({ hit, terms, onOpen }: { hit: SearchHit; terms: string[]; onOpen: () => void }) {
  const t = useT();
  const msg = hit.message;
  // Канал называем так же, как он подписан в сайдбаре. Слаг — это адрес, и
  // человек, читающий результаты, сверяет их со списком каналов, а не с
  // адресной строкой. Канала уже нет — остаётся слаг: он всё равно честнее,
  // чем пустое место.
  const channel = useChannelsStore((s) => s.channels.find((c) => c.slug === hit.slug));
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-[10px] border border-transparent px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-bg-hover"
    >
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <span className="truncate font-medium text-text">#{channel?.name ?? hit.slug}</span>
        <span className="shrink-0">{fmtDayTime(msg.ts)}</span>
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {msg.fingerprint ? (
          <Identicon fingerprint={msg.fingerprint} size={20} still className="mt-0.5" />
        ) : (
          <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-bg-active" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-semibold text-text-header">{msg.name}</span>
          <p className="break-words text-[13px] leading-[1.45] text-text">
            {msg.text ? <HitText text={msg.text} terms={terms} /> : t('chat.attachment')}
          </p>
        </div>
      </div>
    </button>
  );
}

export function SearchPanel() {
  const t = useT();
  const open = useSearchStore((s) => s.open);
  const query = useSearchStore((s) => s.query);
  const scope = useSearchStore((s) => s.scope);
  const hits = useSearchStore((s) => s.hits);
  const terms = useSearchStore((s) => s.terms);
  const more = useSearchStore((s) => s.more);
  const loading = useSearchStore((s) => s.loading);
  const asked = useSearchStore((s) => s.asked);
  const failed = useSearchStore((s) => s.failed);
  const textLabel = useUiStore((s) => s.textLabel);
  const inputRef = useRef<HTMLInputElement>(null);

  // Открыли — курсор сразу в поле: поиск открывают, чтобы печатать, а не чтобы
  // потом ещё раз щёлкнуть по строке ввода.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Запрос уходит на паузе в наборе, а не на каждую букву. Ждать явного Enter
  // здесь незачем: человек ищет наощупь, дописывая и стирая, и список должен
  // идти следом за словом.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void useSearchStore.getState().run(), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [open, query, scope]);

  const scopes: { id: SearchScope; label: string }[] = [
    { id: 'channel', label: t('search.scope.channel', { channel: textLabel }) },
    { id: 'server', label: t('search.scope.server') },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.16 }}
          // Панель поверх ленты, а не рядом: раздвигать колонки на время поиска
          // значило бы перекладывать разговор туда-сюда под руками у человека.
          className="panel absolute inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-line shadow-[-8px_0_24px_rgba(0,0,0,0.28)] max-md:inset-0 max-md:w-auto max-md:border-l-0"
          role="dialog"
          aria-label={t('search.title')}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
            <Icon name="search" className="shrink-0 text-[17px] text-text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => useSearchStore.getState().setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') useSearchStore.getState().setOpen(false);
              }}
              maxLength={100}
              autoComplete="off"
              placeholder={t('search.placeholder')}
              className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-text outline-none placeholder:text-text-muted/70"
            />
            <button
              type="button"
              onClick={() => useSearchStore.getState().setOpen(false)}
              aria-label={t('common.close')}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            >
              <Icon name="x" className="text-[13px]" />
            </button>
          </div>

          <div className="flex shrink-0 gap-1 border-b border-line px-3 py-2">
            {scopes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => useSearchStore.getState().setScope(s.id)}
                aria-pressed={scope === s.id}
                className={cn(
                  'truncate rounded-full px-2.5 py-1 text-[12px] transition-colors',
                  scope === s.id
                    ? 'bg-accent-strong/20 text-text-header'
                    : 'text-text-muted hover:bg-bg-hover hover:text-text',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {/* Пять состояний, и они разные: ещё не спрашивали, ищем, не
                нашлось, сервер не ответил, вот находки. Свести их к одному
                пустому месту значит на все пять вопросов промолчать. */}
            {!query.trim() ? (
              <p className="px-3 py-6 text-[13px] leading-relaxed text-text-muted">
                {t('search.hint')}
              </p>
            ) : loading && !hits.length ? (
              <p className="px-3 py-6 text-[13px] text-text-muted">{t('search.searching')}</p>
            ) : failed ? (
              <p className="px-3 py-6 text-[13px] text-text-muted">{t('search.failed')}</p>
            ) : asked && !hits.length ? (
              <p className="px-3 py-6 text-[13px] leading-relaxed text-text-muted">
                {t('search.empty', { query: query.trim() })}
              </p>
            ) : (
              <>
                <p className="px-3 py-1.5 text-[11px] uppercase tracking-[0.1em] text-text-muted">
                  {t('search.count', { count: hits.length })}
                </p>
                {hits.map((hit) => (
                  <Hit
                    key={hit.message.id ?? `${hit.slug}-${hit.message.ts}`}
                    hit={hit}
                    terms={terms}
                    onOpen={() => void useSearchStore.getState().openHit(hit)}
                  />
                ))}
                {more && (
                  <button
                    type="button"
                    onClick={() => void useSearchStore.getState().loadMore()}
                    disabled={loading}
                    className="mt-1 w-full rounded-[10px] border border-line px-3 py-2 text-[12.5px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-60"
                  >
                    {t(loading ? 'search.searching' : 'search.more')}
                  </button>
                )}
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

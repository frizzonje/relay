'use client';

import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n/translate';

/**
 * Поле ника с «@» впереди и кубиком справа — тем, что предлагает имя, когда
 * своего не придумалось. Им представляются дважды: заводя личность и входя
 * гостем по ссылке, — и выглядеть эти два входа обязаны одинаково.
 */
export function NickField({
  value,
  onChange,
  onReroll,
  placeholder,
  rerollLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Кубик: предложить имя. */
  onReroll: () => void;
  placeholder: MessageKey;
  /** Подпись кубика для читалки экрана: что именно он перебросит. */
  rerollLabel: MessageKey;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
      <span className="select-none text-lg font-bold text-text-muted">@</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(placeholder)}
        maxLength={24}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] font-semibold text-text-header outline-none placeholder:font-normal placeholder:text-text-muted/60"
      />
      <button
        type="button"
        onClick={onReroll}
        title={t('identity.reroll')}
        aria-label={t(rerollLabel)}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-base text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
      >
        🎲
      </button>
    </div>
  );
}

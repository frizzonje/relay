'use client';

import { forwardRef } from 'react';
import type { ChannelType } from '@relay/shared';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/i18n';

/**
 * Имя канала с меткой его вида впереди — «#» у текстового, динамик у
 * голосового. Им называют канал дважды, создавая и переименовывая, и поле
 * обязано выглядеть одинаково: человек должен узнать в правке то же место.
 */
export const ChannelNameField = forwardRef<
  HTMLInputElement,
  {
    id: string;
    type: ChannelType;
    value: string;
    onChange: (value: string) => void;
    maxLength: number;
    placeholder?: string;
    /** Открыть с выделенным именем: заменить целиком — обычный случай правки. */
    selectOnFocus?: boolean;
  }
>(function ChannelNameField(
  { id, type, value, onChange, maxLength, placeholder, selectOnFocus },
  ref,
) {
  const t = useT();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
      >
        {t('common.name')}
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
        {type === 'text' ? (
          <span className="text-lg leading-none text-text-muted">#</span>
        ) : (
          <Icon name="volume-2" className="text-[18px] text-text-muted" />
        )}
        <input
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus
          onFocus={selectOnFocus ? (e) => e.currentTarget.select() : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
        />
      </div>
    </div>
  );
});

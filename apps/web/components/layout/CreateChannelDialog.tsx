'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelType } from '@relay/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { createChannel } from '@/lib/channels';

const TYPES: { value: ChannelType; label: string; hint: string }[] = [
  { value: 'text', label: 'Текстовый', hint: 'Лента сообщений и файлов' },
  { value: 'voice', label: 'Голосовой', hint: 'Живой эфир: голос, видео, экран' },
];

/**
 * Модалка создания канала. Как в Discord: выбираешь тип (текст/голос), даёшь имя —
 * канал появляется у всех участников сразу (реестр на сервере). Тип предустановлен
 * по нажатому «+».
 */
export function CreateChannelDialog({
  open,
  initialType,
  onOpenChange,
}: {
  open: boolean;
  initialType: ChannelType;
  onOpenChange: (open: boolean) => void;
}) {
  const [type, setType] = useState<ChannelType>(initialType);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // При каждом открытии — чистый ввод и тип с нажатого «+».
  useEffect(() => {
    if (open) {
      setType(initialType);
      setName('');
    }
  }, [open, initialType]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createChannel(type, trimmed);
    onOpenChange(false);
  }

  const isText = type === 'text';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Создать канал</DialogTitle>
          <DialogDescription>Появится у всех участников сервера.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* Тип канала — сегмент-переключатель */}
          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted">
              Тип канала
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TYPES.map((t) => {
                const selected = type === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setType(t.value)}
                    aria-pressed={selected}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-lg border p-3 text-left outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-accent/70',
                      selected
                        ? 'border-accent/70 bg-accent/15 text-text-header'
                        : 'border-line bg-bg-rail/40 text-text-muted hover:bg-bg-hover hover:text-text',
                    )}
                  >
                    <span className="flex items-center gap-2 text-[15px] font-semibold">
                      {t.value === 'text' ? (
                        <span className="grid h-[18px] w-[18px] place-items-center text-lg leading-none text-current">
                          #
                        </span>
                      ) : (
                        <Icon name="volume-2" className="text-[18px]" />
                      )}
                      {t.label}
                    </span>
                    <span className="text-[11px] leading-tight opacity-80">{t.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Имя канала */}
          <div>
            <label
              htmlFor="channel-name"
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
            >
              Название
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
              {isText ? (
                <span className="text-lg leading-none text-text-muted">#</span>
              ) : (
                <Icon name="volume-2" className="text-[18px] text-text-muted" />
              )}
              <input
                id="channel-name"
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isText ? 'новый-канал' : 'переговорка'}
                maxLength={32}
                autoFocus
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              <Icon name="plus" /> Создать канал
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

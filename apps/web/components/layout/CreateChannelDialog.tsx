'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelType, VoiceMode } from '@relay/shared';
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
import { useSfuAvailable } from '@/lib/use-sfu';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';

const TYPES: { value: ChannelType; label: MessageKey; hint: MessageKey }[] = [
  { value: 'text', label: 'createChannel.type.text', hint: 'createChannel.type.text.hint' },
  { value: 'voice', label: 'createChannel.type.voice', hint: 'createChannel.type.voice.hint' },
];

const MODES: { value: VoiceMode; label: MessageKey; hint: MessageKey }[] = [
  { value: 'p2p', label: 'createChannel.transport.p2p', hint: 'createChannel.transport.p2p.hint' },
  { value: 'sfu', label: 'createChannel.transport.sfu', hint: 'createChannel.transport.sfu.hint' },
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
  const t = useT();
  const [type, setType] = useState<ChannelType>(initialType);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<VoiceMode>('p2p');
  const inputRef = useRef<HTMLInputElement>(null);
  const sfuAvailable = useSfuAvailable();

  // При каждом открытии — чистый ввод, тип с нажатого «+» и режим по умолчанию.
  useEffect(() => {
    if (open) {
      setType(initialType);
      setName('');
      setMode('p2p');
    }
  }, [open, initialType]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createChannel(type, trimmed, type === 'voice' ? mode : undefined);
    onOpenChange(false);
  }

  const isText = type === 'text';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('createChannel.title')}</DialogTitle>
          <DialogDescription>{t('createChannel.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* Тип канала — сегмент-переключатель */}
          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted">
              {t('createChannel.type')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TYPES.map((item) => {
                const selected = type === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setType(item.value)}
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
                      {item.value === 'text' ? (
                        <span className="grid h-[18px] w-[18px] place-items-center text-lg leading-none text-current">
                          #
                        </span>
                      ) : (
                        <Icon name="volume-2" className="text-[18px]" />
                      )}
                      {item.label}
                    </span>
                    <span className="text-[11px] leading-tight opacity-80">{item.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Как ходит медиа — только у голосовых. Через сервер держит больше
              народу с видео, но требует поднятого медиасервера. */}
          {!isText && (
            <div>
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted">
                {t('createChannel.transport')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {MODES.map((m) => {
                  const selected = mode === m.value;
                  const disabled = m.value === 'sfu' && !sfuAvailable;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setMode(m.value)}
                      disabled={disabled}
                      aria-pressed={selected}
                      title={disabled ? t('createChannel.sfu.offTitle') : undefined}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-lg border p-3 text-left outline-none transition-colors',
                        'focus-visible:ring-2 focus-visible:ring-accent/70',
                        disabled
                          ? 'cursor-not-allowed border-line bg-bg-rail/20 text-text-muted/50'
                          : selected
                            ? 'border-accent/70 bg-accent/15 text-text-header'
                            : 'border-line bg-bg-rail/40 text-text-muted hover:bg-bg-hover hover:text-text',
                      )}
                    >
                      <span className="text-[15px] font-semibold">{t(m.label)}</span>
                      <span className="text-[11px] leading-tight opacity-80">
                        {t(disabled ? 'createChannel.sfu.off' : m.hint)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Имя канала */}
          <div>
            <label
              htmlFor="channel-name"
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
            >
              {t('common.name')}
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
                placeholder={t(isText ? 'createChannel.name.text' : 'createChannel.name.voice')}
                maxLength={32}
                autoFocus
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              <Icon name="plus" /> {t('createChannel.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
import { renameChannel } from '@/lib/channels';
import { useT } from '@/lib/i18n';

export interface RenameChannelTarget {
  id: string;
  name: string;
  type: ChannelType;
}

/**
 * Переименование канала. Меняется только подпись: адрес канала (slug) остаётся
 * прежним, поэтому переписка, «непрочитано» и уже разосланные приглашения
 * переживают правку — и живой звонок в этот момент не прерывается. Об этом
 * прямо сказано в диалоге, иначе переименовывать страшно.
 */
export function RenameChannelDialog({
  target,
  onOpenChange,
}: {
  target: RenameChannelTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Каждое открытие начинается с текущего имени — его чаще правят, чем меняют.
  useEffect(() => {
    if (target) {
      setName(target.name);
      setBusy(false);
    }
  }, [target]);

  const trimmed = name.trim();
  const unchanged = trimmed === target?.name;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target || !trimmed || busy) return;
    if (unchanged) return onOpenChange(false);
    setBusy(true);
    const ok = await renameChannel(target.id, trimmed);
    setBusy(false);
    // Отказ сервера объясняет тост (lib/channels) — диалог не закрываем.
    if (ok) onOpenChange(false);
  }

  // Тип держим и на время закрытия (диалог уезжает с анимацией, а `target`
  // обнуляется сразу) — иначе значок поля моргает с «🔊» на «#».
  const lastType = useRef(target?.type);
  if (target) lastType.current = target.type;
  const isText = (target?.type ?? lastType.current) === 'text';

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('renameChannel.title')}</DialogTitle>
          <DialogDescription>{t('renameChannel.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="channel-rename"
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
                id="channel-rename"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                autoFocus
                // Открываем с выделенным именем: заменить целиком — обычный
                // случай, дописать букву — всё равно один клик.
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!trimmed || busy}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

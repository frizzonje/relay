'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Channel } from '@relay/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChannelNameField } from '@/components/layout/ChannelNameField';
import { renameChannel } from '@/lib/channels';
import { useT } from '@/lib/i18n';
import { useSetting } from '@/stores/config';

export type RenameChannelTarget = Pick<Channel, 'id' | 'name' | 'type'>;

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
  // Потолок имени берём у инсталляции (`spaces.channelNameMaxLength`), а не
  // числом: те же символы принимает сервер (registry.handlers), и жёсткая
  // тридцатидвойка здесь делала бы поле в панели обещанием, которого клиент не
  // держит.
  const nameMaxLength = useSetting<number>('spaces.channelNameMaxLength');
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
          <ChannelNameField
            id="channel-rename"
            type={isText ? 'text' : 'voice'}
            value={name}
            onChange={setName}
            maxLength={nameMaxLength}
            selectOnFocus
          />

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

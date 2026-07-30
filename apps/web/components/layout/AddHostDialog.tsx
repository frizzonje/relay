'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { hostLabel, isCurrentHost, normalizeHostUrl } from '@/lib/hosts';
import { useHostsStore } from '@/stores/hosts';
import { useRichT, useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';

/**
 * Модалка «Добавить хост»: адрес чужой инсталляции relay → иконка-вкладка в
 * рейке. Валидация та же, что в чузере десктопа: только http(s) с валидным
 * хостом, берём origin.
 */
export function AddHostDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const rt = useRichT();
  const addHost = useHostsStore((s) => s.addHost);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<MessageKey | ''>('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setLabel('');
      setError('');
    }
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const origin = normalizeHostUrl(url);
    if (!origin) {
      setError('addHost.error.format');
      return;
    }
    if (isCurrentHost(origin)) {
      setError('addHost.error.current');
      return;
    }
    addHost({ url: origin, ...(label.trim() ? { label: label.trim().slice(0, 24) } : {}) });
    onOpenChange(false);
  }

  const preview = normalizeHostUrl(url);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('addHost.title')}</DialogTitle>
          <DialogDescription>{t('addHost.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="host-url"
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
            >
              {t('addHost.address')}
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
              <input
                id="host-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError('');
                }}
                placeholder="https://relay.example.com"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 font-mono text-[14px] text-text outline-none placeholder:font-sans placeholder:text-text-muted/60"
              />
            </div>
            {error ? (
              <p className="mt-1.5 text-[12px] text-danger">{t(error)}</p>
            ) : (
              preview && (
                <p className="mt-1.5 text-[12px] text-text-muted">
                  {rt('addHost.preview', {
                    url: <span className="font-mono text-text">{preview}</span>,
                  })}
                </p>
              )
            )}
          </div>

          <div>
            <label
              htmlFor="host-label"
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
            >
              {t('addHost.label')}{' '}
              <span className="font-normal normal-case opacity-70">{t('common.optional')}</span>
            </label>
            <input
              id="host-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={preview ? hostLabel({ url: preview }) : t('addHost.label.placeholder')}
              maxLength={24}
              className="w-full rounded-lg border border-black/40 bg-bg-deep/70 px-3 py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60 focus:border-accent focus:ring-1 focus:ring-accent/60"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!url.trim()}>
              {t('addHost.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

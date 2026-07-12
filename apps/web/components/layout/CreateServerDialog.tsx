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
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { createServer, rememberServerPassword } from '@/lib/servers';
import { serverGradient, serverInitials } from '@/lib/server-visual';
import { useServersStore } from '@/stores/servers';
import { useUiStore } from '@/stores/ui';

// Быстрый выбор эмодзи-иконки. Пусто → рисуем инициалы.
// Рендерятся обесцвеченными (grayscale) — фирменный цвет даёт градиент-фон,
// а не кричащий разноцветный эмодзи-набор.
const EMOJI = [
  '🚀', '🛰️', '🌐', '🏛️', '💬', '📡', '⭐', '🔥', '🎧', '🎮',
  '🐺', '🦅', '🎭', '🌙', '👑', '🧩', '🎯', '🗿', '📷', '🐸', '🍀', '🎪',
  '🛸', '❄️', '🌪️', '🎲', '🔱', '⚡', '💡', '🎨',
];

/**
 * Модалка создания сервера (гильдии) — открывается зелёным «+» в рейке. Даёшь имя
 * и (по желанию) эмодзи-иконку, видишь живой предпросмотр плашки. После создания
 * новый сервер сразу становится активным и открывается модалка первого канала —
 * пустой сервер не бросаем (см. поток в ServerRail).
 */
export function CreateServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState('');
  // id генерируем при открытии, чтобы предпросмотр-градиент совпал с итоговым.
  const [id, setId] = useState('');

  const setActiveServer = useServersStore((s) => s.setActiveServer);
  const markUnlocked = useServersStore((s) => s.markUnlocked);
  const openCreateChannel = useUiStore((s) => s.openCreateChannel);

  useEffect(() => {
    if (open) {
      setName('');
      setEmoji(undefined);
      setPassword('');
      setId(crypto.randomUUID());
    }
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !id) return;
    const pw = password.trim();
    createServer({ id, name: trimmed, emoji, password: pw || undefined });
    // Создатель знает пароль — сразу считаем сервер разблокированным и запоминаем
    // пароль (чтобы после перезагрузки авто-разблокировать).
    if (pw) {
      rememberServerPassword(id, pw);
      markUnlocked(id);
    }
    setActiveServer(id);
    onOpenChange(false);
    // Пустой сервер сразу зовёт создать первый канал (после закрытия этой модалки).
    setTimeout(() => openCreateChannel('text'), 160);
  }

  const initials = serverInitials(name || 'Новый сервер');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Создать сервер</DialogTitle>
          <DialogDescription>
            Своя иконка в рейке, свои каналы. Появится у всех участников.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* Живой предпросмотр плашки + имя */}
          <div className="flex items-center gap-3">
            <div
              className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-bold text-white shadow-[0_4px_14px_rgba(0,0,0,0.35)] ring-1 ring-white/10"
              style={{ background: serverGradient(id || name) }}
              aria-hidden
            >
              {emoji ? <span className="grayscale text-2xl leading-none">{emoji}</span> : initials}
            </div>
            <div className="min-w-0 flex-1">
              <label
                htmlFor="server-name"
                className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
              >
                Название сервера
              </label>
              <input
                id="server-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Мой сервер"
                maxLength={32}
                autoFocus
                className="w-full rounded-lg border border-black/40 bg-bg-deep/70 px-3 py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60 focus:border-accent focus:ring-1 focus:ring-accent/60"
              />
            </div>
          </div>

          {/* Эмодзи-иконка (необязательно) */}
          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted">
              Иконка (необязательно)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI.map((e) => {
                const selected = emoji === e;
                return (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEmoji(selected ? undefined : e)}
                    aria-pressed={selected}
                    className={cn(
                      'grid h-9 w-9 place-items-center rounded-lg border text-lg outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-accent/70',
                      selected
                        ? 'border-ok/70 bg-ok/15'
                        : 'border-line bg-bg-rail/40 hover:bg-bg-hover',
                    )}
                  >
                    <span className="grayscale">{e}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Пароль (необязательно) — делает сервер закрытым */}
          <div>
            <label
              htmlFor="server-password"
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.3px] text-text-muted"
            >
              Пароль (необязательно)
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
              <span aria-hidden className="text-[15px] leading-none text-text-muted">
                🔒
              </span>
              <input
                id="server-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="без пароля — открытый сервер"
                maxLength={64}
                autoComplete="new-password"
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
              />
            </div>
            <p className="mt-1 text-[11px] leading-tight text-text-muted">
              Задашь пароль — сервер будет виден всем в рейке с замком, но зайти и увидеть
              каналы можно только по паролю.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              <Icon name="plus" /> Создать сервер
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

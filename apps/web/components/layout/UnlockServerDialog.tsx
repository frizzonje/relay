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
import { serverGradient, serverInitials } from '@/lib/server-visual';
import { unlockServer } from '@/lib/servers';
import { useServersStore } from '@/stores/servers';

/**
 * Модалка ввода пароля закрытого сервера. Открывается кликом по серверу с замком
 * (см. ServerRail). Отправляет пароль, ответ (`server-unlock-result`) обрабатывает
 * SocketProvider: успех → закрывает модалку и открывает сервер, ошибка → пишет
 * `unlockError` сюда. Управляется через servers-стор (`unlockTargetId`).
 */
export function UnlockServerDialog() {
  const servers = useServersStore((s) => s.servers);
  const targetId = useServersStore((s) => s.unlockTargetId);
  const error = useServersStore((s) => s.unlockError);
  const closeUnlock = useServersStore((s) => s.closeUnlock);

  const [password, setPassword] = useState('');
  const target = servers.find((s) => s.id === targetId);

  // Каждое открытие — чистый ввод.
  useEffect(() => {
    if (targetId) setPassword('');
  }, [targetId]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!targetId) return;
    const pw = password.trim();
    if (!pw) return;
    unlockServer(targetId, pw);
  }

  return (
    <Dialog open={!!targetId} onOpenChange={(o) => !o && closeUnlock()}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-lg font-bold text-white shadow-[0_4px_14px_rgba(0,0,0,0.35)] ring-1 ring-white/10"
              style={{ background: serverGradient(targetId || '') }}
              aria-hidden
            >
              {target?.emoji ?? serverInitials(target?.name ?? '')}
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate">🔒 {target?.name ?? 'Сервер'}</DialogTitle>
              <DialogDescription>Закрытый сервер. Введите пароль для входа.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
              <span aria-hidden className="text-[15px] leading-none text-text-muted">
                🔒
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль сервера"
                maxLength={64}
                autoFocus
                autoComplete="off"
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] text-text outline-none placeholder:text-text-muted/60"
              />
            </div>
            {error && <p className="mt-1.5 text-[13px] font-semibold text-danger">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeUnlock}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={!password.trim()}>
              Войти
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

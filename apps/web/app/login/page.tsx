'use client';

import { useRef, useState, type FormEvent } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Logo } from '@/components/ui/Logo';

/**
 * Экран входа. POST /api/login: 200 → на главную; 401 — отказ; 429 — перебор
 * попыток. Гейт перед самой страницей — apps/web/middleware.ts (verifyToken из
 * @relay/shared).
 */
export default function LoginPage() {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '';
      const r = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: pwd }),
      });
      if (r.ok) {
        window.location.replace('/');
        return;
      }
      setErr(
        r.status === 429
          ? 'Слишком много попыток. Подождите 10 минут.'
          : 'Неверный пароль.',
      );
      void shake.start({ x: [0, -8, 8, -8, 8, 0], transition: { duration: 0.4 } });
      inputRef.current?.select();
    } catch {
      setErr('Сервер не отвечает.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-5">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-[420px]"
      >
        <motion.div animate={shake} className="glass glass-2 overflow-hidden">
          <div className="flex flex-col items-center px-7 pb-6 pt-8 text-center">
            <Logo size={46} animate nodeBg="#0d0f12" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-text-header">relay</h1>

            <form onSubmit={onSubmit} className="mt-6 flex w-full flex-col gap-2.5">
              <input
                ref={inputRef}
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="Пароль"
                autoComplete="current-password"
                autoFocus
                required
                className="rounded-[10px] border border-line bg-bg-elev px-3.5 py-3 text-center font-mono text-[15px] tracking-wide text-text outline-none transition placeholder:text-text-faint focus:border-line-strong focus:ring-1 focus:ring-line-strong"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] bg-accent-strong px-3 py-3 text-[15px] font-semibold tracking-wide text-bg-app transition hover:brightness-95 active:translate-y-0.5 disabled:cursor-wait disabled:opacity-60"
              >
                Войти
              </button>
            </form>

            <div className="mt-3 min-h-[18px] text-[13px] font-semibold text-danger">{err}</div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}

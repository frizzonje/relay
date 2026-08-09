'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Logo } from '@/components/ui/Logo';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/i18n';

/**
 * Экран входа. POST /api/login: 200 → на главную; 401 — отказ; 429 — перебор
 * попыток. Гейт перед самой страницей — apps/web/middleware.ts (verifyToken из
 * @relay/shared).
 */
export default function LoginPage() {
  const t = useT();
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [caps, setCaps] = useState(false);
  // Хост берём после маунта: на сервере window нет, а гидрация должна совпасть.
  const [host, setHost] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();

  useEffect(() => setHost(window.location.host), []);

  /** Caps Lock — самая частая причина «пароль верный, но не пускает». */
  function trackCaps(e: KeyboardEvent<HTMLInputElement>) {
    setCaps(e.getModifierState('CapsLock'));
  }

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
      setErr(t(r.status === 429 ? 'login.error.rateLimited' : 'login.error.wrongPassword'));
      void shake.start({ x: [0, -8, 8, -8, 8, 0], transition: { duration: 0.4 } });
      inputRef.current?.select();
    } catch {
      setErr(t('login.error.serverSilent'));
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
          <div className="flex flex-col items-center px-7 pb-7 pt-8 text-center">
            <Logo size={46} animate nodeBg="var(--color-bg-panel)" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-text-header">relay</h1>
            {/* Какая именно инсталляция спрашивает пароль. В браузере это дублирует
                адресную строку, а в нативном клиенте её нет вовсе — там человек
                только что выбрал сервер и должен видеть, что попал куда хотел. */}
            <p className="mt-1 h-[18px] font-mono text-[12.5px] text-text-muted">{host}</p>

            <form onSubmit={onSubmit} className="mt-5 flex w-full flex-col gap-2.5">
              <div className="relative">
                <input
                  ref={inputRef}
                  type={reveal ? 'text' : 'password'}
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  onKeyDown={trackCaps}
                  onKeyUp={trackCaps}
                  onBlur={() => setCaps(false)}
                  placeholder={t('login.password.placeholder')}
                  autoComplete="current-password"
                  autoFocus
                  required
                  aria-describedby="login-msg"
                  className="w-full rounded-[10px] border border-line bg-bg-elev px-11 py-3 text-center font-mono text-[15px] tracking-wide text-text outline-none transition placeholder:text-text-faint focus:border-line-strong focus:ring-1 focus:ring-line-strong"
                />
                {/* Общий пароль инсталляции длинный и приходит из чужого чата —
                    вслепую его набирать неоткуда. onMouseDown гасим, чтобы клик
                    не уводил фокус из поля. */}
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setReveal((v) => !v)}
                  aria-label={t(reveal ? 'login.password.hide' : 'login.password.show')}
                  title={t(reveal ? 'login.password.hide' : 'login.password.show')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-text-faint transition hover:text-text focus-visible:text-text focus-visible:outline-none"
                >
                  <Icon name={reveal ? 'eye-off' : 'eye'} className="size-[18px]" />
                </button>
              </div>
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] bg-accent-strong px-3 py-3 text-[15px] font-semibold tracking-wide text-bg-app transition hover:brightness-95 active:translate-y-0.5 disabled:cursor-wait disabled:opacity-60"
              >
                {t('login.submit')}
              </button>
            </form>

            {/* Место под сообщение не резервируем: пустая строка под кнопкой
                читалась бы дырой, а появляется оно только в ответ на действие. */}
            <div id="login-msg" role="status" aria-live="polite" className="empty:hidden">
              {err && <p className="mt-3 text-[13px] font-semibold text-danger">{err}</p>}
              {!err && caps && (
                <p className="mt-3 text-[12.5px] text-text-muted">{t('login.capsLock')}</p>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}

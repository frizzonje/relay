'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { sanitizeNick } from '@relay/shared';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Identicon } from '@/components/ui/Identicon';
import { randomCallsign } from '@/lib/avatar';
import type { LoginFailure } from '@/lib/identity-login';
import { useIdentityStore } from '@/stores/identity';
import { useT, type MessageKey } from '@/lib/i18n';
import { LinkDevicePanel } from '@/components/layout/LinkDevicePanel';

/**
 * Первый вход. Регистрации нет и быть не может: личность — это ключевая пара,
 * рождённая на устройстве, и к моменту, когда человек видит это окно, он уже
 * вошёл. Спрашиваем ровно одно — как его звать.
 *
 * Второе назначение окна важнее первого: объяснить сделку. Пароля нет, значит
 * нет и восстановления; ключ лежит на этом устройстве и никуда не уезжает.
 * Человек узнаёт об этом здесь, а не в тот день, когда потеряет ноутбук.
 *
 * Беды разведены по экранам намеренно (см. `LoginFailure`): «нет WebCrypto»,
 * «приватный режим», «устройство отозвано» и «сервер не ответил» требуют от
 * человека четырёх разных действий, и общее «что-то пошло не так» не помогает
 * ни в одном из них.
 */

/** Что показать по каждой беде и есть ли смысл в кнопке. */
const FAILURES: Record<string, { title: MessageKey; body: MessageKey; retry?: boolean }> = {
  'no-crypto': { title: 'identity.fail.crypto.title', body: 'identity.fail.crypto.body' },
  'no-storage': { title: 'identity.fail.storage.title', body: 'identity.fail.storage.body' },
  shell: { title: 'identity.fail.shell.title', body: 'identity.fail.shell.body' },
  keychain: {
    title: 'identity.fail.keychain.title',
    body: 'identity.fail.keychain.body',
    retry: true,
  },
  engine: { title: 'identity.fail.engine.title', body: 'identity.fail.engine.body', retry: true },
  revoked: { title: 'identity.fail.revoked.title', body: 'identity.fail.revoked.body' },
  gate: { title: 'identity.fail.gate.title', body: 'identity.fail.gate.body' },
  network: {
    title: 'identity.fail.network.title',
    body: 'identity.fail.network.body',
    retry: true,
  },
};

function screenFor(failure: LoginFailure) {
  return FAILURES[failure.kind === 'signer' ? failure.error.reason : failure.kind];
}

export function IdentityGate() {
  const t = useT();
  const status = useIdentityStore((s) => s.status);
  const me = useIdentityStore((s) => s.me);
  const failure = useIdentityStore((s) => s.failure);
  const restore = useIdentityStore((s) => s.restore);
  const name = useIdentityStore((s) => s.name);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Второй путь с этого экрана: личность у человека уже есть, и он ставит
  // второе устройство. Спрашивать имя ему незачем — его зовут как вчера.
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    void restore();
  }, [restore]);

  // Подсказка нужна ровно один раз — когда экран имени появился. Ставить её в
  // рендере значило бы перебивать то, что человек уже печатает.
  useEffect(() => {
    if (status === 'naming') setDraft(randomCallsign());
  }, [status]);

  const clean = sanitizeNick(draft);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await name(clean);
    } finally {
      setBusy(false);
    }
  }

  const open = status === 'naming' || status === 'failed';

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-[420px] overflow-hidden p-0"
        // Непропускаемо: без имени человек уже вошёл, но экран за окном — не
        // его, пока он не назвался; а из экрана беды закрытие не лечит ничего.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {linking ? (
          <LinkDevicePanel onClose={() => setLinking(false)} />
        ) : status === 'failed' && failure ? (
          <Failure failure={failure} onRetry={() => void restore()} />
        ) : (
          <div className="px-7 pb-6 pt-6 text-center">
            {/* Лицо ключа, а не аватар по имени: имя ещё не выбрано, а ключ уже
                есть — и именно он, а не имя, отличает человека от однофамильца. */}
            <div className="mb-3 grid place-items-center">
              <motion.div
                initial={{ scale: 0.85, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 22 }}
                className="rounded-full ring-2 ring-white/15 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
              >
                <Identicon fingerprint={me?.fingerprint ?? ''} size={84} />
              </motion.div>
            </div>

            <DialogTitle className="text-xl">{t('identity.title')}</DialogTitle>
            <DialogDescription className="mx-auto mt-1.5 max-w-[300px] text-[13px] leading-relaxed">
              {t('identity.body')}
            </DialogDescription>

            {/* Отпечаток показан сразу и целиком: это единственное, чем человек
                сможет проверить себя глазами, и прятать его некуда. */}
            <p
              className="mt-2 select-all font-mono text-[11px] tracking-[0.08em] text-text-muted"
              title={t('identity.fingerprint.hint')}
            >
              {me?.fingerprint}
            </p>

            <form onSubmit={submit} className="mt-5 flex flex-col gap-2.5">
              <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
                <span className="select-none text-lg font-bold text-text-muted">@</span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('identity.nick.placeholder')}
                  maxLength={24}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] font-semibold text-text-header outline-none placeholder:font-normal placeholder:text-text-muted/60"
                />
                <button
                  type="button"
                  onClick={() => setDraft(randomCallsign())}
                  title={t('identity.reroll')}
                  aria-label={t('identity.reroll.nick')}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-base text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
                >
                  🎲
                </button>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!clean || busy}
                className="mt-1"
              >
                {t('identity.submit')}
              </Button>
            </form>

            {/* Отказ сохранить имя — не повод выкидывать человека из личности:
                он уже вошёл, и починка здесь одна — нажать ещё раз. */}
            {failure && (
              <p className="mt-2 text-[12px] leading-snug text-danger">
                {t('identity.nick.failed')}
              </p>
            )}

            {/* Человек, у которого личность уже есть, попал сюда не за именем:
                он поставил второе устройство. Ему сюда, и не искать по
                настройкам того, чего он ещё не завёл. */}
            <button
              type="button"
              onClick={() => setLinking(true)}
              className="mt-3 rounded-[8px] px-3 py-1.5 text-[12.5px] text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text"
            >
              {t('identity.haveOne')}
            </button>

            <p className="mt-3 text-[10px] leading-snug text-text-muted opacity-70">
              {t('identity.note')}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Failure({ failure, onRetry }: { failure: LoginFailure; onRetry: () => void }) {
  const t = useT();
  const screen = screenFor(failure);

  return (
    <div className="px-7 pb-6 pt-6 text-center">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-bg-deep text-2xl">
        🔑
      </div>
      <DialogTitle className="text-xl">{t(screen.title)}</DialogTitle>
      <DialogDescription className="mx-auto mt-1.5 max-w-[320px] text-[13px] leading-relaxed">
        {t(screen.body)}
      </DialogDescription>

      {screen.retry && (
        <Button variant="primary" size="lg" className="mt-5 w-full" onClick={onRetry}>
          {t('identity.retry')}
        </Button>
      )}
      {failure.kind === 'gate' && (
        <Button
          variant="primary"
          size="lg"
          className="mt-5 w-full"
          onClick={() => location.assign('/login')}
        >
          {t('identity.fail.gate.action')}
        </Button>
      )}
    </div>
  );
}

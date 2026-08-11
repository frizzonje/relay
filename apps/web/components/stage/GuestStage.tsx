'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { AudioUnlock } from '@/components/layout/AudioUnlock';
import { VideoGrid } from '@/components/stage/VideoGrid';
import { Controls } from '@/components/layout/Controls';
import { avatarStyle } from '@/lib/avatar';
import { loadTag, sanitizeTag, saveTag, suggestTag } from '@/lib/identity';
import { joinVoice, setListenOnly } from '@/lib/voice';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';
import { useT } from '@/lib/i18n';

/**
 * Гостевая сцена инвайт-ссылки: ввод имени → сразу в эфир конкретного
 * войс-канала. Реиспользует настоящий стек звонка (lib/voice + VideoGrid +
 * Controls) — форкать mesh не нужно; убраны только рейка/сайдбар/чат, которых
 * у гостя и на сервере нет (гейтвей режет всё, кроме его комнаты).
 *
 * `listen` — приглашение в канал закрытого сервера: слышать можно, говорить
 * нет. Сцена об этом честно предупреждает ДО входа (микрофон у такого гостя
 * даже не спрашивают) и подписывает эфир иначе — «слушаете».
 */
export function GuestStage({
  slug,
  label,
  exp,
  listen,
}: {
  slug: string;
  label: string;
  exp: number;
  listen: boolean;
}) {
  const t = useT();
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const status = useVoiceStore((s) => s.status);
  const kicked = useVoiceStore((s) => s.kicked);

  const [draft, setDraft] = useState('');
  const [joining, setJoining] = useState(false);
  // Побывали в эфире — выход показывает «звонок завершён», а не форму заново.
  const [wasInCall, setWasInCall] = useState(false);
  const [expired, setExpired] = useState(false);
  const inCall = voiceRoom === slug;

  useEffect(() => {
    // Своя гидрация вместо IdentityGate: сохранённый тег — сразу в поле.
    setDraft(loadTag() || suggestTag());
  }, []);

  // Права объявляем дирижёру до первого входа: с ними он не берёт микрофон.
  useEffect(() => {
    setListenOnly(listen);
  }, [listen]);

  useEffect(() => {
    if (inCall) setWasInCall(true);
  }, [inCall]);

  // Срок инвайта истёк прямо на странице — не даём вступать заново после выхода
  // (сервер новый handshake всё равно отвергнет).
  useEffect(() => {
    const ms = exp - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [exp]);

  const clean = sanitizeTag(draft);

  async function join(e?: FormEvent) {
    e?.preventDefault();
    if (!clean || joining) return;
    saveTag(clean);
    useUiStore.getState().setCallsign(clean);
    setJoining(true);
    try {
      await joinVoice(slug, label);
    } finally {
      setJoining(false);
    }
  }

  if (inCall) {
    return (
      <main className="relative z-10 flex h-dvh flex-col bg-bg-main">
        {/* Тонкая шапка вместо топбара: лого, канал, бейдж гостя */}
        <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-bg-elev ring-1 ring-inset ring-white/10">
            <Logo size={18} nodeBg="var(--color-bg-elev)" />
          </span>
          <Icon name="volume-2" className="text-[18px] text-text-muted" />
          <span className="truncate font-bold text-text-header">{label}</span>
          <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            {t('guest.badge')}
          </span>
          {/* Слушателю говорим это прямо в шапке: «микрофона нет» должно
              читаться как правило канала, а не как поломка устройства. */}
          {listen && (
            <span
              title={t('guest.listen.title')}
              className="flex items-center gap-1 rounded-full border border-line bg-bg-elev px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted"
            >
              <Icon name="headphones" className="text-[13px]" />
              {t('guest.listen.badge')}
            </span>
          )}
        </header>
        <VideoGrid />
        <Controls />
        <AudioUnlock />
      </main>
    );
  }

  return (
    <main className="relative z-10 grid min-h-dvh place-items-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="panel flex w-full max-w-[420px] flex-col items-center gap-1 rounded-2xl border border-line px-7 py-8 text-center"
      >
        <span className="mb-2 grid h-14 w-14 place-items-center rounded-2xl bg-bg-elev ring-1 ring-inset ring-white/10">
          <Logo size={32} animate nodeBg="var(--color-bg-elev)" />
        </span>

        {kicked ? (
          // Выгнали. Без обиняков и без кнопки «вернуться»: сервер её всё равно
          // не пустит, а неработающая кнопка обиднее внятного отказа.
          <>
            <h1 className="text-xl font-bold text-text-header">{t('guest.kicked.title')}</h1>
            <p className="mt-1 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
              {t('guest.kicked.body', { channel: label })}
            </p>
          </>
        ) : wasInCall ? (
          <>
            <h1 className="text-xl font-bold text-text-header">{t('guest.ended.title')}</h1>
            <p className="mt-1 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
              {t('guest.ended.body', { channel: label })}{' '}
              {t(expired ? 'guest.ended.expired' : 'guest.ended.canReturn')}
            </p>
            {!expired && (
              <Button
                variant="primary"
                size="lg"
                className="mt-4 w-full"
                disabled={joining}
                onClick={() => void join()}
              >
                <Icon name="volume-2" /> {t('guest.rejoin')}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">
              {t('guest.invite.kicker')}
            </p>
            <h1 className="mt-0.5 flex items-center gap-2 text-xl font-bold text-text-header">
              <Icon name="volume-2" className="text-[20px] text-text-muted" />
              {label}
            </h1>
            <p className="mt-1 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
              {t(listen ? 'guest.invite.body.listen' : 'guest.invite.body')}
            </p>

            {/* Живой предпросмотр аватара по тегу (как в IdentityGate) */}
            <motion.div
              key={avatarStyle(clean || '?').background as string}
              initial={{ scale: 0.85, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22 }}
              className="mt-4 h-14 w-14 rounded-full ring-2 ring-white/15 shadow-[0_6px_18px_rgba(0,0,0,0.45)]"
              style={avatarStyle(clean || '?')}
            />

            <form onSubmit={join} className="mt-4 flex w-full flex-col gap-2.5">
              <div className="flex items-center gap-2 rounded-lg border border-black/40 bg-bg-deep/70 px-3 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/60">
                <span className="select-none text-lg font-bold text-text-muted">@</span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('guest.name.placeholder')}
                  maxLength={24}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] font-semibold text-text-header outline-none placeholder:font-normal placeholder:text-text-muted/60"
                />
                <button
                  type="button"
                  onClick={() => setDraft(suggestTag())}
                  title={t('identity.reroll')}
                  aria-label={t('guest.reroll.name')}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-base text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
                >
                  🎲
                </button>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!clean || joining || expired}
              >
                {t(joining ? 'guest.join.busy' : 'guest.join')}
              </Button>
            </form>

            {/* Отказ в микрофоне / прочие сбои joinVoice — его статус + повтор.
                Слушателя это не касается: микрофон у него не спрашивают. */}
            {!joining && !listen && status?.key === 'voice.status.micDenied' && (
              <p className="mt-2 text-[12px] leading-snug text-danger">{t('guest.mic.denied')}</p>
            )}
            {expired && (
              <p className="mt-2 text-[12px] leading-snug text-danger">{t('guest.expired')}</p>
            )}

            <p className="mt-3 text-[10px] leading-snug text-text-muted opacity-70">
              {t(listen ? 'guest.listen.note' : 'guest.mic.note')}
            </p>
          </>
        )}
      </motion.div>
    </main>
  );
}

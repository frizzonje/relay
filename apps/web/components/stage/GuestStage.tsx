'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Logo } from '@/components/ui/Logo';
import { AudioUnlock } from '@/components/layout/AudioUnlock';
import { VideoGrid } from '@/components/stage/VideoGrid';
import { Controls } from '@/components/layout/Controls';
import { avatarStyle } from '@/lib/avatar';
import { loadTag, sanitizeTag, saveTag, suggestTag } from '@/lib/identity';
import { joinVoice } from '@/lib/voice';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';

/**
 * Гостевая сцена инвайт-ссылки: ввод имени → сразу в эфир конкретного
 * войс-канала. Реиспользует настоящий стек звонка (lib/voice + VideoGrid +
 * Controls) — форкать mesh не нужно; убраны только рейка/сайдбар/чат, которых
 * у гостя и на сервере нет (гейтвей режет всё, кроме его комнаты).
 */
export function GuestStage({ slug, label, exp }: { slug: string; label: string; exp: number }) {
  const voiceRoom = useUiStore((s) => s.voiceRoom);
  const status = useVoiceStore((s) => s.status);

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
    const t = setTimeout(() => setExpired(true), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
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
            <Logo size={18} nodeBg="#111418" />
          </span>
          <Icon name="volume-2" className="text-[18px] text-text-muted" />
          <span className="truncate font-bold text-text-header">{label}</span>
          <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            гостевой доступ
          </span>
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
          <Logo size={32} animate nodeBg="#111418" />
        </span>

        {wasInCall ? (
          <>
            <h1 className="text-xl font-bold text-text-header">Звонок завершён</h1>
            <p className="mt-1 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
              Вы вышли из канала «{label}».
              {expired
                ? ' Срок приглашения истёк — для возвращения попросите новую ссылку.'
                : ' По этой же ссылке можно вернуться, пока приглашение действует.'}
            </p>
            {!expired && (
              <Button
                variant="primary"
                size="lg"
                className="mt-4 w-full"
                disabled={joining}
                onClick={() => void join()}
              >
                <Icon name="volume-2" /> Вернуться в звонок
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted">
              Приглашение в голосовой канал
            </p>
            <h1 className="mt-0.5 flex items-center gap-2 text-xl font-bold text-text-header">
              <Icon name="volume-2" className="text-[20px] text-text-muted" />
              {label}
            </h1>
            <p className="mt-1 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
              Представьтесь — и вы сразу в эфире. Гостевой доступ действует только для этого
              канала.
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
                  placeholder="ваше имя"
                  maxLength={24}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-[15px] font-semibold text-text-header outline-none placeholder:font-normal placeholder:text-text-muted/60"
                />
                <button
                  type="button"
                  onClick={() => setDraft(suggestTag())}
                  title="Другой вариант"
                  aria-label="Сгенерировать другое имя"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-base text-text-muted outline-none transition-colors hover:bg-bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
                >
                  🎲
                </button>
              </div>

              <Button type="submit" variant="primary" size="lg" disabled={!clean || joining || expired}>
                {joining ? 'Подключаем…' : 'Присоединиться к звонку'}
              </Button>
            </form>

            {/* Отказ в микрофоне / прочие сбои joinVoice — его статус + повтор */}
            {!joining && status.startsWith('Нет доступа') && (
              <p className="mt-2 text-[12px] leading-snug text-danger">
                {status}. Разрешите доступ к микрофону в браузере и попробуйте снова.
              </p>
            )}
            {expired && (
              <p className="mt-2 text-[12px] leading-snug text-danger">
                Срок приглашения истёк — попросите новую ссылку.
              </p>
            )}

            <p className="mt-3 text-[10px] leading-snug text-text-muted opacity-70">
              Браузер спросит доступ к микрофону — без него в эфир не попасть.
            </p>
          </>
        )}
      </motion.div>
    </main>
  );
}

'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';
import { useVoiceStore } from '@/stores/voice';
import {
  toggleMic,
  toggleCamera,
  toggleScreen,
  setScreenMode,
  leaveVoice,
  setMic,
  setMicThreshold,
  getMicLevel,
  refreshMics,
  toggleSpeakers,
  setSpeaker,
  refreshSpeakers,
} from '@/lib/voice';

function CtlBtn({
  title,
  icon,
  off,
  live,
  hangup,
  onClick,
}: {
  title: string;
  icon: IconName;
  off?: boolean;
  live?: boolean;
  hangup?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'grid h-10 w-10 place-items-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
        'bg-bg-active text-text hover:bg-line-strong',
        off && '!bg-accent-strong !text-bg-app hover:!brightness-95',
        live && '!bg-ok !text-bg-app hover:!brightness-95',
        hangup && '!bg-danger !text-white hover:!brightness-110',
      )}
    >
      <Icon name={icon} className="text-[18px]" />
    </button>
  );
}

/**
 * Кнопка микрофона с кареткой: сам тумблер вкл/выкл + маленькая «▲» снизу,
 * открывающая список микрофонов. Выбор горячо подменяет дорожку у всех
 * собеседников (lib/voice.setMic) и запоминается в localStorage.
 */
function MicControl({ micOn }: { micOn: boolean }) {
  const mics = useVoiceStore((s) => s.mics);
  const currentMicId = useVoiceStore((s) => s.currentMicId);
  const currentMicLabel = useVoiceStore((s) => s.currentMicLabel);
  const micThreshold = useVoiceStore((s) => s.micThreshold);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thrPct = Math.round(micThreshold * 100);

  // Живой метр уровня микрофона (как в Discord). Крутим rAF только пока меню
  // открыто и пишем ширину/цвет заливки прямо в DOM — без ре-рендера на кадр.
  // Заливка зелёная, когда уровень выше порога (микрофон открыт = тебя слышно),
  // и приглушённая, когда ниже (гейт закрыт). Порог читаем из стора на лету.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let shown = 0; // сглаживание: быстрый подъём, плавный спад — как у VU-метра
    const tick = () => {
      const lvl = getMicLevel(); // 0..1 в шкале метра
      shown = lvl > shown ? lvl : shown + (lvl - shown) * 0.25;
      const thr = useVoiceStore.getState().micThreshold;
      const el = fillRef.current;
      if (el) {
        el.style.width = `${shown * 100}%`;
        // выше порога — открыто (зелёный), иначе приглушённый серо-синий
        el.style.background = shown >= thr && (thr > 0 || shown > 0.12) ? '#23a55a' : '#4e5d7a';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggleMenu(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) refreshMics(); // перечитываем список на каждом открытии
  }

  return (
    <div ref={wrapRef} className="relative">
      <CtlBtn
        title={`Микрофон${currentMicLabel ? ': ' + currentMicLabel : ''}`}
        icon={micOn ? 'mic' : 'mic-off'}
        off={!micOn}
        onClick={toggleMic}
      />
      <button
        type="button"
        title="Выбрать микрофон"
        aria-label="Выбрать микрофон"
        aria-expanded={open}
        onClick={toggleMenu}
        className="absolute -bottom-1 -right-1 grid h-[17px] w-[17px] place-items-center rounded-full bg-bg-elev text-text outline-none ring-2 ring-bg-main transition hover:bg-line-strong focus-visible:ring-2 focus-visible:ring-line-strong active:scale-90"
      >
        <Icon name="chevron-up" className="text-[11px]" />
      </button>

      {open && (
        <div className="absolute bottom-[52px] left-1/2 z-20 max-h-[50vh] w-72 -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-bg-panel/95 p-1.5 shadow-[0_16px_50px_rgba(0,0,0,0.65)] backdrop-blur">
          <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-text-muted">
            Микрофон
          </div>
          {mics.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-text-muted">
              Устройства появятся после выдачи доступа.
            </div>
          ) : (
            mics.map((m, i) => {
              const active = m.deviceId === currentMicId;
              return (
                <button
                  key={m.deviceId || i}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    if (!active) void setMic(m.deviceId);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-white outline-none transition hover:bg-white/10 focus-visible:bg-white/10',
                    active && 'bg-white/[0.06]',
                  )}
                >
                  <Icon
                    name="mic"
                    className={cn('h-4 w-4 shrink-0', active ? 'text-ok' : 'text-text-muted')}
                  />
                  <span className="flex-1 truncate">{m.label || `Микрофон ${i + 1}`}</span>
                  {active && <span className="shrink-0 text-ok">✓</span>}
                </button>
              );
            })
          )}

          {/* Порог срабатывания микрофона — шумовой гейт, как в Discord. Тихий
              блок в подвале меню. Полоска — живой уровень микрофона; белая метка —
              порог (тяни её или кликай по полоске). Уровень выше метки = микрофон
              открыт, тебя слышно (заливка зеленеет). Метка слева = слышно всегда. */}
          <div className="mt-1 border-t border-white/10 px-2.5 pb-2 pt-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-text-muted">
                Порог микрофона
              </span>
              <span
                className={cn(
                  'text-[11px] font-semibold tabular-nums',
                  thrPct === 0 ? 'text-text-muted' : 'text-ok',
                )}
              >
                {thrPct === 0 ? 'выкл' : `${thrPct}%`}
              </span>
            </div>

            <div className="relative h-2.5 w-full rounded-full bg-black/45">
              {/* живой уровень микрофона (ширину/цвет гонит rAF) */}
              <div
                ref={fillRef}
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: '0%', background: '#4e5d7a' }}
              />
              {/* метка порога */}
              <div
                className="pointer-events-none absolute inset-y-[-2px] z-[1] w-[3px] -translate-x-1/2 rounded-full bg-white shadow-[0_0_4px_rgba(0,0,0,0.65)]"
                style={{ left: `${thrPct}%` }}
              />
              {/* прозрачный range поверх — задаёт порог кликом/перетаскиванием/клавишами */}
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={thrPct}
                aria-label="Порог срабатывания микрофона"
                onChange={(e) => setMicThreshold(Number(e.target.value) / 100)}
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-0 z-[2] m-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>

            <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
              {thrPct === 0
                ? 'Слышно всегда. Тяни метку вправо — микрофон откроется, только когда говоришь.'
                : 'Микрофон открывается, когда полоска доходит до метки.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Кнопка динамиков с кареткой: тумблер мута всех звуков сайта + маленькая «▲»
 * для выбора устройства вывода. Аналог MicControl для входящего аудио.
 */
function SpeakerControl({ speakersOn }: { speakersOn: boolean }) {
  const speakers = useVoiceStore((s) => s.speakers);
  const currentSpeakerId = useVoiceStore((s) => s.currentSpeakerId);
  const currentSpeakerLabel = useVoiceStore((s) => s.currentSpeakerLabel);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggleMenu(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) refreshSpeakers();
  }

  return (
    <div ref={wrapRef} className="relative">
      <CtlBtn
        title={
          (speakersOn ? 'Выключить звук (микрофон выключится тоже)' : 'Включить звук') +
          (currentSpeakerLabel ? ' · ' + currentSpeakerLabel : '')
        }
        icon={speakersOn ? 'headphones' : 'headphone-off'}
        off={!speakersOn}
        onClick={toggleSpeakers}
      />
      <button
        type="button"
        title="Выбрать устройство воспроизведения"
        aria-label="Выбрать устройство воспроизведения"
        aria-expanded={open}
        onClick={toggleMenu}
        className="absolute -bottom-1 -right-1 grid h-[17px] w-[17px] place-items-center rounded-full bg-bg-elev text-text outline-none ring-2 ring-bg-main transition hover:bg-line-strong focus-visible:ring-2 focus-visible:ring-line-strong active:scale-90"
      >
        <Icon name="chevron-up" className="text-[11px]" />
      </button>

      {open && (
        <div className="absolute bottom-[52px] left-1/2 z-20 max-h-[50vh] w-72 -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-bg-panel/95 p-1.5 shadow-[0_16px_50px_rgba(0,0,0,0.65)] backdrop-blur">
          <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-text-muted">
            Устройство воспроизведения
          </div>
          {speakers.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-text-muted">
              Устройства появятся после выдачи доступа.
            </div>
          ) : (
            speakers.map((sp, i) => {
              const active = currentSpeakerId
                ? sp.deviceId === currentSpeakerId
                : sp.deviceId === 'default' || sp.deviceId === '';
              return (
                <button
                  key={sp.deviceId || i}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    if (!active) void setSpeaker(sp.deviceId);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-white outline-none transition hover:bg-white/10 focus-visible:bg-white/10',
                    active && 'bg-white/[0.06]',
                  )}
                >
                  <Icon
                    name="volume-2"
                    className={cn('h-4 w-4 shrink-0', active ? 'text-ok' : 'text-text-muted')}
                  />
                  <span className="flex-1 truncate">{sp.label || `Динамики ${i + 1}`}</span>
                  {active && <span className="shrink-0 text-ok">✓</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function SegToggle({ children }: { children: ReactNode }) {
  return (
    <div
      title="Что беречь при слабом канале: чёткость картинки или плавность кадров"
      className="flex animate-seg-pop items-center gap-0.5 self-center rounded-[27px] border border-white/[0.08] bg-black/[0.28] p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
    >
      {children}
    </div>
  );
}

/**
 * Панель управления звонком (#controls, index.html:1581-1590). Видна в голосовом
 * виде: микрофон, камера, демонстрация экрана (+тумблер Качество/ФПС во время
 * трансляции), отключение. Всё завязано на mesh-менеджер (lib/voice.ts).
 */
export function Controls() {
  const view = useUiStore((s) => s.view);
  const micOn = useVoiceStore((s) => s.micOn);
  const camOn = useVoiceStore((s) => s.camOn);
  const screenOn = useVoiceStore((s) => s.screenOn);
  const screenMode = useVoiceStore((s) => s.screenMode);
  const speakersOn = useVoiceStore((s) => s.speakersOn);
  const ping = useVoiceStore((s) => s.ping);

  if (view !== 'voice') return null;

  return (
    <div className="relative flex h-16 shrink-0 items-center justify-center gap-2 border-t border-line bg-bg-main px-4">
      {/* Слева: живой эквалайзер «я говорю» + RTT-метка (раздел 02 референса) */}
      <div className="pointer-events-none absolute left-4 flex items-center gap-3">
        {micOn && (
          <div className="flex h-4 items-end gap-[3px]" aria-hidden>
            {[0.5, 0.34, 0.62].map((d, i) => (
              <span
                key={i}
                className="h-1 w-[3px] rounded-full bg-ok"
                style={{ transformOrigin: 'bottom', animation: `eq ${d}s ease-in-out infinite alternate` }}
              />
            ))}
          </div>
        )}
        {!ping.waiting && ping.ms != null && (
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              ping.grade === 'good' && 'text-text-muted',
              ping.grade === 'mid' && 'text-[#d8a32a]',
              ping.grade === 'bad' && 'text-danger',
            )}
          >
            {ping.ms} ms
          </span>
        )}
      </div>
      <MicControl micOn={micOn} />
      <SpeakerControl speakersOn={speakersOn} />
      <CtlBtn
        title={
          camOn ? 'Выключить камеру' : 'Включить камеру (браузер спросит разрешение только сейчас)'
        }
        icon={camOn ? 'video' : 'video-off'}
        off={!camOn}
        onClick={() => void toggleCamera()}
      />
      <CtlBtn
        title={screenOn ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}
        icon={screenOn ? 'screen-share-off' : 'screen-share'}
        live={screenOn}
        onClick={() => void toggleScreen()}
      />
      {screenOn && (
        <SegToggle>
          {(['quality', 'fps'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={screenMode === mode}
              onClick={() => setScreenMode(mode)}
              className={cn(
                'rounded-[23px] px-4 py-[9px] text-xs font-bold uppercase tracking-[0.04em] text-text-muted outline-none transition hover:text-text-header focus-visible:ring-2 focus-visible:ring-line-strong active:scale-[0.94]',
                screenMode === mode &&
                  '!bg-accent-strong !text-bg-app shadow-[0_1px_4px_rgba(0,0,0,0.35)]',
              )}
            >
              {mode === 'quality' ? 'Качество' : 'ФПС'}
            </button>
          ))}
        </SegToggle>
      )}
      <span className="mx-1 h-6 w-px bg-line-strong" />
      <CtlBtn title="Отключиться" icon="phone-off" hangup onClick={() => leaveVoice()} />
    </div>
  );
}

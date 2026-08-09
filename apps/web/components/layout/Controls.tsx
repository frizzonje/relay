'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { springTab } from '@/lib/motion';
import { useDismiss } from '@/lib/use-dismiss';
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
import { useT } from '@/lib/i18n';

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
 * Кнопка с кареткой: сам тумблер (микрофон, динамики) плюс маленькая «▲» снизу,
 * открывающая меню устройств. Одна обёртка на оба контрола — у них совпадало
 * всё, кроме подписей и содержимого меню.
 *
 * `onOpen` дёргается на каждом раскрытии: список устройств браузер обновляет
 * лениво, и метки появляются только после выданного доступа.
 */
function DeviceMenu({
  title,
  icon,
  off,
  onToggle,
  pickLabel,
  menuTitle,
  onOpen,
  children,
}: {
  title: string;
  icon: IconName;
  off: boolean;
  onToggle: () => void;
  pickLabel: string;
  menuTitle: string;
  onOpen: () => void;
  /** Содержимое меню; `close` закрывает его после выбора. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrapRef);

  return (
    <div ref={wrapRef} className="relative">
      <CtlBtn title={title} icon={icon} off={off} onClick={onToggle} />
      <button
        type="button"
        title={pickLabel}
        aria-label={pickLabel}
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen((o) => !o);
        }}
        className="absolute -bottom-1 -right-1 grid h-[17px] w-[17px] place-items-center rounded-full bg-bg-elev text-text outline-none ring-2 ring-bg-main transition hover:bg-line-strong focus-visible:ring-2 focus-visible:ring-line-strong active:scale-90"
      >
        <Icon name="chevron-up" className="text-[11px]" />
      </button>

      {open && (
        <div className="absolute bottom-[52px] left-1/2 z-20 max-h-[50vh] w-72 -translate-x-1/2 overflow-y-auto rounded-xl border border-line bg-bg-panel/95 p-1.5 shadow-[0_16px_50px_rgba(0,0,0,0.65)] backdrop-blur">
          <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-text-muted">
            {menuTitle}
          </div>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** Список устройств в меню: галочка у активного, запасная подпись у безымянных. */
function DeviceList({
  devices,
  icon,
  isActive,
  numbered,
  onPick,
}: {
  devices: MediaDeviceInfo[];
  icon: IconName;
  isActive: (device: MediaDeviceInfo) => boolean;
  /** Подпись устройства, у которого браузер не отдал метку (нет доступа). */
  numbered: (n: number) => string;
  onPick: (deviceId: string) => void;
}) {
  const t = useT();
  if (devices.length === 0)
    return <div className="px-2.5 py-2 text-xs text-text-muted">{t('controls.devices.empty')}</div>;
  return devices.map((device, i) => {
    const active = isActive(device);
    return (
      <button
        key={device.deviceId || i}
        type="button"
        onClick={() => !active && onPick(device.deviceId)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-text outline-none transition hover:bg-white/10 focus-visible:bg-white/10',
          active && 'bg-bg-active',
        )}
      >
        <Icon
          name={icon}
          className={cn('h-4 w-4 shrink-0', active ? 'text-ok' : 'text-text-muted')}
        />
        <span className="flex-1 truncate">{device.label || numbered(i + 1)}</span>
        {active && <span className="shrink-0 text-ok">✓</span>}
      </button>
    );
  });
}

/**
 * Порог срабатывания микрофона — шумовой гейт, как в Discord. Тихий блок в
 * подвале меню микрофона. Полоска — живой уровень микрофона; белая метка —
 * порог (тяни её или кликай по полоске). Уровень выше метки = микрофон открыт,
 * тебя слышно (заливка зеленеет). Метка слева = слышно всегда.
 */
function MicThreshold() {
  const t = useT();
  const micThreshold = useVoiceStore((s) => s.micThreshold);
  const fillRef = useRef<HTMLDivElement>(null);
  const thrPct = Math.round(micThreshold * 100);

  // Живой метр: крутим rAF, пока блок на экране, и пишем ширину прямо в DOM —
  // кадр без ре-рендера. Порог читаем из стора на лету, состояние гейта отдаём
  // классом (цвета — у .mic-meter в globals.css).
  useEffect(() => {
    let raf = 0;
    let shown = 0; // сглаживание: быстрый подъём, плавный спад — как у VU-метра
    const tick = () => {
      const lvl = getMicLevel(); // 0..1 в шкале метра
      shown = lvl > shown ? lvl : shown + (lvl - shown) * 0.25;
      const thr = useVoiceStore.getState().micThreshold;
      const el = fillRef.current;
      if (el) {
        el.style.width = `${shown * 100}%`;
        el.classList.toggle('is-open', shown >= thr && (thr > 0 || shown > 0.12));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="mt-1 border-t border-line-strong px-2.5 pb-2 pt-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-text-muted">
          {t('controls.threshold')}
        </span>
        <span
          className={cn(
            'text-[11px] font-semibold tabular-nums',
            thrPct === 0 ? 'text-text-muted' : 'text-ok',
          )}
        >
          {thrPct === 0 ? t('controls.threshold.off') : `${thrPct}%`}
        </span>
      </div>

      <div className="relative h-2.5 w-full rounded-full bg-black/45">
        {/* живой уровень микрофона (ширину гонит rAF) */}
        <div ref={fillRef} className="mic-meter absolute inset-y-0 left-0 rounded-full" />
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
          aria-label={t('controls.threshold.aria')}
          onChange={(e) => setMicThreshold(Number(e.target.value) / 100)}
          className="absolute inset-0 z-[2] m-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-text-muted">
        {t(thrPct === 0 ? 'controls.threshold.hint.off' : 'controls.threshold.hint.on')}
      </p>
    </div>
  );
}

/**
 * Микрофон: тумблер вкл/выкл, выбор устройства и порог гейта. Выбор горячо
 * подменяет дорожку у всех собеседников (lib/voice.setMic) и запоминается.
 */
function MicControl({ micOn }: { micOn: boolean }) {
  const t = useT();
  const mics = useVoiceStore((s) => s.mics);
  const currentMicId = useVoiceStore((s) => s.currentMicId);
  const currentMicLabel = useVoiceStore((s) => s.currentMicLabel);

  return (
    <DeviceMenu
      title={
        currentMicLabel ? t('controls.mic.named', { device: currentMicLabel }) : t('controls.mic')
      }
      icon={micOn ? 'mic' : 'mic-off'}
      off={!micOn}
      onToggle={toggleMic}
      pickLabel={t('controls.mic.pick')}
      menuTitle={t('controls.mic')}
      onOpen={refreshMics}
    >
      {(close) => (
        <>
          <DeviceList
            devices={mics}
            icon="mic"
            isActive={(m) => m.deviceId === currentMicId}
            numbered={(n) => t('controls.mic.numbered', { n })}
            onPick={(id) => {
              close();
              void setMic(id);
            }}
          />
          <MicThreshold />
        </>
      )}
    </DeviceMenu>
  );
}

/**
 * Динамики: тумблер мута всех звуков сайта и выбор устройства вывода.
 * Аналог MicControl для входящего аудио.
 */
function SpeakerControl({ speakersOn }: { speakersOn: boolean }) {
  const t = useT();
  const speakers = useVoiceStore((s) => s.speakers);
  const currentSpeakerId = useVoiceStore((s) => s.currentSpeakerId);
  const currentSpeakerLabel = useVoiceStore((s) => s.currentSpeakerLabel);

  return (
    <DeviceMenu
      title={
        t(speakersOn ? 'controls.speakers.off' : 'controls.speakers.on') +
        (currentSpeakerLabel ? ' · ' + currentSpeakerLabel : '')
      }
      icon={speakersOn ? 'headphones' : 'headphone-off'}
      off={!speakersOn}
      onToggle={toggleSpeakers}
      pickLabel={t('controls.speakers.pick')}
      menuTitle={t('controls.speakers.title')}
      onOpen={refreshSpeakers}
    >
      {(close) => (
        <DeviceList
          devices={speakers}
          icon="volume-2"
          // Пустой выбор — системный по умолчанию: он и подсвечен.
          isActive={(sp) =>
            currentSpeakerId
              ? sp.deviceId === currentSpeakerId
              : sp.deviceId === 'default' || sp.deviceId === ''
          }
          numbered={(n) => t('controls.speakers.numbered', { n })}
          onPick={(id) => {
            close();
            void setSpeaker(id);
          }}
        />
      )}
    </DeviceMenu>
  );
}

function SegToggle({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div
      title={t('controls.screen.mode')}
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
  const t = useT();
  const view = useUiStore((s) => s.view);
  const micOn = useVoiceStore((s) => s.micOn);
  const camOn = useVoiceStore((s) => s.camOn);
  const screenOn = useVoiceStore((s) => s.screenOn);
  const screenMode = useVoiceStore((s) => s.screenMode);
  const speakersOn = useVoiceStore((s) => s.speakersOn);
  const ping = useVoiceStore((s) => s.ping);

  if (view !== 'voice') return null;

  return (
    <div className="relative flex h-16 shrink-0 items-center justify-center gap-2 border-t border-line bg-bg-main px-4 max-md:h-auto max-md:py-2.5 max-md:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      {/* Слева: живой эквалайзер «я говорю» + RTT-метка (раздел 02 референса) */}
      <div className="pointer-events-none absolute left-4 flex items-center gap-3">
        {micOn && (
          <div className="flex h-4 items-end gap-[3px]" aria-hidden>
            {[0.5, 0.34, 0.62].map((d, i) => (
              <span
                key={i}
                className="h-1 w-[3px] rounded-full bg-ok"
                style={{
                  transformOrigin: 'bottom',
                  animation: `eq ${d}s ease-in-out infinite alternate`,
                }}
              />
            ))}
          </div>
        )}
        {!ping.waiting && ping.ms != null && (
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              ping.grade === 'good' && 'text-text-muted',
              ping.grade === 'mid' && 'text-warn',
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
        title={t(camOn ? 'controls.cam.off' : 'controls.cam.on')}
        icon={camOn ? 'video' : 'video-off'}
        off={!camOn}
        onClick={() => void toggleCamera()}
      />
      <CtlBtn
        title={t(screenOn ? 'controls.screen.stop' : 'controls.screen.start')}
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
                'relative rounded-[23px] px-4 py-[9px] text-xs font-bold uppercase tracking-[0.04em] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong active:scale-[0.94]',
                screenMode === mode ? 'text-bg-app' : 'text-text-muted hover:text-text-header',
              )}
            >
              {/* Подложка выбранного режима переезжает между половинками */}
              {screenMode === mode && (
                <motion.span
                  layoutId="screen-mode"
                  transition={springTab}
                  className="absolute inset-0 rounded-[23px] bg-accent-strong shadow-[0_1px_4px_rgba(0,0,0,0.35)]"
                />
              )}
              <span className="relative">
                {t(mode === 'quality' ? 'controls.screen.quality' : 'controls.screen.fps')}
              </span>
            </button>
          ))}
        </SegToggle>
      )}
      <span className="mx-1 h-6 w-px bg-line-strong" />
      <CtlBtn title={t('voice.leave')} icon="phone-off" hangup onClick={() => leaveVoice()} />
    </div>
  );
}

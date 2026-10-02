'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { springTab } from '@/lib/motion';
import { useT, type MessageKey } from '@/lib/i18n';
import { useVoiceStore } from '@/stores/voice';
import { useSetting } from '@/stores/config';
import { setScreenMode, setScreenMotion, setScreenQuality } from '@/lib/voice';
import {
  DEFAULT_MOTION_PRESET,
  DEFAULT_QUALITY_PRESET,
  MOTION_PRESETS,
  QUALITY_PRESETS,
  presetSpec,
  type ScreenMode,
  type ScreenPreset,
} from '@/lib/voice/screen-profile';

/**
 * Вкладка «Трансляция»: с чем стример выходит в эфир.
 *
 * Режим — это задача (текст или движение), пресет — сколько под неё не жалко
 * аплинка и процессора. Выбор живёт в браузере и применяется к идущей
 * трансляции сразу, без перезапуска показа. Потолок владельца главнее:
 * пресет выше него не прячем, а честно говорим, до чего его урежут.
 */

const MODES: { id: ScreenMode; title: MessageKey; hint: MessageKey }[] = [
  {
    id: 'quality',
    title: 'settings.stream.mode.quality',
    hint: 'settings.stream.mode.quality.hint',
  },
  { id: 'fps', title: 'settings.stream.mode.fps', hint: 'settings.stream.mode.fps.hint' },
];

const PRESET_HINTS: Record<ScreenPreset, MessageKey> = {
  '1440p30': 'settings.stream.preset.1440p30.hint',
  '1440p45': 'settings.stream.preset.1440p45.hint',
  '1080p30': 'settings.stream.preset.1080p30.hint',
  '1080p60': 'settings.stream.preset.1080p60.hint',
  '720p60': 'settings.stream.preset.720p60.hint',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-text-faint">
      {children}
    </div>
  );
}

/** Отметка выбора — та же точка-в-кольце, что у радио, но в нашей палитре. */
function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors',
        on ? 'border-accent-strong' : 'border-line-strong',
      )}
    >
      {on && <span className="h-2 w-2 rounded-full bg-accent-strong animate-seg-pop" />}
    </span>
  );
}

function ModePicker() {
  const t = useT();
  const mode = useVoiceStore((s) => s.screenMode);
  return (
    <div
      role="radiogroup"
      aria-label={t('settings.stream.mode')}
      className="grid grid-cols-2 gap-2 max-sm:grid-cols-1"
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          onClick={() => setScreenMode(m.id)}
          className={cn(
            'relative rounded-[10px] border px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
            mode === m.id
              ? 'border-line-strong text-text-header'
              : 'border-line bg-bg-elev/60 text-text hover:bg-bg-hover',
          )}
        >
          {/* Подложка выбранного режима переезжает, как у тумблера в панели звонка. */}
          {mode === m.id && (
            <motion.span
              layoutId="stream-mode"
              transition={springTab}
              className="absolute inset-0 rounded-[10px] bg-bg-active"
            />
          )}
          <span className="relative block text-[14px] font-semibold">{t(m.title)}</span>
          <span className="relative mt-0.5 block text-[12px] text-text-muted">{t(m.hint)}</span>
        </button>
      ))}
    </div>
  );
}

function PresetList<P extends ScreenPreset>({
  label,
  presets,
  value,
  fallback,
  onPick,
  cap,
}: {
  label: string;
  presets: readonly P[];
  value: P;
  fallback: P;
  onPick: (preset: P) => void;
  cap: number;
}) {
  const t = useT();
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
        {presets.map((p) => {
          const spec = presetSpec(p);
          const capped = spec.height > cap;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={value === p}
              onClick={() => onPick(p)}
              className={cn(
                'flex items-start gap-3 rounded-[10px] border px-3.5 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
                value === p
                  ? 'border-line-strong bg-bg-active'
                  : 'border-line bg-bg-elev/60 hover:bg-bg-hover',
              )}
            >
              <Dot on={value === p} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[13.5px] font-semibold tabular-nums text-text-header">
                    {t('settings.stream.preset', { height: spec.height, fps: spec.fps })}
                  </span>
                  {p === fallback && (
                    <span className="rounded-[6px] bg-white/[0.06] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint">
                      {t('settings.stream.default')}
                    </span>
                  )}
                  {capped && (
                    <span className="rounded-[6px] bg-warn/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-warn">
                      {t('settings.stream.cappedTo', { height: cap })}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[12px] text-text-muted">
                  {t(PRESET_HINTS[p])}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StreamSettings() {
  const t = useT();
  const quality = useVoiceStore((s) => s.screenQuality);
  const motion = useVoiceStore((s) => s.screenMotion);
  const cap = Number(useSetting<string>('voice.screenMaxHeight')) || Infinity;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12.5px] leading-relaxed text-text-muted">{t('settings.stream.intro')}</p>
      <div>
        <SectionLabel>{t('settings.stream.mode')}</SectionLabel>
        <ModePicker />
      </div>
      <PresetList
        label={t('settings.stream.quality')}
        presets={QUALITY_PRESETS}
        value={quality}
        fallback={DEFAULT_QUALITY_PRESET}
        onPick={setScreenQuality}
        cap={cap}
      />
      <PresetList
        label={t('settings.stream.motion')}
        presets={MOTION_PRESETS}
        value={motion}
        fallback={DEFAULT_MOTION_PRESET}
        onPick={setScreenMotion}
        cap={cap}
      />
      <p className="text-[12px] leading-relaxed text-text-faint">{t('settings.stream.mesh')}</p>
    </div>
  );
}

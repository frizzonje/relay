'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { springTab } from '@/lib/motion';
import { useT, type MessageKey } from '@/lib/i18n';
import { useVoiceStore } from '@/stores/voice';
import { useSetting } from '@/stores/config';
import { setScreenMode, setScreenSetup } from '@/lib/voice';
import {
  SCREEN_FPS,
  SCREEN_HEIGHTS,
  resolveProfile,
  type ScreenMode,
  type ScreenSetup,
} from '@/lib/voice/screen-profile';

/**
 * Вкладка «Трансляция»: с чем стример выходит в эфир.
 *
 * Два режима — две задачи: «Картинка» держит резкость и при нехватке канала
 * бросает кадры, «Плавность» — наоборот. Разрешение и кадры у каждого свои и
 * выбираются порознь, любым сочетанием. Выбор живёт в браузере и применяется
 * к идущей трансляции сразу. Потолок владельца главнее: что выше него, выбрать
 * нельзя, и это сказано прямо на кнопке.
 */

const MODES: { id: ScreenMode; title: MessageKey; hint: MessageKey }[] = [
  {
    id: 'quality',
    title: 'settings.stream.mode.quality',
    hint: 'settings.stream.mode.quality.hint',
  },
  { id: 'fps', title: 'settings.stream.mode.fps', hint: 'settings.stream.mode.fps.hint' },
];

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

/** Ряд кнопок-сегментов: подложка выбранного переезжает, как у тумблера в панели звонка. */
function Segments<V extends number>({
  id,
  label,
  options,
  value,
  format,
  blocked,
  onPick,
}: {
  id: string;
  label: string;
  options: readonly V[];
  value: V;
  format: (v: V) => string;
  /** Подсказка, почему вариант недоступен; undefined — доступен. */
  blocked: (v: V) => string | undefined;
  onPick: (v: V) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start max-sm:gap-1.5">
      <span className="text-[13px] text-text-muted">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-0.5 rounded-[10px] border border-line bg-black/[0.22] p-0.5 max-sm:w-full"
      >
        {options.map((v) => {
          const why = blocked(v);
          const on = v === value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!!why}
              title={why}
              onClick={() => onPick(v)}
              className={cn(
                // Одна ширина у всех сегментов — обе группы встают ровной колонкой.
                'relative w-[76px] rounded-[8px] py-1.5 max-sm:w-auto max-sm:flex-1 font-mono text-[12.5px] font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line-strong',
                on ? 'text-bg-app' : 'text-text-muted hover:text-text-header',
                why && 'cursor-not-allowed opacity-35 hover:text-text-muted',
              )}
            >
              {on && (
                <motion.span
                  layoutId={id}
                  transition={springTab}
                  className="absolute inset-0 rounded-[8px] bg-accent-strong"
                />
              )}
              <span className="relative">{format(v)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Под выбором — во что он обойдётся и о чём стоит знать. */
function noteFor(setup: ScreenSetup, mode: ScreenMode): MessageKey {
  if (setup.height >= 1440 && setup.fps >= 60) return 'settings.stream.note.heavy';
  if (setup.fps === 45) return 'settings.stream.note.fps45';
  return mode === 'quality' ? 'settings.stream.mode.quality.hint' : 'settings.stream.mode.fps.hint';
}

function ModeCard({
  mode,
  title,
  active,
  maxHeight,
  maxBitrate,
}: {
  mode: ScreenMode;
  title: MessageKey;
  active: boolean;
  maxHeight: number;
  maxBitrate: number;
}) {
  const t = useT();
  const setups = useVoiceStore((s) => s.screenSetups);
  const setup = setups[mode];
  // Что реально уйдёт через медиасервер — с потолками владельца.
  const live = resolveProfile({ mode, setups, transport: 'sfu', maxHeight, maxBitrate });
  const overCap = (h: number) =>
    Number.isFinite(maxHeight) && maxHeight > 0 && h > maxHeight
      ? t('settings.stream.capTitle', { height: maxHeight })
      : undefined;

  return (
    <div
      className={cn(
        'rounded-[12px] border transition-colors',
        active ? 'border-line-strong bg-bg-active/50' : 'border-line bg-bg-elev/60',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => setScreenMode(mode)}
        className="flex w-full items-start gap-3 rounded-t-[12px] px-3.5 pb-2 pt-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
      >
        <Dot on={active} />
        <span className="text-[14px] font-semibold text-text-header">{t(title)}</span>
      </button>
      <div className="flex flex-col gap-2 px-3.5 pb-3 pl-[44px] max-sm:pl-3.5">
        <Segments
          id={`stream-${mode}-height`}
          label={t('settings.stream.height')}
          options={SCREEN_HEIGHTS}
          value={setup.height as (typeof SCREEN_HEIGHTS)[number]}
          format={(h) => `${h}p`}
          blocked={overCap}
          onPick={(height) => setScreenSetup(mode, { height })}
        />
        <Segments
          id={`stream-${mode}-fps`}
          label={t('settings.stream.fps')}
          options={SCREEN_FPS}
          value={setup.fps as (typeof SCREEN_FPS)[number]}
          format={(fps) => t('settings.stream.fpsValue', { fps })}
          blocked={() => undefined}
          onPick={(fps) => setScreenSetup(mode, { fps })}
        />
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
          <span className="font-mono tabular-nums text-text-header">
            {t('settings.stream.summary', {
              height: live.height,
              fps: live.fps,
              mbps: (live.bitrate / 1_000_000).toFixed(1),
            })}
          </span>
          {live.height < setup.height && (
            <span className="rounded-[6px] bg-warn/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-warn">
              {t('settings.stream.cappedTo', { height: live.height })}
            </span>
          )}
        </div>
        <p className="text-[12px] leading-relaxed text-text-muted">{t(noteFor(setup, mode))}</p>
      </div>
    </div>
  );
}

export function StreamSettings() {
  const t = useT();
  const mode = useVoiceStore((s) => s.screenMode);
  const maxHeight = Number(useSetting<string>('voice.screenMaxHeight'));
  const maxBitrate = useSetting<number>('voice.screenBitrateKbps') * 1000;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12.5px] leading-relaxed text-text-muted">{t('settings.stream.intro')}</p>
      <div>
        <SectionLabel>{t('settings.stream.modes')}</SectionLabel>
        <p className="mb-2 text-[12px] leading-relaxed text-text-faint">
          {t('settings.stream.modes.hint')}
        </p>
        <div
          role="radiogroup"
          aria-label={t('settings.stream.modes')}
          className="flex flex-col gap-2"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m.id}
              mode={m.id}
              title={m.title}
              active={mode === m.id}
              maxHeight={maxHeight}
              maxBitrate={maxBitrate}
            />
          ))}
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-text-faint">{t('settings.stream.mesh')}</p>
    </div>
  );
}

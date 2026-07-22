'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { avatarGradient } from '@/lib/avatar';
import { toggleFocus, setPeerVolume, setPeerScreenVolume } from '@/lib/voice';
import { useAudioUnlockStore } from '@/stores/audio-unlock';
import { useVoiceStore, type TileNet, type VoiceTile } from '@/stores/voice';

// WebKit (Safari/WKWebView) до сих пор отдаёт Fullscreen API только под
// webkit-префиксом — держим необязательные варианты рядом со стандартными.
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

// Выше 200% ползунок физически «тормозит»: 200 единиц драга дают только 100%
// прироста (вместо 1:1) — тот же путь мышкой требует вдвое больше усилия,
// а итоговая громкость применяется как есть, без урезания усиления.
const RESIST_FROM = 200;
const RAW_MAX = 400; // 200 (1:1) + 200 (2:1) → значение доходит до 300%

function pctToRaw(pct: number): number {
  return pct <= RESIST_FROM ? pct : RESIST_FROM + (pct - RESIST_FROM) * 2;
}

function rawToPct(raw: number): number {
  return raw <= RESIST_FROM ? raw : RESIST_FROM + (raw - RESIST_FROM) / 2;
}

/** Ползунок громкости 0–300% (1 = 100%). Усиление выше 100% — за счёт Web Audio. */
function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs font-semibold text-white">
        <span>{label}</span>
        <span className={cn('tabular-nums', pct === 0 ? 'text-danger' : 'text-text-muted')}>
          {pct}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={RAW_MAX}
        step={1}
        value={pctToRaw(pct)}
        aria-label={label}
        onChange={(e) => onChange(rawToPct(Number(e.target.value)) / 100)}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-accent"
      />
    </div>
  );
}

// Сколько палочек «горит» и каким тоном — по классу качества связи.
const NET_ACTIVE: Record<TileNet['grade'], number> = { strong: 4, good: 3, weak: 2, bad: 1 };
const NET_TONE: Record<TileNet['grade'], string> = {
  strong: 'bg-ok',
  good: 'bg-ok',
  weak: 'bg-[#e0b23a]',
  bad: 'bg-danger',
};
const NET_LABEL: Record<TileNet['grade'], string> = {
  strong: 'отличная',
  good: 'хорошая',
  weak: 'слабая',
  bad: 'плохая',
};

// Короткая подпись пилюли аплинка + разъяснение в title (на своей плитке).
const UPLINK_PILL: Record<'cpu' | 'bandwidth', { short: string; title: string }> = {
  bandwidth: {
    short: 'слабый аплинк',
    title:
      'Не хватает исходящего канала — качество вашего видео режется. Помогает выключить видео/демонстрацию или снизить их разрешение.',
  },
  cpu: {
    short: 'перегрузка ЦП',
    title:
      'Машина не тянет кодирование — качество вашего видео режется. Помогает закрыть тяжёлые вкладки/приложения или выключить видео.',
  },
};

// Слой simulcast, который реально доехал (только режим медиасервера): мелкой
// плитке отдают экономный, крупной — исходный. См. lib/voice/sfu.ts.
const LAYER_LABEL: Record<number, string> = {
  0: 'экономный',
  1: 'средний',
  2: 'исходный',
};

/**
 * Индикатор качества связи с собеседником — четыре нарастающие «палочки» в чипе
 * имени (как в Discord). Горящих палочек — по grade, цвет — зелёный/янтарь/красный.
 * Наведение раскрывает тултип с сырыми метриками (пинг, потери, джиттер), которые
 * снимает активный транспорт: mesh — до собеседника, SFU — до медиасервера.
 */
function SignalBars({ net }: { net: TileNet }) {
  const active = NET_ACTIVE[net.grade];
  const tone = NET_TONE[net.grade];
  return (
    <span
      className="group/net relative -ml-0.5 inline-flex h-3.5 items-end gap-[2px]"
      role="img"
      aria-label={`Связь: ${NET_LABEL[net.grade]}${net.relay ? ', через реле' : ''}`}
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            'w-[3px] rounded-[1.5px] transition-colors duration-300',
            i < active ? tone : 'bg-white/25',
          )}
          style={{ height: `${5 + i * 3}px` }}
        />
      ))}

      {/* Реле-метка: прямой путь — норма, поэтому помечаем только заметный случай
          (через TURN) — маленькая янтарная «R». Полная строка — в тултипе ниже. */}
      {net.relay && (
        <span
          className="ml-0.5 grid h-3.5 w-3.5 place-items-center self-center rounded-[3px] bg-[#e0b23a]/20 text-[9px] font-bold leading-none text-[#e0b23a]"
          aria-hidden
        >
          R
        </span>
      )}

      {/* Тултип со статами — над палочками, по наведению. Открывается вправо от
          палочек (left-0), чтобы не упираться в левый край плитки (overflow-hidden). */}
      <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-[8] w-max origin-bottom-left scale-95 rounded-lg border border-white/10 bg-[#1e1f22]/95 px-2.5 py-2 text-left opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.6)] backdrop-blur transition-[opacity,transform] duration-150 group-hover/net:scale-100 group-hover/net:opacity-100">
        <span className="mb-1 flex items-center gap-1.5 text-[12px] font-bold text-white">
          <span className={cn('h-2 w-2 rounded-full', tone)} />
          Связь: {NET_LABEL[net.grade]}
        </span>
        <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-text-muted">
          <span>Пинг</span>
          <span className="text-right text-white">
            {net.rttMs != null ? `${net.rttMs} мс` : '—'}
          </span>
          <span>Потери</span>
          <span className="text-right text-white">
            {net.lossPct != null ? `${net.lossPct}%` : '—'}
          </span>
          <span>Джиттер</span>
          <span className="text-right text-white">
            {net.jitterMs != null ? `${net.jitterMs} мс` : '—'}
          </span>
          <span>Соединение</span>
          <span className="text-right text-white">
            {net.via === 'sfu'
              ? 'через сервер'
              : net.relay == null
                ? '—'
                : net.relay
                  ? 'через реле'
                  : 'напрямую'}
          </span>
          <span>Битрейт</span>
          <span className="text-right text-white">
            {/* В режиме медиасервера исходящий «к нему» не существует: своё
                медиа уходит один раз на сервер, общее на всех. */}
            {net.via === 'sfu'
              ? net.recvKbps != null
                ? `↓${net.recvKbps} кбит/с`
                : '—'
              : net.recvKbps != null || net.sendKbps != null
                ? `↓${net.recvKbps ?? '—'} ↑${net.sendKbps ?? '—'} кбит/с`
                : '—'}
          </span>
          {net.via === 'sfu' && net.layer != null && (
            <>
              <span>Слой</span>
              <span className="text-right text-white">{LAYER_LABEL[net.layer] ?? net.layer}</span>
            </>
          )}
          {net.videoRes && (
            <>
              <span>Видео</span>
              <span className="text-right text-white">
                {net.videoRes}
                {net.fps != null ? ` · ${net.fps}fps` : ''}
              </span>
            </>
          )}
          {net.codec && (
            <>
              <span>Кодек</span>
              <span className="text-right text-white">{net.codec}</span>
            </>
          )}
        </span>
      </span>
    </span>
  );
}

/**
 * Видеоплитка участника. Привязывает поток к <video srcObject>, сама следит
 * за треками (watchStream/updateTileMedia) — показывает видео или аватарку.
 * Кнопка-«развернуть» — настоящий Fullscreen API; клик по телу плитки —
 * театр-режим (фокус через стор).
 */
export function VideoTile({
  tile,
  focused,
  hidden,
}: {
  tile: VoiceTile;
  focused: boolean;
  hidden?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const micOn = useVoiceStore((s) => s.micOn);
  // Обводка «говорит сейчас»: булев селектор — плитка перерисуется только на
  // смене состояния, а не на каждый тик опроса уровня.
  const speaking = useVoiceStore((s) => s.speakingIds.includes(tile.id));
  // Здоровье своего аплинка — предупреждение показываем только на своей плитке.
  const uplink = useVoiceStore((s) => (tile.isLocal ? s.uplink : 'ok'));

  const [hasVideo, setHasVideo] = useState(false);
  // Тег качества в углу плитки: разрешение живого видео («720p»), «видео» без
  // метрики размера, либо «аудио» когда камеры/экрана нет.
  const [quality, setQuality] = useState('аудио');
  const [isFs, setIsFs] = useState(false);
  // Запасной «полный экран» через CSS-оверлей: WKWebView (десктоп на macOS) не
  // отдаёт Fullscreen API на произвольный <div>, и нативный вызов там молча
  // отклоняется. Тогда разворачиваем плитку fixed-оверлеем на всё окно.
  const [cssFs, setCssFs] = useState(false);
  // Открытое меню громкости: 'voice' (ПКМ по плитке) | 'screen' (иконка снизу)
  const [menu, setMenu] = useState<'voice' | 'screen' | null>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

  // Привязка потока + слежение за треками (watchStream/updateTileMedia)
  useEffect(() => {
    const video = videoRef.current;
    const stream = tile.stream;
    if (!video) return;

    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {
        // автоплей заблокирован браузером — показываем кнопку разблокировки звука
        if (!tile.isLocal) useAudioUnlockStore.getState().show();
      });
    }
    if (!stream) {
      setHasVideo(false);
      return;
    }

    const refresh = () => {
      const vt = stream
        .getVideoTracks()
        .find((t) => t.enabled && !t.muted && t.readyState === 'live');
      setHasVideo(!!vt);
      const h = vt?.getSettings().height;
      setQuality(vt ? (h ? `${h}p` : 'видео') : 'аудио');
    };
    // addEventListener вместо onX — не перебиваем обработчики voice.ts (onended и др.)
    const watchTrack = (t: MediaStreamTrack) => {
      t.addEventListener('mute', refresh);
      t.addEventListener('unmute', refresh);
      t.addEventListener('ended', refresh);
    };
    stream.getTracks().forEach(watchTrack);

    const handleAddTrack = (e: MediaStreamTrackEvent) => {
      watchTrack(e.track);
      refresh();
    };
    stream.addEventListener('addtrack', handleAddTrack);
    stream.addEventListener('removetrack', refresh);
    refresh();

    return () => {
      stream.removeEventListener('addtrack', handleAddTrack);
      stream.removeEventListener('removetrack', refresh);
    };
  }, [tile.stream, tile.isLocal]);

  // Иконка кнопки полноэкранного режима отражает состояние. Слушаем и
  // webkit-префиксное событие — WebKit (Safari/WKWebView) шлёт его вместо
  // стандартного `fullscreenchange`.
  useEffect(() => {
    const onChange = () => {
      const d = document as FsDocument;
      const fsEl = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
      setIsFs(fsEl === tileRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // CSS-полноэкран закрываем по Escape (нативный FS браузер гасит сам).
  useEffect(() => {
    if (!cssFs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCssFs(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cssFs]);

  // Меню громкости закрываем по клику мимо него и по Escape
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // ПКМ по чужой плитке — регулятор громкости голоса собеседника
  function onContextMenu(e: React.MouseEvent) {
    if (tile.isLocal) return; // у себя громкость не крутим
    e.preventDefault();
    const rect = tileRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Прижимаем поповер к краям плитки, чтобы не уезжал за её пределы
    const x = Math.min(Math.max(e.clientX - rect.left, 8), Math.max(rect.width - 228, 8));
    const y = Math.min(Math.max(e.clientY - rect.top, 8), Math.max(rect.height - 80, 8));
    setMenuPos({ x, y });
    setMenu('voice');
  }

  function onExpand(e: React.MouseEvent) {
    e.stopPropagation(); // клик по кнопке не должен включать театр-режим
    const el = tileRef.current as FsElement | null;
    if (!el) return;
    const d = document as FsDocument;

    // Уже развёрнуто (нативно или CSS-оверлеем) — сворачиваем.
    if (cssFs) {
      setCssFs(false);
      return;
    }
    const nativeEl = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    if (nativeEl === el) {
      (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d);
      return;
    }

    // Пытаемся нативным Fullscreen API (webkit-префикс для Safari/WKWebView).
    // Если метода нет или промис отклонён (WKWebView на macOS) — CSS-оверлей.
    const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (!request) {
      setCssFs(true);
      return;
    }
    Promise.resolve(request.call(el)).catch(() => setCssFs(true));
  }

  // Своя плитка: videoOn — единственный источник истины (избегаем гонки с addtrack).
  // Чужая плитка: videoOn === false от сигнала перекрывает hasVideo (замёрзший кадр).
  const novideo = tile.isLocal ? tile.videoOn !== true : !hasVideo || tile.videoOn === false;

  return (
    <motion.div
      ref={tileRef}
      // layout — плавная перестройка сетки и «зум» в театр-режим (план §3.3,
      // заменяет CSS tilePop/tileZoom). Вход/выход пира — через AnimatePresence.
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      aria-hidden={hidden || undefined}
      style={hidden ? { display: 'none' } : undefined}
      transition={{
        layout: { type: 'spring', stiffness: 360, damping: 34 },
        opacity: { duration: 0.22 },
      }}
      onClick={() => toggleFocus(tile.id)}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleFocus(tile.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${tile.name}: ${focused ? 'свернуть' : 'развернуть на весь экран сцены'}`}
      className={cn(
        'group relative aspect-video cursor-zoom-in overflow-hidden rounded-[11px] border border-line bg-[#18191c] outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-line-strong',
        // Своя плитка — чуть более светлая рамка (раздел 02 референса).
        tile.isLocal && !speaking && 'border-[1.5px] border-[rgba(215,219,224,0.35)]',
        // «Говорит сейчас» — обводка в наш зелёный (--color-ok, #46c17f) с мягким
        // свечением. ring даёт чёткий кант, shadow — ореол; Tailwind склеивает их
        // в один box-shadow.
        speaking && 'border-ok ring-2 ring-ok shadow-[0_0_16px_3px_rgba(70,193,127,0.45)]',
        focused && 'col-span-full row-span-full !aspect-auto h-full min-h-0 cursor-zoom-out',
        // CSS-полноэкран (фолбэк для WKWebView): плитка поверх всего окна.
        cssFs &&
          'fixed inset-0 z-[100] !m-0 h-screen w-screen !max-w-none rounded-none border-none bg-black !aspect-auto cursor-zoom-out',
      )}
    >
      {/* Подложка «без видео»: мягкое свечение + аватар в кольце с тихим «дыханием».
          Видна ТОЛЬКО когда нет живого видео — при видеосвязи её перекрывает
          <video> (object-cover), при демонстрации экрана/театре — его чёрный фон
          (object-contain), плюс мы гасим её opacity синхронно с novideo. Поэтому
          ни видео, ни демонстрация не страдают. */}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center overflow-hidden bg-[radial-gradient(125%_125%_at_50%_22%,#33363c_0%,#202227_46%,#121316_100%)] transition-opacity duration-300',
          novideo ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* мягкий холодный ореол за аватаром (нейтральная палитра relay) */}
        <div className="pointer-events-none absolute h-[58%] w-[58%] rounded-full bg-accent/10 blur-[55px]" />
        {/* аватар: кольцо, тень, тихое «дыхание» (motion-safe) */}
        <div
          className="relative h-[92px] w-[92px] rounded-full bg-cover bg-center shadow-[0_10px_34px_rgba(0,0,0,0.55)] ring-2 ring-white/15 motion-safe:animate-[avatarBreath_4.5s_ease-in-out_infinite]"
          style={{ background: avatarGradient(tile.name) }}
        />
      </div>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        // Заглушаем всегда: чужой звук идёт через микшер Web Audio (раздельная
        // громкость голоса/демонстрации), свой — не воспроизводим эхом.
        muted
        className={cn(
          'relative z-[1] block h-full w-full object-cover',
          tile.isLocal && !tile.screen && '-scale-x-100', // зеркалим себя, но не демонстрацию
          tile.isLocal && tile.screen && 'bg-black object-contain',
          (focused || cssFs) && 'bg-black object-contain',
          novideo && 'invisible',
        )}
      />

      {/* Кнопка «во весь экран» (видна при наведении) */}
      <button
        type="button"
        title={isFs || cssFs ? 'Свернуть' : 'Во весь экран'}
        aria-label={isFs || cssFs ? 'Свернуть из полного экрана' : 'Во весь экран'}
        onClick={onExpand}
        className="absolute left-2.5 top-2.5 z-[4] grid h-[30px] w-[30px] place-items-center rounded-md bg-black/55 text-white opacity-0 transition group-hover:opacity-90 hover:!opacity-100 hover:!bg-black/85 active:scale-[0.88]"
      >
        <Icon name={isFs || cssFs ? 'minimize-2' : 'maximize-2'} className="text-lg" />
      </button>

      {/* Статус соединения — либо тег разрешения в углу при видео. Тег «аудио»
          (нет камеры/экрана) не показываем — он лишний шум на голосовой плитке. */}
      {tile.state ? (
        <div className="absolute right-2.5 top-2.5 z-[2] rounded-[8px] bg-black/65 px-2.5 py-1 text-xs font-semibold text-text-dim backdrop-blur-[6px]">
          {tile.state}
        </div>
      ) : quality !== 'аудио' ? (
        <div className="absolute right-2.5 top-2.5 z-[2] rounded-[8px] bg-black/55 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted backdrop-blur-[6px]">
          {quality}
        </div>
      ) : null}

      {/* Чип имени + индикатор связи + микрофон (blur, раздел 02 референса) */}
      <div className="absolute bottom-2 left-2 z-[2] flex items-center gap-1.5 rounded-[8px] bg-black/55 px-2.5 py-1 text-[13px] font-semibold text-white backdrop-blur-[6px]">
        {!tile.isLocal && tile.net && <SignalBars net={tile.net} />}
        {tile.name}
        {tile.isLocal && !micOn && <Icon name="mic-off" className="h-3.5 w-3.5 text-danger" />}
      </div>

      {/* Предупреждение о своём аплинке: в mesh исходящий канал — частое узкое
          место, а «палочки» показывают только входящее от собеседников. */}
      {tile.isLocal && uplink !== 'ok' && (
        <div
          title={UPLINK_PILL[uplink].title}
          className="absolute bottom-2 right-2 z-[3] flex items-center gap-1 rounded-[8px] bg-[#e0b23a]/90 px-2 py-1 text-[11px] font-bold text-black backdrop-blur-[6px]"
        >
          <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-black/25 text-[10px] leading-none text-black">
            !
          </span>
          {UPLINK_PILL[uplink].short}
        </div>
      )}

      {/* Громкость звука демонстрации: иконка снизу справа, пока у пира идёт звук экрана */}
      {!tile.isLocal && tile.hasScreenAudio && (
        <button
          type="button"
          title="Громкость трансляции"
          aria-label="Громкость звука демонстрации"
          onClick={(e) => {
            e.stopPropagation();
            setMenu((m) => (m === 'screen' ? null : 'screen'));
          }}
          className={cn(
            // Видна сразу (не только по наведению) — иначе регулятор трансляции
            // легко не заметить; на hover/при открытом меню — ярче.
            'absolute bottom-2 right-2 z-[4] grid h-[30px] w-[30px] place-items-center rounded-md bg-black/65 text-white opacity-90 ring-1 ring-white/15 transition hover:!bg-black/85 hover:opacity-100 active:scale-[0.88]',
            menu === 'screen' && 'opacity-100 ring-accent',
            (tile.screenVolume ?? 1) === 0 && 'text-danger opacity-100',
          )}
        >
          <Icon
            name={(tile.screenVolume ?? 1) === 0 ? 'volume-x' : 'volume-2'}
            className="text-lg"
          />
        </button>
      )}

      {/* Поповер громкости: голос (ПКМ по плитке) либо звук трансляции (иконка) */}
      {menu && !tile.isLocal && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          style={menu === 'voice' ? { left: menuPos.x, top: menuPos.y } : { right: 8, bottom: 44 }}
          className="absolute z-[6] w-56 rounded-lg border border-white/10 bg-[#1e1f22]/95 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          {menu === 'voice' ? (
            <VolumeSlider
              label="Голос собеседника"
              value={tile.volume ?? 1}
              onChange={(v) => setPeerVolume(tile.id, v)}
            />
          ) : (
            <VolumeSlider
              label="Звук трансляции"
              value={tile.screenVolume ?? 1}
              onChange={(v) => setPeerScreenVolume(tile.id, v)}
            />
          )}
        </div>
      )}
    </motion.div>
  );
}

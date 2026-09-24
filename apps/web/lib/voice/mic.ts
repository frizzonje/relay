'use client';

import { toast } from 'sonner';
import { tx as msg } from '@/lib/i18n';
import { mediaErrorText } from '@/lib/voice/device-error';
import { useVoiceStore } from '@/stores/voice';
import { setting } from '@/stores/config';
import { nextGate } from '@/lib/voice/gate';
import {
  ANALYSER_FFT_SIZE,
  analyserRms,
  getAudioCtx,
  refreshOutputDevices,
} from '@/lib/voice/output';

/**
 * Захват микрофона: устройство, шумовой гейт, push-to-talk, мут и анализатор,
 * по которому зажигается обводка «говорю».
 *
 * Дорожка микрофона одна — та, что пришла с устройства, и она же уходит
 * собеседникам. Всё, что её глушит (мут, push-to-talk, «глушилка», затвор
 * порога), сходится в одну формулу `enabled = micOn && gateOpen` и пишется в
 * одном месте — `applyTrackState`. Web Audio здесь только слушает: уровень
 * снимается с КЛОНА дорожки, потому что выключенная дорожка отдаёт тишину всем
 * своим потребителям, и анализатор на ней самой после первого же закрытия
 * затвора видел бы ноль — затвор больше не открылся бы никогда.
 *
 * Раньше при пороге > 0 голос шёл через GainNode и MediaStreamDestination, и
 * собеседникам уходил выход Web Audio — вторая дорожка, пересэмплирование на
 * частоту вывода и подозреваемый в треске на Linux. См. docs/plans/voice-quality.md.
 */

/**
 * Что захвату микрофона нужно от того, чем он не владеет.
 *
 * Исходящий поток — общий: в него добавляют дорожки и камера, и демонстрация
 * экрана, а забирает его транспорт. Микрофон в нём только своя дорожка, и
 * подменять её надо в двух местах сразу — в потоке и у уже подключённых
 * собеседников. Отсюда и весь список.
 */
export interface MicSurroundings {
  /** Исходящий набор дорожек. Владеет им дирижёр: туда же кладут камеру и экран. */
  stream(): MediaStream | null;
  /** Принять только что взятый у браузера поток — он и станет исходящим. */
  adopt(stream: MediaStream): void;
  /** Звук демонстрации: он в том же потоке, но мут микрофона его не касается. */
  screenAudioTrack(): MediaStreamTrack | null;
  /** Перевести уже подключённых собеседников на другую дорожку микрофона. */
  replaceTrack(from: MediaStreamTrack | null, to: MediaStreamTrack): void;
  /** Состояние микрофона изменилось — обновить витрину. */
  syncStore(): void;
  /** …и рассказать собеседникам (мут виден в presence у всех, даже вне эфира). */
  announce(): void;
}

let around: MicSurroundings = {
  stream: () => null,
  adopt: () => {},
  screenAudioTrack: () => null,
  replaceTrack: () => {},
  syncStore: () => {},
  announce: () => {},
};

export function initMic(surroundings: MicSurroundings): void {
  around = surroundings;
}

/** Включён ли микрофон. Мут держит эта переменная, а не свойство дорожки. */
let micOn = true;

export function isMicOn(): boolean {
  return micOn;
}

/**
 * Выставить мут напрямую. Зовут отсюда же (PTT) и снаружи — «глушилка» гасит
 * микрофон, потому что не слышишь — не говоришь, и это правило дирижёра.
 */
export function setMicOn(on: boolean): void {
  micOn = on;
  applyMute();
}

// ─── Настройки медиа (модалка настроек, раздел 06 референса) ───────────────
// Шумоподавление и автоусиление — constraint'ы getUserMedia (по умолчанию вкл);
// Push-to-talk — микрофон открыт, только пока удерживается пробел (по умолчанию
// выкл). Значения запоминаются в localStorage и синхронизируются в стор при загрузке.
const NS_KEY = 'relay-noise-suppress';
const AGC_KEY = 'relay-auto-gain';
const PTT_KEY = 'relay-ptt';

/**
 * Что человек выбрал в ЭТОМ браузере, или `null` — не выбирал вовсе.
 *
 * Разница между «выключил» и «не трогал» здесь и есть вся суть: не трогал —
 * значит действует умолчание инсталляции, и оно может смениться; выключил —
 * значит выбор его, и владелец панели ему не указ.
 */
function chosen(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

/**
 * Тумблер микрофона: выбор человека, а без него — умолчание инсталляции
 * (`voice.noiseSuppressionDefault`, `voice.autoGainControlDefault`,
 * `voice.pushToTalkDefault`).
 *
 * Спрашиваем каждый раз, а не запоминаем при загрузке модуля: снимок настроек
 * приезжает после первого кадра, и значение, снятое на старте, осталось бы
 * вчерашним до перезагрузки вкладки. Умолчания каталога — сегодняшние «вкл» и
 * «выкл», поэтому в инсталляции, где панель не открывали, всё как было.
 */
function toggleOn(key: string, fallback: string): boolean {
  const raw = chosen(key);
  return raw === null ? setting<boolean>(fallback) : raw === '1';
}

const noiseSuppressionOn = () => toggleOn(NS_KEY, 'voice.noiseSuppressionDefault');
const autoGainOn = () => toggleOn(AGC_KEY, 'voice.autoGainControlDefault');
const pushToTalkOn = () => toggleOn(PTT_KEY, 'voice.pushToTalkDefault');

let pttHeld = false;

/** Constraint аудио с учётом тумблеров шумоподавления и автоусиления. */
function audioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: noiseSuppressionOn(),
    autoGainControl: autoGainOn(),
  };
}

// ─── Порог срабатывания микрофона (шумовой гейт, как в Discord) ───────────
// Пока уровень ниже порога, затвор закрыт и дорожка устройства выключена
// (`enabled = false`: пакеты тишины идут дальше, и сторож тишины у собеседника
// не спутает это с обрывом — ровно как при муте). Выше — открыт. После спада
// держим открытым ещё GATE_HOLD_MS, чтобы хвосты слов не рубило. Порог 0 —
// затвора нет. Затвор резкий, без фронтов: цена того, что голос не идёт через
// Web Audio.
const MIC_THRESHOLD_KEY = 'relay-mic-threshold';
let micThreshold = 0; // 0..1 в шкале метра (0 = гейт выключен); читаем в initVoice
let micTrack: MediaStreamTrack | null = null; // дорожка устройства — она же уходит собеседникам
let meterTrack: MediaStreamTrack | null = null; // её клон под анализатор: затвор и мут его не глушат

const MIC_METER_FULL = 0.5; // RMS, при котором метр (и шкала порога) заполнен
const MIC_RING_FLOOR = 0.12; // мин. уровень для обводки «говорю», когда гейт выключен
const GATE_HOLD_MS = 250;
const GATE_TICK_MS = 50;
let gateOpen = true;
let gateOpenUntil = 0;
let gateTimer: ReturnType<typeof setInterval> | null = null;

// Анализатор своего микрофона: он же питает и метр у ползунка порога, и гейт,
// и обводку «говорю». Тихий путь до destination нужен, чтобы граф «тянул»
// микрофон, — себя мы не слышим.
let localAnalyser: AnalyserNode | null = null;
let localVadSource: MediaStreamAudioSourceNode | null = null;
let localVadGain: GainNode | null = null;

// localStorage-ключ выбранного микрофона — применяется при следующем входе
const MIC_KEY = 'relay-mic-id';

async function acquireMic(): Promise<MediaStream> {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(MIC_KEY) : null;
  if (saved) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...audioConstraints(), deviceId: { exact: saved } },
      });
    } catch (err) {
      // Сохранённый микрофон пропал/занят — откатываемся на устройство по умолчанию
      if ((err as { name?: string } | null)?.name !== 'OverconstrainedError') throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
}

// Запрос микрофона, который уже летит. Два клика подряд по разным каналам
// упираются в один и тот же `if (!localStream)`, и без общего запроса устройство
// открывается ДВАЖДЫ: второй поток становится нашим, а первый остаётся гореть
// мимо дирижёра — лампочка записи не гаснет до перезагрузки вкладки, и на части
// систем устройство остаётся занятым.
let micPending: Promise<MediaStream> | null = null;

/**
 * Убедиться, что микрофон взят, — ровно один раз на все параллельные заходы.
 * Опоздавший подхватывает уже принятый поток, а не открывает свой.
 */
export async function ensureLocalStream(): Promise<void> {
  if (around.stream()) return;
  if (!micPending) {
    micPending = acquireMic().finally(() => {
      micPending = null;
    });
  }
  const stream = await micPending;
  if (around.stream()) return; // нас опередил другой заход — поток уже принят

  around.adopt(stream);
  micTrack = stream.getAudioTracks()[0] ?? null;
  if (micTrack) micTrack.contentHint = 'speech'; // голос, не музыка
  gateOpen = true; // первый тик гейта закроет, если тихо
  gateOpenUntil = 0;
  applyTrackState();
  setupLocalVad(); // анализатор своего микрофона для обводки и гейта
  // Доступ выдан — метки устройств теперь видны, наполняем списки
  void refreshMicInfo();
  refreshOutputDevices();
}

/**
 * Порог срабатывания микрофона, 0..1 в шкале метра (0 = гейт выключен, слышно
 * всегда). Чем правее — тем громче надо говорить, чтобы микрофон открылся.
 * Сам затвор ведёт evaluateGate. Выбор — в localStorage.
 */
export function setMicThreshold(value: number) {
  const t = Math.max(0, Math.min(1, value));
  micThreshold = t;
  if (typeof localStorage !== 'undefined') localStorage.setItem(MIC_THRESHOLD_KEY, String(t));
  useVoiceStore.getState().setMicThreshold(t);
  // Порог выключили — затвор открывается сразу, не дожидаясь тика.
  if (t <= 0) setGate({ open: true, openUntil: 0 });
}

/** Сменить состояние затвора; дорожку трогаем, только если оно правда сменилось. */
function setGate(next: { open: boolean; openUntil: number }) {
  gateOpenUntil = next.openUntil;
  if (next.open === gateOpen) return;
  gateOpen = next.open;
  applyTrackState();
}

/** Текущий уровень микрофона в шкале метра (0..1, sqrt-кривая — тихое заметнее). */
export function micLevelNorm(): number {
  if (!localAnalyser) return 0;
  return Math.min(1, Math.sqrt(analyserRms(localAnalyser) / MIC_METER_FULL));
}

/**
 * Уровень своего микрофона (0..1) — для живого метра у ползунка порога (как в
 * Discord). 0, если анализатор не поднят. Дёргать можно часто (rAF) — дёшево.
 */
export function getMicLevel(): number {
  return micLevelNorm();
}

/**
 * Тик гейта. Без анализатора (нет Web Audio) порог не применяем вовсе: уровень
 * там всегда ноль, и затвор закрылся бы навсегда — человека не было бы слышно.
 */
function evaluateGate() {
  setGate(
    nextGate({
      level: micOn ? micLevelNorm() : 0,
      threshold: localAnalyser ? micThreshold : 0,
      now: performance.now(),
      openUntil: gateOpenUntil,
      holdMs: GATE_HOLD_MS,
    }),
  );
}

/** Обновляет в сторе активное устройство и список доступных микрофонов. */
export async function refreshMicInfo() {
  const store = useVoiceStore.getState();
  // Метку/девайс берём с дорожки устройства — она и уходит собеседникам.
  const track = micTrack;
  const settings = track?.getSettings?.();
  store.setCurrentMic(settings?.deviceId ?? null, track?.label ?? '');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.setMics(devices.filter((d) => d.kind === 'audioinput'));
  } catch {
    /* enumerateDevices недоступен — список останется пустым */
  }
}

/** Перечитать список микрофонов (для UI — например, при открытии меню). */
export function refreshMics() {
  void refreshMicInfo();
}

/**
 * Переключение микрофона на лету: новый getUserMedia + replaceTrack у всех
 * собеседников без пересборки SDP. Выбор запоминаем в localStorage.
 */
export async function setMic(deviceId: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MIC_KEY, deviceId);

  // Не в звонке — просто запомнили выбор, применится при следующем входе
  if (!around.stream()) return;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { ...audioConstraints(), deviceId: { exact: deviceId } }
        : audioConstraints(),
    });
  } catch (err) {
    toast.error(msg('voice.toast.micSwitchFailed', { reason: mediaErrorText(err) }));
    return;
  }

  const newTrack = stream.getAudioTracks()[0];
  if (!newTrack) return;
  newTrack.contentHint = 'speech'; // голос, не музыка
  // Мут и затвор — до того, как дорожка попадёт к собеседникам: иначе между
  // replaceTrack и applyTrackState заглушённый человек на миг слышен.
  newTrack.enabled = micOn && gateOpen;

  const oldTrack = micTrack;
  around.replaceTrack(oldTrack, newTrack);
  if (oldTrack) {
    oldTrack.stop();
    around.stream()!.removeTrack(oldTrack);
  }
  around.stream()!.addTrack(newTrack);
  micTrack = newTrack;
  applyTrackState();

  setupLocalVad(); // переподцепляем анализатор к новому устройству
  await refreshMicInfo();
  toast(
    msg('voice.toast.micSwitched', {
      device: newTrack.label || msg('voice.toast.micSwitched.fallback'),
    }),
  );
}

/**
 * Запомнить тумблер обработки и, если уже в звонке, переснять дорожку текущего
 * устройства: constraint'ы действуют только на новом захвате.
 */
async function rememberAndRecapture(key: string, on: boolean) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, on ? '1' : '0');
  if (around.stream()) await setMic(useVoiceStore.getState().currentMicId ?? '');
}

/** Тоггл аппаратного шумоподавления микрофона (модалка настроек, раздел 06). */
export async function setNoiseSuppression(on: boolean) {
  useVoiceStore.getState().setNoiseSuppression(on);
  await rememberAndRecapture(NS_KEY, on);
}

/**
 * Тоггл автоусиления. На Linux браузер ведёт им СИСТЕМНЫЙ ползунок микрофона
 * (PulseAudio/PipeWire) и может загнать его за 100% — голос хрипит и «плавает».
 * На Windows драйвер обычно держит потолок, поэтому там этого не слышно.
 */
export async function setAutoGain(on: boolean) {
  useVoiceStore.getState().setAutoGain(on);
  await rememberAndRecapture(AGC_KEY, on);
}

// ─── Push-to-talk (модалка настроек) ───────────────────────────────────────
// Пока режим включён, микрофон держим закрытым и открываем только на время
// удержания пробела. Пробел игнорируем, когда фокус в поле ввода (чат/теги),
// чтобы не воровать набор текста и не активировать кнопки.
function pttTargetIsTextInput(): boolean {
  const el =
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Открыть/закрыть микрофон на время удержания PTT. Общая часть для пробела
// (окно в фокусе) и глобального хоткея десктоп-оболочки (desktopPtt). Флаг
// pttHeld один на оба источника — повторные press/release не дублируются.
function pttPress() {
  if (pttHeld) return;
  pttHeld = true;
  if (!around.stream() || micOn) return;
  micOn = true;
  applyMute();
  around.announce();
}

function pttRelease() {
  if (!pttHeld) return;
  pttHeld = false;
  if (!around.stream()) return;
  micOn = false;
  applyMute();
  around.announce();
}

/**
 * Подписка на пробел — одна на оба места, где режим включается: тумблер в
 * настройках и снимок состояния при старте. Повторный вызов безопасен:
 * `addEventListener` с той же функцией второй подписки не заводит.
 */
function listenForPtt(on: boolean) {
  if (typeof window === 'undefined') return;
  if (on) {
    window.addEventListener('keydown', onPttKeyDown);
    window.addEventListener('keyup', onPttKeyUp);
  } else {
    window.removeEventListener('keydown', onPttKeyDown);
    window.removeEventListener('keyup', onPttKeyUp);
  }
}

function onPttKeyDown(e: KeyboardEvent) {
  if (e.code !== 'Space' || e.repeat || pttTargetIsTextInput()) return;
  e.preventDefault();
  pttPress();
}

function onPttKeyUp(e: KeyboardEvent) {
  if (e.code !== 'Space') return;
  pttRelease();
}

/**
 * Глобальный push-to-talk из десктоп-оболочки (Tauri global-shortcut, событие
 * `ptt` → см. lib/desktop.ts). Действует только в режиме Push-to-talk — иначе
 * микрофон и так открыт, и отпускание хоткея неожиданно бы его глушило.
 */
export function desktopPtt(pressed: boolean) {
  if (!pushToTalkOn()) return;
  if (pressed) pttPress();
  else pttRelease();
}

/**
 * Тоггл режима Push-to-talk. При включении глушим микрофон (говоришь только на
 * удержании пробела); при выключении возвращаем микрофон в открытое состояние.
 */
export function setPushToTalk(on: boolean) {
  if (on === pushToTalkOn()) return;
  if (typeof localStorage !== 'undefined') localStorage.setItem(PTT_KEY, on ? '1' : '0');
  useVoiceStore.getState().setPushToTalk(on);
  if (typeof window === 'undefined') return;
  if (on) {
    listenForPtt(true);
    pttHeld = false;
    if (around.stream() && micOn) {
      micOn = false;
      applyMute();
      around.announce();
    }
  } else {
    listenForPtt(false);
    if (around.stream() && !micOn) {
      micOn = true;
      applyMute();
      around.announce();
    }
  }
}

/** Синхронизировать тогглы настроек из localStorage в стор (при монтировании модалки). */
export function loadMediaPrefs() {
  const store = useVoiceStore.getState();
  const ptt = pushToTalkOn();
  store.setNoiseSuppression(noiseSuppressionOn());
  store.setAutoGain(autoGainOn());
  store.setPushToTalk(ptt);
  // Пробел слушаем ровно тогда, когда режим включён. До этапа C подписка
  // заводилась только тумблером, поэтому вкладка, открытая с уже включённым
  // push-to-talk, оставалась с закрытым микрофоном и мёртвым пробелом. Пока
  // режим включал сам человек, это было незаметно; умолчание инсталляции
  // включило бы его всем сразу.
  listenForPtt(ptt);
}

/**
 * Привести дорожку микрофона к формуле `micOn && gateOpen`. Звук демонстрации
 * в том же потоке, но ни мут, ни затвор его не касаются.
 */
function applyTrackState() {
  const live = micOn && gateOpen;
  const screenAudio = around.screenAudioTrack();
  around
    .stream()
    ?.getAudioTracks()
    .forEach((t) => {
      if (t !== screenAudio) t.enabled = live;
    });
}

/**
 * Применить текущий мут к дорожкам исходящего потока и рассказать витрине.
 *
 * Зовётся и снаружи: при входе в канал поток только что собран, а мут на нём
 * уже свой — он переживает выход из эфира (под «глушилкой» микрофон остаётся
 * выключенным).
 */
export function applyMute() {
  applyTrackState();
  around.syncStore();
}

// Поднимает локальный анализатор микрофона. Слушает КЛОН дорожки: выключенная
// дорожка отдаёт тишину всем потребителям, и анализатор на ней самой не
// услышал бы голос, который должен открыть закрытый затвор.
function setupLocalVad() {
  teardownLocalVad();
  if (!micTrack || typeof window === 'undefined') return;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx = getAudioCtx();
    meterTrack = micTrack.clone();
    meterTrack.enabled = true; // клон наследует enabled — а при муте он был бы глухим
    localVadSource = ctx.createMediaStreamSource(new MediaStream([meterTrack]));
    localAnalyser = ctx.createAnalyser();
    localAnalyser.fftSize = ANALYSER_FFT_SIZE;
    localVadGain = ctx.createGain();
    localVadGain.gain.value = 0; // молча: только «протягиваем» сигнал ради анализа
    localVadSource.connect(localAnalyser);
    localAnalyser.connect(localVadGain);
    localVadGain.connect(ctx.destination);
  } catch (err) {
    console.warn('local VAD setup failed:', err);
    teardownLocalVad();
  }
}

function teardownLocalVad() {
  try {
    localVadSource?.disconnect();
    localAnalyser?.disconnect();
    localVadGain?.disconnect();
  } catch {
    /* узлы могли быть уже отключены */
  }
  meterTrack?.stop(); // клон держит устройство так же, как оригинал
  meterTrack = null;
  localVadSource = null;
  localAnalyser = null;
  localVadGain = null;
}

/**
 * Порог, выше которого зажигается обводка «говорю». Это тот же порог, что
 * открывает гейт, — а когда гейт выключен, небольшой пол: иначе обводка горела
 * бы от дыхания.
 */
export function micRingThreshold(): number {
  return micThreshold > 0 ? micThreshold : MIC_RING_FLOOR;
}

/** Поднят ли анализатор своего микрофона. Нет — значит и обводке взяться неоткуда. */
export function hasLocalAnalyser(): boolean {
  return !!localAnalyser;
}

/** Гейт тикает чаще обводки: атака должна быть быстрой, иначе рубит начало слова. */
export function startGate(): void {
  if (!gateTimer) gateTimer = setInterval(evaluateGate, GATE_TICK_MS);
}

/**
 * Прочитать сохранённый порог. Зовётся один раз на приложение: значение
 * применится при следующем входе в эфир.
 */
export function loadMicThreshold(): void {
  const saved =
    typeof localStorage !== 'undefined' ? Number(localStorage.getItem(MIC_THRESHOLD_KEY)) : NaN;
  if (Number.isFinite(saved) && saved >= 0 && saved <= 1) {
    micThreshold = saved;
    useVoiceStore.getState().setMicThreshold(saved);
  }
}

/**
 * Полный выход из эфира: гасим устройство и клон под анализатор. Оба держат
 * микрофон — забудь любой, и лампочка записи не гаснет до перезагрузки вкладки.
 */
export function teardownMic(): void {
  micTrack?.stop();
  micTrack = null;
  gateOpen = true;
  gateOpenUntil = 0;
  teardownLocalVad();
}

'use client';

import { toast } from 'sonner';
import { tx as msg } from '@/lib/i18n';
import { useVoiceStore } from '@/stores/voice';
import {
  ANALYSER_FFT_SIZE,
  analyserRms,
  audioContext,
  getAudioCtx,
  refreshOutputDevices,
} from '@/lib/voice/output';

/**
 * Захват микрофона: устройство, шумовой гейт, push-to-talk, мут и анализатор,
 * по которому зажигается обводка «говорю».
 *
 * Главная сложность здесь одна и она стоит того, чтобы назвать её вслух:
 * дорожек микрофона ДВЕ. Сырая — с устройства, она источник; обработанная —
 * выход цепочки «сырая → gain(затвор) → destination», и именно она уходит
 * собеседникам, когда человек задал порог. Цепочка поднимается лениво: при
 * пороге 0 её нет вовсе и шлётся сырая. Отсюда и все развилки в файле — смена
 * устройства, мут и метки читаются то с одной дорожки, то с другой, и путать
 * их нельзя: у обработанной нет ни label, ни deviceId, а сырая живёт отдельно
 * от исходящего потока и гаснет только вручную.
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
  /** Человекочитаемая причина отказа устройства — формулировки общие с камерой. */
  deviceErrorText(err: unknown): string;
}

let around: MicSurroundings = {
  stream: () => null,
  adopt: () => {},
  screenAudioTrack: () => null,
  replaceTrack: () => {},
  syncStore: () => {},
  announce: () => {},
  deviceErrorText: (err) => String(err),
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
// Шумоподавление — constraint для getUserMedia (по умолчанию вкл); Push-to-talk —
// микрофон открыт, только пока удерживается пробел (по умолчанию выкл). Оба
// значения запоминаются в localStorage и синхронизируются в стор при загрузке.
const NS_KEY = 'relay-noise-suppress';
const PTT_KEY = 'relay-ptt';
let noiseSuppression =
  typeof localStorage !== 'undefined' ? localStorage.getItem(NS_KEY) !== '0' : true;
let pushToTalk =
  typeof localStorage !== 'undefined' ? localStorage.getItem(PTT_KEY) === '1' : false;
let pttHeld = false;

/** Constraint аудио с учётом тоггла шумоподавления (замена статичного AUDIO_CONSTRAINTS). */
function audioConstraints(): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression, autoGainControl: true };
}

// ─── Порог срабатывания микрофона (шумовой гейт, как в Discord) ───────────
// «Сырой» микрофон гоним через GainNode и собеседникам шлём УЖЕ обработанную
// дорожку. Gain здесь работает ЗАТВОРОМ: пока уровень ниже порога — плавно
// закрываемся в 0 (тебя не слышно), выше — открываемся в 1. Цепочку поднимаем
// ЛЕНИВО: при пороге 0 («выкл») отправляется сырая дорожка, гейт не строится.
// Гейт включается, только когда пользователь задаёт порог > 0 (или он сохранён).
// Смена устройства и мут работают через ту же дорожку.
const MIC_THRESHOLD_KEY = 'relay-mic-threshold';
let micThreshold = 0; // 0..1 в шкале метра (0 = гейт выключен); читаем в initVoice
let micPipelineActive = false;
let rawMicTrack: MediaStreamTrack | null = null; // дорожка устройства (для меток и как источник цепочки)
let micSource: MediaStreamAudioSourceNode | null = null;
let micGainNode: GainNode | null = null; // затвор гейта (0/1 с плавным переходом)
let micDest: MediaStreamAudioDestinationNode | null = null;

// Гейт: уровень нормируем в 0..1 (как метр у ползунка), сравниваем с порогом,
// открытие держим ещё чуть-чуть после спада (hold), чтобы хвосты слов не рубило.
const MIC_METER_FULL = 0.5; // RMS, при котором метр (и шкала порога) заполнен
const MIC_RING_FLOOR = 0.12; // мин. уровень для обводки «говорю», когда гейт выключен
const GATE_HOLD_MS = 250;
const GATE_TICK_MS = 50;
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
  rawMicTrack = stream.getAudioTracks()[0] ?? null;
  if (rawMicTrack) rawMicTrack.contentHint = 'speech'; // голос, не музыка
  // Сохранённый порог > 0 — поднимаем цепочку гейта ДО join, чтобы новые пиры
  // сразу получили уже затворённую дорожку.
  if (micThreshold > 0) ensureMicPipeline();
  setupLocalVad(); // анализатор своего микрофона для обводки и гейта
  // Доступ выдан — метки устройств теперь видны, наполняем списки
  void refreshMicInfo();
  refreshOutputDevices();
}

/**
 * Дорожка микрофона, которую РЕАЛЬНО шлём собеседникам (именно микрофон, не звук
 * демонстрации): при поднятой цепочке чувствительности — обработанная, иначе —
 * сырая с устройства. Её мутит `applyMute` и подменяет `setMic`.
 */
function sentMicTrack(): MediaStreamTrack | null {
  const screenAudio = around.screenAudioTrack();
  return around.stream()?.getAudioTracks().find((t) => t !== screenAudio) ?? null;
}

/**
 * Лениво поднимает цепочку «сырой микрофон → gain(чувствительность) → выход» и
 * переводит собеседников на обработанную дорожку. Зовётся, когда пользователь
 * впервые уводит чувствительность с 100% (или при входе, если значение сохранено).
 * Возвращает false, если Web Audio недоступен (тогда остаёмся на сырой дорожке).
 */
function ensureMicPipeline(): boolean {
  if (micPipelineActive) return true;
  if (!around.stream() || typeof window === 'undefined') return false;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;

  const raw = rawMicTrack ?? sentMicTrack();
  if (!raw) return false;

  try {
    const ctx = getAudioCtx();
    micSource = ctx.createMediaStreamSource(new MediaStream([raw]));
    micGainNode = ctx.createGain();
    micGainNode.gain.value = 1; // открыт по умолчанию; гейт прикроет, если тихо
    micDest = ctx.createMediaStreamDestination();
    micSource.connect(micGainNode).connect(micDest);
  } catch (err) {
    console.warn('mic pipeline failed, остаёмся на сырой дорожке:', err);
    micSource = micGainNode = null;
    micDest = null;
    return false;
  }

  const processed = micDest.stream.getAudioTracks()[0];
  processed.enabled = micOn;
  processed.contentHint = 'speech'; // подсказка кодеку/AEC: это голос, не музыка
  rawMicTrack = raw; // сырая дорожка остаётся жить — она источник цепочки (не stop'аем)

  // Переводим уже подключённых собеседников на обработанную дорожку…
  around.replaceTrack(raw, processed);
  // …и подменяем дорожку в исходящем потоке, чтобы новые пиры брали уже её.
  around.stream()!.removeTrack(raw);
  around.stream()!.addTrack(processed);

  micPipelineActive = true;
  return true;
}

/**
 * Порог срабатывания микрофона, 0..1 в шкале метра (0 = гейт выключен, слышно
 * всегда). Чем правее — тем громче надо говорить, чтобы микрофон открылся.
 * Поднимает цепочку лениво; сам затвор ведёт evaluateGate. Выбор — в localStorage.
 */
export function setMicThreshold(value: number) {
  const t = Math.max(0, Math.min(1, value));
  micThreshold = t;
  if (typeof localStorage !== 'undefined') localStorage.setItem(MIC_THRESHOLD_KEY, String(t));
  useVoiceStore.getState().setMicThreshold(t);

  if (t > 0) {
    if (around.stream()) ensureMicPipeline(); // гейту нужна цепочка
  } else if (micGainNode && audioContext()) {
    // Порог 0 — гейт выключаем, микрофон держим открытым.
    gateOpenUntil = 0;
    micGainNode.gain.setTargetAtTime(1, audioContext()!.currentTime, 0.02);
  }
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
 * Шумовой гейт: пока уровень ниже порога — плавно закрываем микрофон в 0, выше —
 * открываем в 1, удерживая открытым ещё GATE_HOLD_MS после спада. Затвор —
 * micGainNode цепочки; setTargetAtTime даёт мягкие атаку/спад без щелчков.
 */
function evaluateGate() {
  const ctx = audioContext();
  if (micThreshold <= 0 || !micPipelineActive || !micGainNode || !ctx) return;
  const now = performance.now();
  if (micOn && micLevelNorm() >= micThreshold) gateOpenUntil = now + GATE_HOLD_MS;
  const open = now < gateOpenUntil;
  micGainNode.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? 0.015 : 0.06);
}

/** Обновляет в сторе активное устройство и список доступных микрофонов. */
export async function refreshMicInfo() {
  const store = useVoiceStore.getState();
  // Метку/девайс берём с СЫРОЙ дорожки устройства: у обработанной (выход
  // MediaStreamDestination) ни label, ни deviceId нет.
  const track = rawMicTrack ?? sentMicTrack();
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
    toast.error(msg('voice.toast.micSwitchFailed', { reason: around.deviceErrorText(err) }));
    return;
  }

  const newTrack = stream.getAudioTracks()[0];
  if (!newTrack) return;
  newTrack.contentHint = 'speech'; // голос, не музыка

  const pipelineCtx = audioContext();
  if (micPipelineActive && micGainNode && pipelineCtx) {
    // Цепочка чувствительности поднята: меняем ИСТОЧНИК, исходящая (обработанная)
    // дорожка остаётся прежней — собеседников переподписывать не нужно.
    newTrack.enabled = true; // сырой источник всегда «течёт», мут — на выходной дорожке
    try {
      micSource?.disconnect();
    } catch {
      /* источник мог быть уже отключён */
    }
    rawMicTrack?.stop();
    micSource = pipelineCtx.createMediaStreamSource(new MediaStream([newTrack]));
    micSource.connect(micGainNode);
    rawMicTrack = newTrack;
  } else {
    // Сырой путь (цепочки нет): подменяем дорожку у всех собеседников и в потоке.
    newTrack.enabled = micOn; // сохраняем текущее состояние «выкл/вкл»
    const oldTrack = sentMicTrack();
    around.replaceTrack(oldTrack, newTrack);
    if (oldTrack) {
      oldTrack.stop();
      around.stream()!.removeTrack(oldTrack);
    }
    around.stream()!.addTrack(newTrack);
    rawMicTrack = newTrack;
  }

  setupLocalVad(); // переподцепляем анализатор обводки к новому устройству
  await refreshMicInfo();
  toast(
    msg('voice.toast.micSwitched', {
      device: newTrack.label || msg('voice.toast.micSwitched.fallback'),
    }),
  );
}

/**
 * Тоггл аппаратного шумоподавления микрофона (модалка настроек, раздел 06).
 * Меняем constraint и, если уже в звонке, переснимаем дорожку текущего устройства.
 */
export async function setNoiseSuppression(on: boolean) {
  noiseSuppression = on;
  if (typeof localStorage !== 'undefined') localStorage.setItem(NS_KEY, on ? '1' : '0');
  useVoiceStore.getState().setNoiseSuppression(on);
  if (around.stream()) await setMic(useVoiceStore.getState().currentMicId ?? '');
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
  if (!pushToTalk) return;
  if (pressed) pttPress();
  else pttRelease();
}

/**
 * Тоггл режима Push-to-talk. При включении глушим микрофон (говоришь только на
 * удержании пробела); при выключении возвращаем микрофон в открытое состояние.
 */
export function setPushToTalk(on: boolean) {
  if (on === pushToTalk) return;
  pushToTalk = on;
  if (typeof localStorage !== 'undefined') localStorage.setItem(PTT_KEY, on ? '1' : '0');
  useVoiceStore.getState().setPushToTalk(on);
  if (typeof window === 'undefined') return;
  if (on) {
    window.addEventListener('keydown', onPttKeyDown);
    window.addEventListener('keyup', onPttKeyUp);
    pttHeld = false;
    if (around.stream() && micOn) {
      micOn = false;
      applyMute();
      around.announce();
    }
  } else {
    window.removeEventListener('keydown', onPttKeyDown);
    window.removeEventListener('keyup', onPttKeyUp);
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
  store.setNoiseSuppression(noiseSuppression);
  store.setPushToTalk(pushToTalk);
}

/**
 * Применить текущий мут к дорожкам исходящего потока.
 *
 * Зовётся и снаружи: при входе в канал поток только что собран, а мут на нём
 * уже свой — он переживает выход из эфира (под «глушилкой» микрофон остаётся
 * выключенным).
 */
export function applyMute() {
  // Микрофон глушим, а звук демонстрации экрана — нет (он не зависит от микрофона)
  const screenAudio = around.screenAudioTrack();
  around.stream()?.getAudioTracks().forEach((t) => {
    if (t === screenAudio) return;
    t.enabled = micOn;
  });
  around.syncStore();
}

// Поднимает локальный анализатор микрофона (независимо от цепочки чувствительности).
// Тихий путь до destination нужен, чтобы граф «тянул» микрофон, — себя мы не слышим.
function setupLocalVad() {
  teardownLocalVad();
  if (!rawMicTrack || typeof window === 'undefined') return;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx = getAudioCtx();
    localVadSource = ctx.createMediaStreamSource(new MediaStream([rawMicTrack]));
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
 * Полный выход из эфира: разбираем цепочку чувствительности и гасим устройство.
 *
 * Сырая дорожка живёт ОТДЕЛЬНО от исходящего потока (когда цепочка активна),
 * поэтому её надо погасить вручную — иначе лампочка записи не гаснет до
 * перезагрузки вкладки.
 */
export function teardownMic(): void {
  try {
    micSource?.disconnect();
    micGainNode?.disconnect();
  } catch {
    /* узлы могли быть уже отключены */
  }
  rawMicTrack?.stop();
  rawMicTrack = null;
  micSource = null;
  micGainNode = null;
  micDest = null;
  micPipelineActive = false;
  gateOpenUntil = 0;
  teardownLocalVad();
}

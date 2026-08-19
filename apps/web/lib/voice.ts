'use client';

import { toast } from 'sonner';
import type { VoicePresence } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getSfx } from '@/lib/sfx';
import {
  isDesktopWindows,
  notifyScreenPicker,
  startNativeScreenAudio,
  stopNativeScreenAudio,
} from '@/lib/desktop-screen-audio';
import { useUiStore, myName } from '@/stores/ui';
import { loadClientId } from '@/lib/identity';
import { tx as msg } from '@/lib/i18n';
import type { MessageKey, Vars } from '@/lib/i18n/translate';
import { useVoiceStore, type ScreenMode } from '@/stores/voice';
import { createMeshTransport } from '@/lib/voice/mesh';
import { voiceSupport } from '@/lib/voice-support';
import { diag } from '@/lib/voice/diag';
import {
  ANALYSER_FFT_SIZE,
  attachRemoteAudio,
  audioContext,
  cleanupPeerAudio,
  detachRemoteAudio,
  getAudioCtx,
  initOutput,
  isSpeakersOn,
  peerVoiceAnalysers,
  refreshOutputDevices,
  setPeerGain,
  setSpeakersOn,
  teardownPeerAudio,
} from '@/lib/voice/output';

// Микшер входящего звука и устройство вывода живут в `voice/output.ts`. Наружу
// уезжают отсюда: компоненты знают один адрес, `@/lib/voice`.
export { refreshSpeakers, resumeVoiceAudio, setSpeaker } from '@/lib/voice/output';
import type { TransportHost, VoiceTicket, VoiceTransport } from '@/lib/voice/types';
import {
  addTile,
  clearFocus,
  clearTiles,
  dropRemoteTiles,
  initTiles,
  relabelSelf as relabelTile,
  remoteCount,
  removeTile,
  renameTile,
  roleOf,
  savePeerVol,
  setTileNet,
  setTileScreen,
  setTileState,
  setTileVideoOn,
  syncPeerRoles,
  tileOf,
} from '@/lib/voice/tiles';

// Плитки, роли собеседников, громкости и крупный план живут в `voice/tiles.ts`
// — это витрина, и дирижёру от неё нужно только уметь её звать. Наружу они
// уезжают отсюда же: компоненты знают один адрес, `@/lib/voice`.
export {
  clearFocus,
  PEER_VOL_MAX,
  setFocus,
  setPeerScreenVolume,
  setPeerVolume,
  toggleFocus,
} from '@/lib/voice/tiles';

const sfx = () => getSfx();

/**
 * Дирижёр голосового канала: устройства (микрофон/камера/экран), шумовой гейт и
 * PTT, микшер входящего звука, индикация «говорит сейчас», плитки. Императивное
 * состояние (MediaStream, узлы Web Audio) живёт здесь модульными переменными,
 * наружу отдаём реактивную «витрину» через `useVoiceStore`, которую рисуют
 * VideoGrid/Controls/Members.
 *
 * Доставку медиа собеседникам дирижёр НЕ делает сам — этим занят транспорт за
 * интерфейсом `VoiceTransport` (`lib/voice/types.ts`). Сегодня это mesh
 * (`lib/voice/mesh.ts`), рядом с ним встанет SFU — см. docs/plans/old/sfu.md.
 *
 * SFX-звуки эфира (join/leave/peer/error/reconnect/connLost) подключены здесь
 * через пул `lib/sfx`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Константы медиа/SDP
// ─────────────────────────────────────────────────────────────────────────

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { max: 30 },
};

const SCREEN_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 60, max: 60 },
};
// echoCancellation: true — лекарство от «кенты слышат сами себя». При захвате
// системного/вкладочного звука в микс попадают голоса собеседников, которые
// играют из ДИНАМИКОВ ведущего; без AEC мы шлём их обратно — и каждый слышит
// собственное эхо. Chrome прогоняет захват демонстрации через свой эхоканцеллер,
// опираясь на то, что сам же воспроизводит (входящий WebRTC-звук), и вычитает его.
// Полностью петля уходит только в наушниках — об этом ведущему стоит напомнить,
// но AEC убирает основную часть и на колонках. noiseSuppression/autoGainControl
// держим выключенными, чтобы не «жевать» музыку/фильм при показе.
const SCREEN_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};
// ─────────────────────────────────────────────────────────────────────────
// Императивное состояние дирижёра (модульные глобалы)
// ─────────────────────────────────────────────────────────────────────────

let room: string | null = null;
let localStream: MediaStream | null = null;
let micOn = true;
let camOn = false;
let screenOn = false;
let camTrack: MediaStreamTrack | null = null;
let screenTrack: MediaStreamTrack | null = null;
let screenAudioTrack: MediaStreamTrack | null = null;
let screenMode: ScreenMode = 'quality';

/**
 * Слушатель: мы пришли по инвайту в канал закрытого сервера. Слышим комнату,
 * но своего медиа не отдаём — микрофон не просим вовсе (браузер и не спросит),
 * камеру и демонстрацию не показываем. Право это выдаёт сервер подписью в
 * гостевом токене, здесь оно только объявлено: настоящие заслоны стоят на
 * медиасервере (`produce` получает отказ) и у собеседников (входящий звук
 * слушателя они отбрасывают). Ставится один раз гостевой сценой до входа.
 */
let listenOnly = false;

// ─── Настройки медиа (модалка настроек, раздел 06 референса) ───────────────
// Шумоподавление — constraint для getUserMedia (по умолчанию вкл); Push-to-talk —
// микрофон открыт, только пока удерживается пробел (по умолчанию выкл). Оба
// значения запоминаются в localStorage и синхронизируются в стор при загрузке.
const NS_KEY = 'relay-noise-suppress';
const CAM_KEY = 'relay-cam-id';
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

let initialized = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;

const socket = () => getSocket();

// Транспорты медиа. Оба создаются лениво (host ссылается на функции ниже по
// файлу) и живут всё время работы приложения; активен всегда ровно один — его
// выбирает `pickTransport` при входе в канал, по режиму самого канала.
//
// Mesh при этом подписан на сигналинг всегда, но реагирует, только пока в нём
// есть комната: войдя в SFU-канал, мы ему `join` не даём, и приходящие
// `peers`/`offer` он игнорирует.
let meshTransport: VoiceTransport | null = null;
let sfuTransport: VoiceTransport | null = null;
let transport: VoiceTransport | null = null;

function mesh(): VoiceTransport {
  if (!meshTransport) {
    meshTransport = createMeshTransport(host);
    meshTransport.init();
  }
  return meshTransport;
}

// Грузим по требованию: `mediasoup-client` весит заметно, а self-host без
// медиасервера живёт целиком на p2p — незачем возить его в общем бандле тем,
// кто ни разу не зайдёт в SFU-канал.
async function sfu(): Promise<VoiceTransport> {
  if (!sfuTransport) {
    const { createSfuTransport } = await import('@/lib/voice/sfu');
    sfuTransport = createSfuTransport(host);
    sfuTransport.init();
  }
  return sfuTransport;
}

/** Активный транспорт. Вне звонка — mesh: он и по умолчанию, и на фолбэк. */
function tx(): VoiceTransport {
  return transport ?? mesh();
}

/**
 * То, что транспорт вправе спросить у дирижёра: локальные дорожки на отправку и
 * витрину на приём. Единственная дверь между ними — что и позволит подставить
 * вместо mesh реализацию на SFU, не трогая ни UI, ни устройства.
 */
const host: TransportHost = {
  localStream: () => localStream,
  screenAudioTrack: () => screenAudioTrack,
  videoTrack: () => currentVideoTrack(),
  camOn: () => camOn,
  screenOn: () => screenOn,
  screenDegradation: () => screenDegradation(),

  addTile,
  removeTile,
  setTileState,
  setTileNet,
  cleanupPeerAudio,
  attachRemoteAudio,
  detachRemoteAudio,
  transportLost: onTransportLost,
  diag,
  setStatus,
  setPing: (ping) => useVoiceStore.getState().setPing(ping),
  setUplink: (status) => useVoiceStore.getState().setUplink(status),
  playSfx: (name) => sfx().play(name),
};

// ─── Детект «говорит сейчас» (обводка плитки, как в Discord) ──────────────
// Снимаем RMS-уровень с анализаторов (свой микрофон + голос каждого собеседника)
// и зажигаем обводку выше порога, удерживая её ещё чуть-чуть после паузы, чтобы
// не мигала между словами.
const VAD_THRESHOLD = 0.04; // RMS 0..1: речь обычно выше, тишина/шумодав — ниже
const VAD_HANGOVER_MS = 300; // держим обводку после спада уровня
const VAD_TICK_MS = 100;

let localAnalyser: AnalyserNode | null = null;
let localVadSource: MediaStreamAudioSourceNode | null = null;
let localVadGain: GainNode | null = null;
let vadBuf: Uint8Array<ArrayBuffer> | null = null;
let vadTimer: ReturnType<typeof setInterval> | null = null;
const spokeAt = new Map<string, number>();
let lastSpeakingKey = '';

/**
 * Обновляет videoOn локальной плитки и рассылает собеседникам полное медиасостояние
 * (видео + мут/глушилка). Сервер запоминает мут на сокете и раздаёт его через
 * voice-presence — индикаторы в сайдбаре видят даже те, кто сам не в эфире.
 */
function broadcastMediaState() {
  const on = camOn || screenOn;
  setTileVideoOn('local', on);
  if (room) socket().emit('media-update', { camOn, screenOn, micOn, deafened: !isSpeakersOn() });
}

function setStatus(key: MessageKey, vars?: Vars) {
  useVoiceStore.getState().setStatus({ key, vars });
}

// ─────────────────────────────────────────────────────────────────────────
// Доступ к камере/микрофону
// ─────────────────────────────────────────────────────────────────────────

function mediaErrorText(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return msg('media.error.denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return msg('media.error.notFound');
    case 'NotReadableError':
    case 'TrackStartError':
      return msg('media.error.busy');
    case 'OverconstrainedError':
      return msg('media.error.constraints');
    case 'SecurityError':
      return msg('media.error.insecure');
    case 'AbortError':
      return msg('media.error.timeout');
    default:
      return e?.message || msg('media.error.unknown');
  }
}

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
async function ensureLocalStream(): Promise<void> {
  if (localStream) return;
  if (!micPending) {
    micPending = acquireMic().finally(() => {
      micPending = null;
    });
  }
  const stream = await micPending;
  if (localStream) return; // нас опередил другой заход — поток уже принят

  localStream = stream;
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
 * сырая с устройства. Её мутит applyMicState и подменяет setMic.
 */
function sentMicTrack(): MediaStreamTrack | null {
  return localStream?.getAudioTracks().find((t) => t !== screenAudioTrack) ?? null;
}

/**
 * Лениво поднимает цепочку «сырой микрофон → gain(чувствительность) → выход» и
 * переводит собеседников на обработанную дорожку. Зовётся, когда пользователь
 * впервые уводит чувствительность с 100% (или при входе, если значение сохранено).
 * Возвращает false, если Web Audio недоступен (тогда остаёмся на сырой дорожке).
 */
function ensureMicPipeline(): boolean {
  if (micPipelineActive) return true;
  if (!localStream || typeof window === 'undefined') return false;
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
  tx().replaceMicTrack(raw, processed);
  // …и подменяем дорожку в localStream, чтобы новые пиры брали уже её.
  localStream.removeTrack(raw);
  localStream.addTrack(processed);

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
    if (localStream) ensureMicPipeline(); // гейту нужна цепочка
  } else if (micGainNode && audioContext()) {
    // Порог 0 — гейт выключаем, микрофон держим открытым.
    gateOpenUntil = 0;
    micGainNode.gain.setTargetAtTime(1, audioContext()!.currentTime, 0.02);
  }
}

/** Текущий уровень микрофона в шкале метра (0..1, sqrt-кривая — тихое заметнее). */
function micLevelNorm(): number {
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
async function refreshMicInfo() {
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
 * Переключает глобальный мут всех звуков сайта (пиры + sfx) — режим «глушилки»
 * (deafen, как в Discord). Выключил звук — микрофон гаснет автоматически (не
 * слышишь — не говоришь); включил обратно — микрофон возвращается в то
 * состояние, в котором был до глушилки.
 */
export function toggleSpeakers() {
  const on = !isSpeakersOn();
  setSpeakersOn(on);
  getSfx().setAllMuted(!on);
  // «Не слышишь — не говоришь»: это правило дирижёра, а не микшера. Микшер
  // знает только про мастер-громкость, микрофон ему не принадлежит.
  if (!on) {
    micWasOnBeforeDeafen = micOn;
    micOn = false;
  } else {
    micOn = micWasOnBeforeDeafen;
  }
  applyMicState();
  broadcastMediaState();
}

// Был ли включён микрофон до «глушилки» — чтобы вернуть его при включении звука.
let micWasOnBeforeDeafen = true;

/**
 * Переключение микрофона на лету: новый getUserMedia + replaceTrack у всех
 * собеседников без пересборки SDP. Выбор запоминаем в localStorage.
 */
export async function setMic(deviceId: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MIC_KEY, deviceId);

  // Не в звонке — просто запомнили выбор, применится при следующем входе
  if (!localStream) return;

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

  const ctx = audioContext();
  if (micPipelineActive && micGainNode && ctx) {
    // Цепочка чувствительности поднята: меняем ИСТОЧНИК, исходящая (обработанная)
    // дорожка остаётся прежней — собеседников переподписывать не нужно.
    newTrack.enabled = true; // сырой источник всегда «течёт», мут — на выходной дорожке
    try {
      micSource?.disconnect();
    } catch {
      /* источник мог быть уже отключён */
    }
    rawMicTrack?.stop();
    micSource = ctx.createMediaStreamSource(new MediaStream([newTrack]));
    micSource.connect(micGainNode);
    rawMicTrack = newTrack;
  } else {
    // Сырой путь (цепочки нет): подменяем дорожку у всех собеседников и в localStream.
    newTrack.enabled = micOn; // сохраняем текущее состояние «выкл/вкл»
    const oldTrack = sentMicTrack();
    tx().replaceMicTrack(oldTrack, newTrack);
    if (oldTrack) {
      oldTrack.stop();
      localStream.removeTrack(oldTrack);
    }
    localStream.addTrack(newTrack);
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
  if (localStream) await setMic(useVoiceStore.getState().currentMicId ?? '');
}

// ─── Камера: список устройств и выбор (модалка настроек) ───────────────────
/** Обновляет список камер (videoinput) и активную камеру в сторе. */
async function refreshCameraInfo() {
  const store = useVoiceStore.getState();
  const settings = camTrack?.getSettings?.();
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(CAM_KEY) : null;
  store.setCurrentCamera(settings?.deviceId ?? saved, camTrack?.label ?? '');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    store.setCameras(devices.filter((d) => d.kind === 'videoinput'));
  } catch {
    /* enumerateDevices недоступен — список останется пустым */
  }
}

/** Перечитать список камер (для UI). */
export function refreshCameras() {
  void refreshCameraInfo();
}

/**
 * Переключить камеру. Выбор запоминаем; если камера включена — перезапускаем её
 * с новым устройством (startCamera читает сохранённый deviceId).
 */
export async function setCamera(deviceId: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(CAM_KEY, deviceId);
  if (camOn) {
    stopCamera();
    await startCamera();
    broadcastMediaState();
    syncMediaState();
  } else {
    void refreshCameraInfo();
  }
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
  if (!localStream || micOn) return;
  micOn = true;
  applyMicState();
  broadcastMediaState();
}

function pttRelease() {
  if (!pttHeld) return;
  pttHeld = false;
  if (!localStream) return;
  micOn = false;
  applyMicState();
  broadcastMediaState();
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
    if (localStream && micOn) {
      micOn = false;
      applyMicState();
      broadcastMediaState();
    }
  } else {
    window.removeEventListener('keydown', onPttKeyDown);
    window.removeEventListener('keyup', onPttKeyUp);
    if (localStream && !micOn) {
      micOn = true;
      applyMicState();
      broadcastMediaState();
    }
  }
}

/** Синхронизировать тогглы настроек из localStorage в стор (при монтировании модалки). */
export function loadMediaPrefs() {
  const store = useVoiceStore.getState();
  store.setNoiseSuppression(noiseSuppression);
  store.setPushToTalk(pushToTalk);
}

// ─────────────────────────────────────────────────────────────────────────
// Демонстрация экрана: режим качество/ФПС
// ─────────────────────────────────────────────────────────────────────────

function screenDegradation(): RTCDegradationPreference {
  return screenMode === 'fps' ? 'maintain-framerate' : 'maintain-resolution';
}
function screenContentHint(): string {
  return screenMode === 'fps' ? 'motion' : 'detail';
}

export function setScreenMode(mode: ScreenMode) {
  if (mode === screenMode) return;
  screenMode = mode;
  useVoiceStore.getState().setMedia({ screenMode });
  // Применяем к уже идущей трансляции без переподписания SDP
  if (!screenOn || !screenTrack) return;
  screenTrack.contentHint = screenContentHint();
  tx().retuneVideo();
}

// ─────────────────────────────────────────────────────────────────────────
// Вступление в голосовой канал
// ─────────────────────────────────────────────────────────────────────────

/**
 * Спрашиваем у api пропуск в медиасервер для канала. Ответ и есть выбор
 * транспорта: пропуск дали — канал в режиме SFU и сервер поднят; отказали
 * (`not-sfu`, `unavailable`) — идём в mesh, это штатный путь, а не ошибка.
 *
 * Таймаут короткий и намеренный: канал в SFU-режиме, но api молчит — звонок не
 * должен из-за этого ждать. Молчание = mesh.
 */
async function requestSfuTicket(targetRoom: string): Promise<VoiceTicket | null> {
  try {
    // Имя — в запросе: `join` ещё не случился, серверу его больше взять неоткуда.
    const res = await socket()
      .timeout(3000)
      .emitWithAck('sfu-token', { room: targetRoom, name: myName() });
    if (!res.ok) {
      // 'not-sfu' — штатный p2p-канал; остальные отказы означают, что канал
      // ЖДАЛ медиасервер, а мы уезжаем в p2p — веху обязан увидеть сервер.
      if (res.error !== 'not-sfu') diag('sfu-ticket denied', res.error);
      return null;
    }
    return { url: res.url, token: res.token };
  } catch {
    diag('sfu-ticket timeout'); // api не ответил вовремя — звоним напрямую
    return null;
  }
}

// Порог мягкого переезда в p2p, когда медиасервер умер посреди звонка. Двое-
// трое собеседников mesh переживёт; на 4+ с видео он даёт ровно ту боль, ради
// которой SFU и затевался, — там честнее ждать сервер, чем задушить всех
// аплинком. Считаем собеседников, себя не учитываем.
const MESH_FALLBACK_MAX_PEERS = 3;
const SFU_RETRY_MS = 5000;
let sfuRetryTimer: ReturnType<typeof setTimeout> | null = null;

function leaveTransports() {
  meshTransport?.leave();
  sfuTransport?.leave();
  transport = null;
}

/**
 * Номер текущего переезда. Между «отцепиться от старого транспорта» и
 * «объявиться на новом» есть await (запрос пропуска, загрузка чанка mediasoup), и
 * за это время вполне прилетает второй переезд: владелец щёлкнул режим канала
 * дважды, следом упал медиасервер. Обгонять себя тут нельзя — старый переезд
 * доехал бы уже после нового и оставил бы позади живой сокет медиасервера при
 * mesh-плитках, то есть звонок без звука и без пути назад. Каждый переезд берёт
 * номер и сходит с дистанции, увидев, что появился следующий.
 */
let migration = 0;

/**
 * Подключить транспорт к комнате и объявиться на сигналинге. Пропуск = выбор
 * транспорта: он есть — идём в SFU, нет — в mesh.
 *
 * `gen` спрашиваем, а не берём сами: номер принадлежит тому заходу или переезду,
 * который сюда привёл, и взять его здесь — значит объявить себя последним уже
 * после того, как нас обогнали.
 */
async function enterRoom(target: string, ticket: VoiceTicket | null, gen: number) {
  // Транспорт медиасервера может не подняться у нас самих: чанк
  // `mediasoup-client` весит заметно и грузится по требованию, а сеть на входе в
  // канал — та же, что только что моргнула. Бросать на этом весь заход нельзя:
  // канал у человека уже открыт, и остаться в нём без единого `join` — это
  // «подключено» с полной тишиной и без пути назад. Едем прямыми звонками, как
  // при любом другом отказе медиасервера.
  let pass = ticket;
  let next: VoiceTransport;
  try {
    next = pass ? await sfu() : mesh();
  } catch (err) {
    diag('sfu start failed', String((err as Error)?.message ?? err));
    next = mesh();
    pass = null;
  }
  if (room !== target || gen !== migration) return; // ушли в другой канал/переезд
  // Транспорт, который мы сменяем, обязан уйти сам. Просто перестать на него
  // смотреть — не то же самое, что выйти: он держит свой сокет, свои дорожки и
  // наш микрофон, то есть продолжает звонить в комнату, из которой мы ушли.
  if (transport && transport !== next) transport.leave();
  transport = next;
  next.join(target, pass ?? undefined);
  socket().emit('join', {
    room: target,
    name: myName(),
    clientId: loadClientId(),
    // Транспорт — в join: сервер раздаст его остальным в presence. Иначе
    // разъехавшиеся участники видят друг друга в канале и молча не слышат.
    transport: pass ? 'sfu' : 'p2p',
  });
  // После join: сервер уже знает имя и впишет его в строку лога.
  diag('transport', `${pass ? 'sfu' : 'mesh'} room="${target}"`);
  // Сразу за join — своё медиасостояние: сервер только что сбросил его, а мут/
  // глушилка могли остаться с прошлого канала.
  broadcastMediaState();
  setStatus('voice.status.connected', { room: target });
}

/**
 * Переезд на другой транспорт, не выходя из канала: сюда сходятся фолбэк на
 * p2p, возвращение медиасервера и смена режима канала владельцем. Звук пропадёт
 * на пару секунд — это дешевле, чем мост между транспортами.
 */
async function remigrate(force?: 'mesh') {
  const target = room;
  if (!target) return;
  const gen = ++migration;
  holdSplitChecks();
  cancelSfuRetry();
  leaveTransports();
  dropRemoteTiles();
  const ticket = force === 'mesh' ? null : await requestSfuTicket(target);
  if (room !== target || gen !== migration) return; // нас обогнал следующий переезд
  await enterRoom(target, ticket, gen);
  if (gen !== migration) return;
  // Осадку считаем от СВОЕГО приезда: остальные едут своим ходом, и тот, у кого
  // пропуск выписывался дольше всех, ещё в дороге.
  holdSplitChecks();
}

function cancelSfuRetry() {
  if (sfuRetryTimer) clearTimeout(sfuRetryTimer);
  sfuRetryTimer = null;
}

/** Ждём возвращения медиасервера, пока канал слишком велик для прямых звонков. */
function scheduleSfuRetry() {
  cancelSfuRetry();
  sfuRetryTimer = setTimeout(() => {
    sfuRetryTimer = null;
    void (async () => {
      const target = room;
      if (!target) return;
      // Круг ожидания принадлежит ТОМУ звонку, в котором начался. Отменить его
      // после `await` уже нечем (таймер отработал, тело живёт само), а комната
      // за эти секунды успевает смениться и даже вернуться той же: человек
      // вышел и зашёл снова. Раньше сходства слага хватало, чтобы запоздавший
      // круг разобрал заново собранный звонок и пересобрал его поверх себя.
      const gen = migration;
      const ticket = await requestSfuTicket(target);
      if (room !== target || gen !== migration) return;
      if (!ticket) {
        scheduleSfuRetry(); // всё ещё лежит — заходим на следующий круг
        return;
      }
      diag('sfu-retry', 'ok — moving back to sfu');
      const moving = ++migration;
      holdSplitChecks();
      leaveTransports();
      dropRemoteTiles();
      await enterRoom(target, ticket, moving);
      if (moving !== migration) return;
      holdSplitChecks();
      toast.success(msg('voice.toast.sfuBack'));
    })();
  }, SFU_RETRY_MS);
}

// Комната разъехалась в транспортах: часть через медиасервер, часть напрямую.
// Слышать друг друга такие участники не могут в принципе — это не деградация
// качества, а полная тишина, причём выглядящая как «он в канале, но молчит».
// Съезжаем в p2p всей комнатой: он собирает всех, тогда как медиасервер собрать
// не всех может (старый клиент про него не знает, у кого-то он не поднялся).
// Но только пока комната мала: тащить туда 4+ — ровно та боль, ради которой SFU
// и заводился, там честнее сказать правду и оставить как есть.
let splitHandled = false;

// Комната переезжает не мгновенно и не у всех разом: пока идёт переезд,
// участники НЕИЗБЕЖНО оказываются на разных транспортах — один уже в
// медиасервере, другой ещё ждёт пропуск (до трёх секунд). Это середина переезда,
// а не расщепление, и фолбэк на него — та самая кнопка «оборвать звонок»: первый
// переехавший тут же тащил себя обратно в mesh, за ним второй, и комната
// расходилась по транспортам уже всерьёз, без пути назад. Поэтому на время
// переезда разбор расщепления откладываем — но именно откладываем, а не
// пропускаем: осевшее расщепление обязано быть замечено, даже если нового
// presence больше не придёт.
const MIGRATION_SETTLE_MS = 6000;
let settleUntil = 0;
let splitTimer: ReturnType<typeof setTimeout> | null = null;
let lastPresence: VoicePresence = {};

/** Отложить разбор расщепления: комната сейчас переезжает. */
function holdSplitChecks() {
  settleUntil = Math.max(settleUntil, Date.now() + MIGRATION_SETTLE_MS);
}

function cancelSplitCheck() {
  if (splitTimer) clearTimeout(splitTimer);
  splitTimer = null;
}

/** Вернуться к разбору расщепления, когда комната осядет. */
function scheduleSplitCheck(ms: number) {
  cancelSplitCheck();
  splitTimer = setTimeout(() => {
    splitTimer = null;
    if (!room) return;
    const wait = settleUntil - Date.now();
    if (wait > 0) {
      scheduleSplitCheck(wait); // переезд успел продлиться — ждём дальше
      return;
    }
    evaluateSplit();
  }, ms);
}

function onPresence(presence: VoicePresence) {
  useVoiceStore.getState().setPresence(presence);
  lastPresence = presence;
  syncPeerRoles(presence, room);
  if (!room) {
    splitHandled = false;
    cancelSplitCheck();
    return;
  }
  const wait = settleUntil - Date.now();
  if (wait > 0) {
    scheduleSplitCheck(wait);
    return;
  }
  evaluateSplit();
}

/**
 * Выгнать гостя из эфира. Право проверяет сервер (любой НЕ-гость, кому виден
 * канал); здесь — только отправка и внятный ответ человеку.
 */
export function kickGuest(peerId: string, name: string) {
  socket().emit('guest-kick', { id: peerId }, (res) => {
    if (res?.ok) toast(msg('members.kick.done', { name }));
    else if (res?.error === 'not-found') toast(msg('members.kick.gone', { name }));
    else toast.error(msg('members.kick.failed'));
  });
}

function evaluateSplit() {
  if (!room) return;
  // Транспорт ещё не выбран: идёт заход или переезд, пропуск в пути. «Нет
  // транспорта» — это не «звоню напрямую», а сравнивать нам пока не с чем.
  // Раньше это читалось как p2p, и заход в людной SFU-канал встречал человека
  // красной ошибкой «тебя не слышат» ещё до того, как он куда-либо подключился.
  // Не бросаем, а откладываем: расщепление обязано быть замечено и после.
  if (!transport) {
    scheduleSplitCheck(MIGRATION_SETTLE_MS);
    return;
  }
  const myId = socket().id;
  const others = (lastPresence[room] ?? []).filter((p) => p.id !== myId);
  const mine = transport === sfuTransport ? 'sfu' : 'p2p';
  const apart = others.filter((p) => (p.transport ?? 'p2p') !== mine);
  if (apart.length === 0) {
    splitHandled = false;
    return;
  }
  if (splitHandled) return; // уже отреагировали на это расщепление
  splitHandled = true;
  const names = apart.map((p) => p.name || msg('voice.peer.fallback')).join(', ');
  diag('transport split', `me=${mine} apart=${apart.length} (${names})`);
  if (mine === 'sfu' && others.length <= MESH_FALLBACK_MAX_PEERS) {
    toast(msg('voice.toast.peersDirect', { names }));
    void remigrate('mesh');
    return;
  }
  // Съезжать некуда: либо нас слишком много для прямых звонков, либо напрямую
  // звоним как раз мы. Молчать нельзя — человек должен понимать, почему тишина.
  toast.error(
    mine === 'sfu' ? msg('voice.toast.peerCannotHear', { names }) : msg('voice.toast.youAreDirect'),
  );
  sfx().play('error');
}

/**
 * SFU-транспорт исчерпал свою лестницу восстановления. Решение принимаем здесь:
 * только дирижёр знает состав канала и владеет комнатой.
 */
function onTransportLost(reason: 'setup' | 'lost') {
  if (!room || transport !== sfuTransport) return;
  // На входе — всегда в p2p: человек ещё никого не слышал, ждать ему нечего.
  if (reason === 'setup' || remoteCount() <= MESH_FALLBACK_MAX_PEERS) {
    diag('sfu-lost', `${reason} → mesh fallback`);
    toast.error(msg('voice.toast.sfuDownDirect'));
    sfx().play('error');
    void remigrate('mesh');
    return;
  }
  diag('sfu-lost', `${reason} → waiting for sfu (${remoteCount()} peers)`);
  toast.error(msg('voice.toast.sfuDownWaiting'));
  sfx().play('error');
  setStatus('voice.status.sfuWaiting');
  scheduleSfuRetry();
}

/**
 * Объявить себя слушателем — гостевая сцена делает это до входа, прочитав
 * право из подписанного инвайт-токена (см. GuestStage). Меняет ровно две вещи:
 * микрофон не берём и микрофон считаем выключенным. Всё остальное — обычный
 * звонок: слушателя видно в составе канала, он слышит всех и уходит как все.
 */
export function setListenOnly(on: boolean) {
  listenOnly = on;
  if (!on) return;
  micOn = false;
  useVoiceStore.getState().setListenOnly(true);
  syncMediaState();
}

export async function joinVoice(newRoom: string, label: string) {
  // Уже на связи в этой комнате — значит, мы просто смотрели текст: показываем сетку
  if (newRoom === room) {
    useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });
    return;
  }

  // Возможности движка проверяем ДО микрофона: в WebKitGTK без WebRTC
  // getUserMedia отработает, а RTCPeerConnection нет — раньше это давало вход в
  // канал с зажжённым микрофоном и полной тишиной без единой ошибки.
  const support = voiceSupport();
  if (!support.ok) {
    toast.error(msg('voice.toast.joinFailed', { reason: support.message }));
    setStatus('voice.status.unsupported');
    sfx().play('error');
    return;
  }

  // Заход — не одно действие: впереди два ожидания подряд (устройство, пропуск
  // в медиасервер), и на каждом человек успевает щёлкнуть соседний канал. Заход
  // берёт номер и сходит с дистанции, увидев, что появился следующий, — тем же
  // способом, что и переезд (см. `migration`). Сравнения слагов тут мало:
  // «щёлкнул соседний канал и вернулся» даёт тот же слаг у обоих заходов, и
  // обогнанный доезжает ПОСЛЕ нового, вставая поверх него — с живым сокетом
  // второго транспорта за спиной.
  if (room) leaveVoice(false); // мягко переключаемся между голосовыми — поток живёт
  const gen = ++migration;

  if (!localStream && listenOnly) {
    // Слушателю устройство не нужно, и спрашивать его — врать: отдать эту
    // дорожку всё равно некуда. Пустой поток не заглушка, а честная форма того
    // же состояния: транспорт спрашивает у дирижёра локальные дорожки и
    // получает пустой набор (см. mesh: он попросит приём отдельно).
    localStream = new MediaStream();
  }
  if (!localStream) {
    setStatus('voice.status.micRequesting');
    try {
      await ensureLocalStream();
    } catch (err) {
      console.error('getUserMedia failed:', err);
      setStatus('voice.status.micDenied');
      toast.error(msg('voice.toast.joinFailedMic', { reason: mediaErrorText(err) }));
      sfx().play('error'); // отказано в доступе к устройству
      return;
    }
    if (gen !== migration) return; // пока ждали микрофон, ушли в другой канал
  }

  room = newRoom;

  useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });

  addTile('local', msg('common.you', { name: myName() }), localStream, true);
  applyMicState();
  syncMediaState();

  // Транспорт выбираем ДО `join`: сразу за ним сервер пришлёт состав комнаты, и
  // к этому моменту должно быть решено, кто его слушает. Спрашиваем у api — не
  // у своего реестра каналов: гость по инвайту реестра не получает вовсе, а
  // разъехавшись с остальными в транспорте, он останется без звука.
  const ticket = await requestSfuTicket(newRoom);
  if (room !== newRoom || gen !== migration) return; // нас обогнал следующий заход
  await enterRoom(newRoom, ticket, gen);
  if (room !== newRoom || gen !== migration) return;
  sfx().play('join'); // вышли на связь

  // Подсказка про смену микрофона — один раз, чтобы знали, где переключить.
  // Слушателю её не показываем: у него нет ни микрофона, ни самой кнопки, на
  // которую она указывает.
  if (
    !listenOnly &&
    typeof localStorage !== 'undefined' &&
    !localStorage.getItem('relay-mic-hint')
  ) {
    localStorage.setItem('relay-mic-hint', '1');
    toast(msg('voice.toast.micHint'), { duration: 7000 });
  }
}

// hard=true — полная демобилизация (освобождаем камеру/микрофон, меняем вид).
// hard=false — мягкий выход при переключении голосовых: поток и вид оставит вызывающий.
export function leaveVoice(hard = true) {
  if (hard && room) sfx().play('leave'); // покидаем звонок (не при смене канала)
  cancelSfuRetry();
  splitHandled = false;
  // Незавершённый переезд обязан сойти с дистанции вместе с нами: доехав уже
  // после выхода, он объявился бы в покинутой комнате.
  migration++;
  cancelSplitCheck();
  settleUntil = 0;
  lastPresence = {};
  if (room) socket().emit('leave');
  leaveTransports(); // следующий вход выберет транспорт заново
  teardownPeerAudio();
  clearFocus();
  clearTiles();
  room = null;

  if (!hard) return;

  // Камеру и микрофон освобождаем только при полном выходе
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  // Разбираем цепочку чувствительности. Сырая дорожка живёт ОТДЕЛЬНО от
  // localStream (когда цепочка активна), поэтому её надо погасить вручную.
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
  spokeAt.clear();
  lastSpeakingKey = '';
  useVoiceStore.getState().setSpeakingIds([]);
  if (camTrack) {
    camTrack.onended = null;
    camTrack = null;
  }
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack = null;
  }
  screenAudioTrack = null;
  screenOn = false;
  // Микрофон к следующему входу включаем, но глушилка переживает выход из эфира —
  // под ней микрофон остаётся выключенным (не слышишь — не говоришь). Слушателю
  // включать нечего: права говорить выход из канала ему не добавил.
  micOn = !listenOnly && isSpeakersOn();
  micWasOnBeforeDeafen = true;
  camOn = false;
  syncMediaState();

  // Голос отключили, но текстовый канал мог остаться открытым — показываем его
  const ui = useUiStore.getState();
  if (ui.textRoom) {
    useUiStore.setState({ view: 'text', voiceRoom: null, voiceLabel: '' });
    setStatus('voice.status.inTextChannel', { channel: ui.textLabel || '# ' + ui.textRoom });
  } else {
    useUiStore.setState({ view: 'lobby', voiceRoom: null, voiceLabel: '' });
    setStatus('voice.status.disconnected');
  }
}

/**
 * Смена тега на лету: обновляем подпись своей плитки и шлём серверу rename —
 * тот обновит presence голосового канала и ростер текстового, а собеседникам
 * разошлёт peer-renamed (подписи наших плиток у них).
 */
/**
 * Подпись своей плитки. Ярлык собирает дирижёр: «ты» рядом с именем — это его
 * формулировка, а не свойство плитки.
 */
export function relabelSelf(name: string) {
  relabelTile(msg('common.you', { name }));
}

export function renameSelf(name: string) {
  relabelSelf(name);
  socket().emit('rename', { name });
}

/**
 * Клик по статусу в панели голоса — вернуться к видеосетке. На мобиле это ещё и
 * переход на экран сцены: сама панель голоса живёт в сайдбаре, то есть жмут её
 * с экрана каналов.
 */
export function showVoiceStage() {
  if (!room) return;
  useUiStore.setState({ view: 'voice', mobilePanel: 'stage' });
}

// ─────────────────────────────────────────────────────────────────────────
// Микрофон / камера / демонстрация экрана
// ─────────────────────────────────────────────────────────────────────────

function syncMediaState() {
  useVoiceStore.getState().setMedia({ micOn, camOn, screenOn, screenMode });
}

function applyMicState() {
  // Микрофон глушим, а звук демонстрации экрана — нет (он не зависит от микрофона)
  localStream?.getAudioTracks().forEach((t) => {
    if (t === screenAudioTrack) return;
    t.enabled = micOn;
  });
  syncMediaState();
}

export function toggleMic() {
  if (listenOnly) return; // включать нечего: микрофон мы не брали
  // Включение микрофона под «глушилкой» снимает и её (как в Discord): нелепо
  // говорить, не слыша ответов. toggleSpeakers сам вернёт micOn=true и разошлёт.
  if (!micOn && !isSpeakersOn()) {
    micWasOnBeforeDeafen = true;
    toggleSpeakers();
    return;
  }
  micOn = !micOn;
  applyMicState();
  broadcastMediaState();
}

// Что сейчас уходит собеседникам в общий видео-sender
function currentVideoTrack(): MediaStreamTrack | null {
  return screenOn ? screenTrack : camOn ? camTrack : null;
}

export async function toggleCamera() {
  if (!localStream || listenOnly) return; // слушатель своего медиа не отдаёт
  if (camOn) stopCamera();
  else await startCamera();
  broadcastMediaState();
  syncMediaState();
}

async function startCamera() {
  if (screenOn) stopScreen(); // экран и камера занимают один слот — взаимоисключают
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(CAM_KEY) : null;
  try {
    let cam: MediaStream;
    try {
      cam = await navigator.mediaDevices.getUserMedia({
        video: saved ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: saved } } : VIDEO_CONSTRAINTS,
      });
    } catch (err) {
      // Сохранённая камера пропала/занята — откатываемся на устройство по умолчанию
      if ((err as { name?: string } | null)?.name !== 'OverconstrainedError') throw err;
      cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    }
    camTrack = cam.getVideoTracks()[0];
  } catch (err) {
    toast.error(msg('voice.toast.camUnavailable', { reason: mediaErrorText(err) }));
    return;
  }

  camTrack.contentHint = 'motion';
  // Камеру отняла система или выдернули устройство — корректно гасим у всех
  camTrack.onended = () => {
    stopCamera();
    broadcastMediaState();
    syncMediaState();
    toast(msg('voice.toast.camStopped'));
  };

  localStream!.addTrack(camTrack);
  camOn = true;
  tx().publishVideo();
  void refreshCameraInfo();
}

function stopCamera() {
  if (camTrack) {
    camTrack.onended = null;
    camTrack.stop();
    localStream?.removeTrack(camTrack);
    camTrack = null;
  }
  tx().unpublishVideo();
  camOn = false;
}

export async function toggleScreen() {
  if (!localStream || listenOnly) return; // слушатель своего медиа не отдаёт
  if (screenOn) stopScreen();
  else await startScreen();
  broadcastMediaState();
  syncMediaState();
}

async function startScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast.error(msg('voice.toast.screenUnsupported'));
    return;
  }

  // На десктоп-оболочке (Windows) звук экрана снимаем НАТИВНО, исключая процесс
  // relay из захвата, — иначе getDisplayMedia тащит системный микс с голосами
  // собеседников из динамиков, и они слышат сами себя. Тогда у getDisplayMedia
  // просим только видео. См. lib/desktop-screen-audio.ts.
  const nativeAudio = isDesktopWindows();

  let display: MediaStream;
  // Пока открыт нативный выбор источника, оболочка знает об этом: пикер рисует
  // движок своим модальным окном, и после его закрытия окну нужна побудка
  // (см. notifyScreenPicker). Закрытие отбиваем в finally — «Отмена» здесь
  // такой же выход, как и удачный выбор.
  notifyScreenPicker(true);
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: SCREEN_VIDEO_CONSTRAINTS,
      audio: nativeAudio ? false : SCREEN_AUDIO_CONSTRAINTS,
    });
  } catch (err) {
    const e = err as { name?: string } | null;
    // Пользователь просто закрыл выбор источника — это не ошибка, молчим
    if (!(e && (e.name === 'NotAllowedError' || e.name === 'AbortError'))) {
      toast.error(msg('voice.toast.screenFailed', { reason: mediaErrorText(err) }));
    }
    return;
  } finally {
    notifyScreenPicker(false);
  }

  // Экран реально получен — только теперь освобождаем видео-слот от камеры
  if (camOn) stopCamera();

  screenTrack = display.getVideoTracks()[0];
  screenTrack.contentHint = screenContentHint();

  if (nativeAudio) {
    // Нативный захват без голосов relay. Может вернуть null (нативный путь
    // недоступен) — тогда демонстрация просто без звука, это лучше эхо-петли.
    screenAudioTrack = await startNativeScreenAudio();
    if (screenAudioTrack) screenAudioTrack.contentHint = 'music';
  } else {
    screenAudioTrack = display.getAudioTracks()[0] || null;
    // Звук демонстрации — это музыка/фильм: кодеку выгоднее музыкальный режим Opus
    if (screenAudioTrack) {
      screenAudioTrack.contentHint = 'music';
      // EC по типу источника. Шеринг ВКЛАДКИ ('browser') захватывает звук только
      // этой вкладки — голосов собеседников там нет (звонок в другой вкладке),
      // эхо невозможно, поэтому снимаем AEC ради чистой музыки/фильма. Шеринг
      // всего экрана/окна ('monitor'/'window') тащит системный микс с голосами из
      // динамиков — там EC оставляем включённым (из SCREEN_AUDIO_CONSTRAINTS) как
      // защиту от «кенты слышат сами себя». Неизвестный источник → не трогаем.
      const surface = (screenTrack.getSettings() as MediaTrackSettings).displaySurface;
      if (surface === 'browser') {
        void screenAudioTrack
          .applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          })
          .catch(() => {});
      }
    }
  }

  // «Прекратить доступ» в нативной плашке браузера — корректно завершаем
  screenTrack.onended = () => {
    stopScreen();
    broadcastMediaState();
    syncMediaState();
    toast(msg('voice.toast.screenEnded'));
  };

  localStream!.addTrack(screenTrack);
  if (screenAudioTrack) localStream!.addTrack(screenAudioTrack);
  screenOn = true;
  tx().publishScreen();

  // местную плитку не зеркалим и показываем целиком (см. .tile.local.screen)
  setTileScreen('local', true);
}

function stopScreen() {
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
    localStream?.removeTrack(screenTrack);
    screenTrack = null;
  }
  if (screenAudioTrack) {
    screenAudioTrack.stop();
    localStream?.removeTrack(screenAudioTrack);
    screenAudioTrack = null;
  }
  // Нативный захват (Windows) остановить отдельно: track.stop() глушит только
  // web-часть графа, а не WASAPI-поток в оболочке. Вне Tauri — no-op.
  void stopNativeScreenAudio();
  tx().unpublishScreen();
  screenOn = false;
  setTileScreen('local', false);
}

// ─────────────────────────────────────────────────────────────────────────
// Индикация «говорит сейчас» (VAD): обводка плитки по уровню звука
// ─────────────────────────────────────────────────────────────────────────

// RMS-уровень (0..1) по временной форме сигнала анализатора.
function analyserRms(an: AnalyserNode): number {
  if (!vadBuf || vadBuf.length !== an.fftSize) vadBuf = new Uint8Array(new ArrayBuffer(an.fftSize));
  an.getByteTimeDomainData(vadBuf);
  let sum = 0;
  for (let i = 0; i < vadBuf.length; i++) {
    const v = (vadBuf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / vadBuf.length);
}

// Своя обводка: уровень в шкале метра против порога (или пола без гейта), с
// удержанием. На муте — мгновенно гаснет.
function localSpeaking(now: number): boolean {
  if (!micOn || !localAnalyser) {
    spokeAt.delete('local');
    return false;
  }
  const thr = micThreshold > 0 ? micThreshold : MIC_RING_FLOOR;
  if (micLevelNorm() >= thr) {
    spokeAt.set('local', now);
    return true;
  }
  const last = spokeAt.get('local');
  return last != null && now - last < VAD_HANGOVER_MS;
}

// «Говорит ли сейчас» с учётом порога и удержания (hangover). gateOpen=false
// (например, свой микрофон выключен) мгновенно гасит индикацию.
function isSpeaking(
  id: string,
  an: AnalyserNode | null | undefined,
  gateOpen: boolean,
  now: number,
) {
  if (gateOpen && an && analyserRms(an) >= VAD_THRESHOLD) {
    spokeAt.set(id, now);
    return true;
  }
  if (!gateOpen) {
    spokeAt.delete(id);
    return false;
  }
  const last = spokeAt.get(id);
  return last != null && now - last < VAD_HANGOVER_MS;
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

// Тик опроса уровней → список говорящих в стор (только при изменении состава).
function updateSpeaking() {
  if (!room) {
    if (lastSpeakingKey) {
      lastSpeakingKey = '';
      spokeAt.clear();
      useVoiceStore.getState().setSpeakingIds([]);
    }
    return;
  }
  const now = Date.now();
  const ids: string[] = [];

  // Себя — обводку зажигаем по тому же порогу, что открывает гейт (а без гейта —
  // по небольшому полу), и только при включённом микрофоне.
  if (localSpeaking(now)) ids.push('local');

  // Собеседники — по голосовой дорожке (не по звуку демонстрации).
  for (const [peerId, analyser] of peerVoiceAnalysers()) {
    if (isSpeaking(peerId, analyser, true, now)) ids.push(peerId);
  }

  ids.sort();
  const key = ids.join(',');
  if (key !== lastSpeakingKey) {
    lastSpeakingKey = key;
    useVoiceStore.getState().setSpeakingIds(ids);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Инициализация: socket-обработчики дирижёра (один раз на приложение).
// Сигналинг медиа (offer/answer/ice/состав пиров) слушает транспорт — см.
// его init(); здесь остаётся то, что от транспорта не зависит.
// ─────────────────────────────────────────────────────────────────────────

export function initVoice() {
  if (initialized) return;
  initialized = true;

  // Сохранённый порог микрофона (применится при следующем входе в эфир)
  const savedThr =
    typeof localStorage !== 'undefined' ? Number(localStorage.getItem(MIC_THRESHOLD_KEY)) : NaN;
  if (Number.isFinite(savedThr) && savedThr >= 0 && savedThr <= 1) {
    micThreshold = savedThr;
    useVoiceStore.getState().setMicThreshold(savedThr);
  }

  // Подключили/отключили устройство — обновляем списки в сторе
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void refreshMicInfo();
    refreshOutputDevices();
  });

  // Витрина плиток — то, чего она сама не знает: звук пира, его громкость и
  // крупный план. Всё трое принадлежат микшеру и транспорту, поэтому и
  // спрашиваются, а не берутся.
  initTiles({
    dropAudio: cleanupPeerAudio,
    setGain: setPeerGain,
    focusChanged: (id) => tx().focusChanged?.(id),
  });
  // Микшер снимает узлы ушедшего сам, а вот «когда он в последний раз говорил»
  // — это уже обводка плитки, и живёт она здесь.
  initOutput({ forgetSpeaker: (peerId) => spokeAt.delete(peerId) });

  const s = socket();

  mesh().init(); // mesh слушает сигналинг всегда — он же и транспорт по умолчанию

  s.on('peer-joined', ({ name }) => {
    setStatus('voice.status.peerJoined', { name: name || msg('voice.peer.fallback') });
    sfx().play('peerJoin'); // звук подключения участника
    // Новичок ещё не знает, что мы показываем экран/камеру: media-update летит
    // только на переключении. Повторяем текущее состояние, чтобы его плитка
    // сразу знала про наше видео (флаг videoOn), а не ждала косвенных сигналов.
    if (camOn || screenOn) broadcastMediaState();
  });

  s.on('media-update', ({ from, camOn: peerCam, screenOn: peerScreen }) => {
    setTileVideoOn(from, peerCam || peerScreen);
    // Экран в видеослоте собеседника — не косметика: плитка показывает такой
    // кадр целиком (а не обрезает по краям), а погасший флаг — сигнал «показ
    // окончен», по которому крупный план сам возвращается в сетку.
    setTileScreen(from, peerScreen);
  });

  // Собеседник сменил тег — обновляем подпись его плитки и имя пира.
  s.on('peer-renamed', ({ id, name }) => {
    tx().renamePeer(id, name);
    const t = tileOf(id);
    if (t && t.name !== name) {
      // Имя сменилось — переносим сохранённую громкость на новое, чтобы
      // выкрученные проценты не потерялись. Касается это только гостя по
      // инвайту: отпечатка ему не выдают, и имя — единственный его ключ. У
      // человека с ключом громкость записана на отпечаток и переименования
      // не замечает вовсе.
      if (!roleOf(id)?.fingerprint && (t.volume !== 1 || t.screenVolume !== 1))
        savePeerVol(id, name, { voice: t.volume, screen: t.screenVolume });
      renameTile(id, name);
    }
  });

  // Владелец сменил транспорт канала прямо во время звонка — переезжаем все
  // вместе. Событие летит в комнату (а не только с реестром каналов) как раз
  // ради гостей: реестра у них нет, а разъехаться в транспортах нельзя.
  s.on('voice-mode', ({ room: changed, mode }) => {
    if (!room || changed !== room) return;
    toast(
      msg('voice.toast.modeSwitched', {
        mode: msg(mode === 'sfu' ? 'voice.toast.mode.sfu' : 'voice.toast.mode.p2p'),
      }),
    );
    // Мы уже на том транспорте, который канал только что объявил, — ехать
    // некуда. Переезд стоит секунд тишины на ровном месте: он снимает плитки и
    // пересобирает все соединения заново. Чаще всего это случается с тем, кто
    // и так звонил напрямую (медиасервер не поднялся у него одного), а владелец
    // как раз поэтому канал и переключил. Транспорта нет вовсе — значит идёт
    // заход или переезд, и гадать нечего: едем.
    const settled = mode === 'sfu' ? transport === sfuTransport : transport === meshTransport;
    if (settled) {
      // Круг ожидания вернувшегося медиасервера ждать больше нечего: канал
      // прямой. Иначе он так и стучался бы в api каждые пять секунд.
      if (mode === 'p2p') cancelSfuRetry();
      return;
    }
    void remigrate();
  });

  s.on('voice-presence', (p: VoicePresence) => {
    onPresence(p && typeof p === 'object' ? p : {});
  });

  // Нас выгнали из эфира (только гостевой сценарий: выгоняют гостя). Сервер уже
  // выписал из комнаты и закрыл вход по той же ссылке на час — сворачиваем
  // звонок и поднимаем флаг: пропавший без объяснений звук человек читает как
  // поломку и лезет чинить микрофон.
  s.on('kicked', () => {
    useVoiceStore.getState().setKicked(true);
    if (!room) return;
    sfx().play('error');
    leaveVoice();
  });

  // Вход в канал закрытого сервера отбит: пропуска нет или он умер (сменили
  // пароль). Сервер нас в комнату не пустил, а клиент об этом раньше не знал —
  // и оставался «в канале», которого для сервера нет: без звука, без состава и
  // без единой подсказки, что нужен пароль. Уходим по-настоящему и говорим об
  // этом. Комната в событии своя у каждого отказа — чужую не трогаем.
  s.on('voice-locked', ({ room: locked }) => {
    if (!room || room !== locked) return;
    toast.error(msg('voice.toast.locked'));
    sfx().play('error');
    leaveVoice();
  });

  s.on('connect', () => {
    // Свой id нужен, чтобы пометить себя в составе голосовых каналов
    useVoiceStore.getState().setMyId(s.id ?? null);
    if (!room) return;
    // Сессия восстановлена после кратковременного обрыва (socket.io connection
    // state recovery): id и комнаты те же, сервер не выкидывал нас из канала,
    // P2P-медиа всё это время могло течь. Звонок не пересобираем — иначе он
    // дёргался бы на каждое моргание сети, — но и «всё само» тут неверно: то же
    // моргание рвёт ICE, а лестница восстановления без сигналинга стоит на паузе.
    // Пусть транспорт догонит тех, кто с связи всё-таки слетел.
    if (s.recovered) {
      setStatus('voice.status.connected', { room });
      tx().resync?.();
      return;
    }
    // Полноценный реконнект: у сокета новый id — все старые соединения мертвы,
    // собираем заново.
    tx().reset();
    toast(msg('voice.toast.serverBack'));
    sfx().play('reconnect'); // связь восстановлена
    if (transport === sfuTransport) {
      // Пропуск в медиасервер выписан на прежний socket.id и вместе с ним умер —
      // нужен новый, а значит полный переезд, а не просто повторный join.
      void remigrate();
      return;
    }
    // Транспорт называем и здесь: до сюда доходит только mesh (у SFU выше свой
    // путь — ему нужен новый пропуск), но сервер, которому не сказали, гадает по
    // выданному пропуску, а гадание про транспорт стоит целого канала.
    s.emit('join', { room, name: myName(), clientId: loadClientId(), transport: 'p2p' });
    setStatus('voice.status.connected', { room });
  });

  s.on('disconnect', () => {
    if (!room) return;
    setStatus('voice.status.serverLost');
    toast(msg('voice.toast.serverLost'));
    sfx().play('connLost'); // обрыв связи
  });

  // Метрики связи — целиком дело транспорта: он один знает, что и у кого мерить.
  if (!pingTimer) pingTimer = setInterval(() => tx().pollStats(), 3000);

  // Обводка «говорит сейчас» — частый, но дешёвый опрос анализаторов
  if (!vadTimer) vadTimer = setInterval(updateSpeaking, VAD_TICK_MS);

  // Шумовой гейт микрофона — отдельный, более частый тик для быстрой атаки
  if (!gateTimer) gateTimer = setInterval(evaluateGate, GATE_TICK_MS);
}

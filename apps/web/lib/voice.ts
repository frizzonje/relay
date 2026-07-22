'use client';

import { toast } from 'sonner';
import type { VoicePresence } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getSfx } from '@/lib/sfx';
import {
  isDesktopWindows,
  startNativeScreenAudio,
  stopNativeScreenAudio,
} from '@/lib/desktop-screen-audio';
import { useUiStore, myName } from '@/stores/ui';
import { loadClientId } from '@/lib/identity';
import { useVoiceStore, type ScreenMode, type TileNet, type VoiceTile } from '@/stores/voice';
import { createMeshTransport } from '@/lib/voice/mesh';
import type { TransportHost, VoiceTicket, VoiceTransport } from '@/lib/voice/types';

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
 * (`lib/voice/mesh.ts`), рядом с ним встанет SFU — см. docs/sfu-plan.md.
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
let focusedTileId: string | null = null;

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

/**
 * Веха звонка — в консоль и в серверный лог (`voice-diag`). Ключевые решения
 * (выбор транспорта, фолбэк в p2p, обрыв) клиент принимает молча у себя, и
 * сервер видит лишь их отсутствие; консоль же умирает вместе с вкладкой.
 * «Телефон в канале, но не слышно» назавтра разбирается ровно по этим строчкам.
 */
function diag(event: string, detail?: string) {
  console.info(`[voice] ${event}${detail ? ` — ${detail}` : ''}`);
  try {
    socket().emit('voice-diag', { event, ...(detail ? { detail } : {}) });
  } catch {
    /* сокета ещё нет — веха останется хотя бы в консоли */
  }
}

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

// ─────────────────────────────────────────────────────────────────────────
// Витрина: плитки в стор (addTile/removeTile/setTileState)
// ─────────────────────────────────────────────────────────────────────────

const tiles = new Map<string, VoiceTile>();

// ─────────────────────────────────────────────────────────────────────────
// Персональная громкость собеседников. Ползунок ходит 0–3 (0–300%), значение
// применяется к GainNode как есть (без урезания). Запоминаем по тегу
// собеседника (stable), чтобы «этот долбик на 200%» так и остался громким
// при следующем заходе.
export const PEER_VOL_MAX = 3;
const PEER_VOL_KEY = 'relay-peer-vol';
type PeerVol = { voice?: number; screen?: number };

function loadPeerVols(): Record<string, PeerVol> {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(PEER_VOL_KEY) || '{}');
  } catch {
    return {};
  }
}

function peerVol(name: string): PeerVol {
  return loadPeerVols()[name] ?? {};
}

function savePeerVol(name: string, patch: PeerVol) {
  try {
    if (typeof localStorage === 'undefined' || !name) return;
    const all = loadPeerVols();
    all[name] = { ...all[name], ...patch };
    localStorage.setItem(PEER_VOL_KEY, JSON.stringify(all));
  } catch {
    // приватный режим/квота — тихо переживаем, громкость просто не запомнится
  }
}

function syncTiles() {
  useVoiceStore.getState().setTiles([...tiles.values()]);
}

function addTile(id: string, name: string, stream: MediaStream | null, isLocal: boolean) {
  const existing = tiles.get(id);
  if (!existing) {
    // Для собеседника восстанавливаем ранее выкрученную ему громкость по тегу.
    const saved = isLocal ? {} : peerVol(name);
    tiles.set(id, {
      id,
      name,
      stream,
      state: '',
      isLocal,
      screen: false,
      volume: saved.voice ?? 1,
      screenVolume: saved.screen ?? 1,
      hasScreenAudio: false,
    });
  } else if (stream && existing.stream !== stream) {
    tiles.set(id, { ...existing, stream });
  } else {
    return; // нечего менять
  }
  syncTiles();
}

function setTileState(id: string, state: string) {
  const t = tiles.get(id);
  if (!t || t.state === state) return;
  tiles.set(id, { ...t, state });
  syncTiles();
}

function setTileScreen(id: string, screen: boolean) {
  const t = tiles.get(id);
  if (!t || t.screen === screen) return;
  tiles.set(id, { ...t, screen });
  syncTiles();
}

function setTileVideoOn(id: string, on: boolean) {
  const t = tiles.get(id);
  if (!t || t.videoOn === on) return;
  tiles.set(id, { ...t, videoOn: on });
  syncTiles();
}

function setTileScreenAudio(id: string, on: boolean) {
  const t = tiles.get(id);
  if (!t || t.hasScreenAudio === on) return;
  tiles.set(id, { ...t, hasScreenAudio: on });
  syncTiles();
}

// Качество связи меняется каждые 3 с — обновляем плитку, только если реально
// сдвинулись округлённые метрики (иначе лишний ре-рендер всей сетки на тик).
function setTileNet(id: string, net: TileNet) {
  const t = tiles.get(id);
  if (!t) return;
  const p = t.net;
  if (
    p &&
    p.grade === net.grade &&
    p.rttMs === net.rttMs &&
    p.lossPct === net.lossPct &&
    p.jitterMs === net.jitterMs &&
    p.relay === net.relay &&
    p.sendKbps === net.sendKbps &&
    p.recvKbps === net.recvKbps &&
    p.videoRes === net.videoRes &&
    p.fps === net.fps &&
    p.codec === net.codec
  )
    return;
  tiles.set(id, { ...t, net });
  syncTiles();
}

/** Собеседник ушёл (или транспорт снял соединение) — убираем его целиком. */
function removeTile(id: string) {
  cleanupPeerAudio(id);
  if (focusedTileId === id) clearFocus();
  tiles.delete(id);
  syncTiles();
}

// ─────────────────────────────────────────────────────────────────────────
// Микшер входящего звука (Web Audio): независимая громкость голоса и
// демонстрации каждого собеседника. Каждую входящую аудиодорожку гоним через
// собственный GainNode → destination; чужой <video> при этом заглушён (muted),
// чтобы звук не игрался дважды.
//
// Роль дорожки (голос/демонстрация) определяем НЕ по порядку прихода ontrack —
// он не гарантирован и плавает между браузерами (отсюда и брался эффект
// «рандомно кто-то глохнет в одну сторону»), — а по mid её transceiver'а.
// Микрофон создаётся первым (createPeer), звук демонстрации — позже
// (sendScreenTo), значит у микрофона mid меньше. Сортируем дорожки пира по mid:
// наименьший = голос, остальные = звук демонстрации. Это устойчиво к
// ренеготиации, glare и ICE-restart.
//
// Плюс держим на каждого пира скрытый muted-<audio> с его потоком: без привязки
// дорожки к media-элементу WebAudio-граф на части Chrome/Safari молчит. Громкость
// 0–2 (1 = 100%), как в Discord (Web Audio, а не потолок <audio>.volume в 1.0).
// ─────────────────────────────────────────────────────────────────────────

interface RemoteAudioEntry {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode; // ответвление от source для детекта «говорит сейчас»
  track: MediaStreamTrack;
  mid: string; // стабильный ключ маршрутизации на всё время жизни transceiver'а
  isScreen: boolean;
}

interface PeerAudio {
  entries: Map<string, RemoteAudioEntry>; // ключ — mid (или запасной idx-N)
  sink: HTMLAudioElement; // скрытый muted-приёмник: «прокачивает» дорожки
  micGain: GainNode | null; // вычисляемые ссылки для setPeerVolume/setPeerScreenVolume
  screenGain: GainNode | null;
}

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let speakersOn = true;
// Был ли включён микрофон до «глушилки» — чтобы вернуть его при включении звука.
let micWasOnBeforeDeafen = true;
const SPEAKER_KEY = 'relay-speaker-id';

const peerAudio = new Map<string, PeerAudio>();

// ─── Детект «говорит сейчас» (обводка плитки, как в Discord) ──────────────
// Снимаем RMS-уровень с анализаторов (свой микрофон + голос каждого собеседника)
// и зажигаем обводку выше порога, удерживая её ещё чуть-чуть после паузы, чтобы
// не мигала между словами.
const VAD_FFT_SIZE = 512;
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

function getAudioCtx(): AudioContext {
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctor();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = speakersOn ? 1 : 0;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

/**
 * Принудительно возобновляет звук после жеста пользователя. Браузер мог
 * заблокировать автоплей (особенно Safari/iOS) — тогда AudioContext висит в
 * `suspended`, и весь входящий звук уходит в тишину, хотя медиа течёт. Дёргается
 * из кнопки разблокировки (AudioUnlock) — только там есть нужный жест.
 */
export function resumeVoiceAudio() {
  if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
  peerAudio.forEach((pa) => void pa.sink.play().catch(() => {}));
}

// Скрытый muted-приёмник на пира гарантирует «прокачку» входящих аудиодорожек
// (иначе WebAudio-граф на части браузеров молчит). Поток у всех дорожек пира
// один (sender'ы добавлены с общим localStream) — достаточно одного элемента.
function ensurePeerAudio(peerId: string, stream: MediaStream | null): PeerAudio {
  let pa = peerAudio.get(peerId);
  if (!pa) {
    const sink = document.createElement('audio');
    sink.muted = true; // звук слышно через WebAudio; элемент лишь «прокачивает» дорожку
    sink.autoplay = true;
    sink.setAttribute('playsinline', '');
    sink.style.display = 'none';
    if (stream) sink.srcObject = stream;
    document.body.appendChild(sink);
    const savedSpeaker =
      typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAKER_KEY) : null;
    if (savedSpeaker) {
      const s = sink as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof s.setSinkId === 'function') void s.setSinkId(savedSpeaker).catch(() => {});
    }
    void sink.play().catch(() => {});
    pa = { entries: new Map(), sink, micGain: null, screenGain: null };
    peerAudio.set(peerId, pa);
  } else if (stream && pa.sink.srcObject !== stream) {
    pa.sink.srcObject = stream;
    void pa.sink.play().catch(() => {});
  }
  return pa;
}

// Сравнение mid: числовые («0», «1», …) по значению, иначе лексикографически.
function cmpMid(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Пересчитываем роли дорожек пира (голос/демонстрация) по порядку mid и
// применяем сохранённую громкость. Идемпотентно — зовём при каждом изменении.
function reassignAudioRoles(peerId: string) {
  const pa = peerAudio.get(peerId);
  if (!pa) return;
  const sorted = [...pa.entries.values()].sort((a, b) => cmpMid(a.mid, b.mid));
  const t = tiles.get(peerId);
  const voiceVol = t?.volume ?? 1;
  const screenVol = t?.screenVolume ?? 1;
  pa.micGain = null;
  pa.screenGain = null;
  sorted.forEach((e, i) => {
    e.isScreen = i > 0; // первый по mid — микрофон, остальные — звук демонстрации
    e.gain.gain.value = e.isScreen ? screenVol : voiceVol;
    if (e.isScreen) pa.screenGain = e.gain;
    else pa.micGain = e.gain;
  });
  recomputeScreenAudioIcon(peerId);
}

// Иконку громкости трансляции показываем, пока жива незаглушённая дорожка демонстрации.
function recomputeScreenAudioIcon(peerId: string) {
  const pa = peerAudio.get(peerId);
  const screen = pa && [...pa.entries.values()].find((e) => e.isScreen);
  setTileScreenAudio(peerId, !!screen && !screen.track.muted && screen.track.readyState === 'live');
}

function attachRemoteAudio(
  peerId: string,
  track: MediaStreamTrack,
  mid: string | null,
  stream: MediaStream | null,
) {
  const ctx = getAudioCtx();
  const pa = ensurePeerAudio(peerId, stream);
  const key = mid || `idx-${pa.entries.size}`;

  // Повторный ontrack по тому же mid (например, после ренеготиации) — снимаем
  // прежний узел, чтобы не плодить дубли и не оставлять «мёртвый» источник.
  const prev = pa.entries.get(key);
  if (prev) {
    prev.source.disconnect();
    prev.gain.disconnect();
  }

  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const gain = ctx.createGain();
  source.connect(gain);
  gain.connect(masterGain ?? ctx.destination);

  // Ответвление на анализатор — для индикации «говорит сейчас». Снимаем уровень с
  // source (ДО gain), чтобы обводка зависела от речи собеседника, а не от того,
  // как ты ему подкрутил громкость. source уже «тянется» путём source→gain→master,
  // поэтому анализатору отдельный выход в destination не нужен.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = VAD_FFT_SIZE;
  source.connect(analyser);

  const entry: RemoteAudioEntry = { source, gain, analyser, track, mid: key, isScreen: false };
  pa.entries.set(key, entry);

  // Дорожка завершилась (демонстрацию остановили) — убираем узел, пересчитываем роли.
  track.addEventListener('ended', () => {
    entry.source.disconnect();
    entry.gain.disconnect();
    pa.entries.delete(key);
    reassignAudioRoles(peerId);
  });
  const refreshIcon = () => recomputeScreenAudioIcon(peerId);
  track.addEventListener('mute', refreshIcon);
  track.addEventListener('unmute', refreshIcon);

  reassignAudioRoles(peerId);
}

/**
 * Снять узлы микшера у одной дорожки собеседника (SFU закрывает producer'ы
 * поштучно, и `ended` при этом не приходит). Плитка и остальные дорожки живут.
 */
function detachRemoteAudio(peerId: string, track: MediaStreamTrack) {
  const pa = peerAudio.get(peerId);
  if (!pa) return;
  for (const [key, entry] of pa.entries) {
    if (entry.track !== track) continue;
    entry.source.disconnect();
    entry.gain.disconnect();
    pa.entries.delete(key);
  }
  reassignAudioRoles(peerId);
}

function cleanupPeerAudio(peerId: string) {
  const pa = peerAudio.get(peerId);
  if (!pa) return;
  pa.entries.forEach((e) => {
    e.source.disconnect();
    e.gain.disconnect();
  });
  pa.sink.srcObject = null;
  pa.sink.remove();
  peerAudio.delete(peerId);
  spokeAt.delete(peerId);
}

/** Громкость голоса собеседника, 0–3 (1 = 100%). Дёргается из VideoTile. */
export function setPeerVolume(peerId: string, vol: number) {
  const v = Math.max(0, Math.min(PEER_VOL_MAX, vol));
  const pa = peerAudio.get(peerId);
  if (pa?.micGain) pa.micGain.gain.value = v;
  const t = tiles.get(peerId);
  if (t) {
    tiles.set(peerId, { ...t, volume: v });
    savePeerVol(t.name, { voice: v }); // запоминаем на следующий заход
    syncTiles();
  }
}

/** Громкость звука демонстрации собеседника, 0–3 (1 = 100%). */
export function setPeerScreenVolume(peerId: string, vol: number) {
  const v = Math.max(0, Math.min(PEER_VOL_MAX, vol));
  const pa = peerAudio.get(peerId);
  if (pa?.screenGain) pa.screenGain.gain.value = v;
  const t = tiles.get(peerId);
  if (t) {
    tiles.set(peerId, { ...t, screenVolume: v });
    savePeerVol(t.name, { screen: v });
    syncTiles();
  }
}

/**
 * Обновляет videoOn локальной плитки и рассылает собеседникам полное медиасостояние
 * (видео + мут/глушилка). Сервер запоминает мут на сокете и раздаёт его через
 * voice-presence — индикаторы в сайдбаре видят даже те, кто сам не в эфире.
 */
function broadcastMediaState() {
  const on = camOn || screenOn;
  setTileVideoOn('local', on);
  if (room) socket().emit('media-update', { camOn, screenOn, micOn, deafened: !speakersOn });
}

function setStatus(text: string) {
  useVoiceStore.getState().setStatus(text);
}

// ─────────────────────────────────────────────────────────────────────────
// Доступ к камере/микрофону
// ─────────────────────────────────────────────────────────────────────────

function mediaErrorText(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'доступ запрещён. Разрешите камеру и микрофон для этого сайта (значок 🔒 в адресной строке), а на macOS — ещё и браузеру в «Системные настройки → Конфиденциальность», затем обновите страницу';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'устройство не найдено. Проверьте, что микрофон подключён';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'устройство занято другим приложением (Zoom, Teams, OBS…) или заблокировано системой. Закройте его и попробуйте снова';
    case 'OverconstrainedError':
      return 'устройство не поддерживает запрошенные параметры';
    case 'SecurityError':
      return 'браузер заблокировал доступ: страница должна открываться по HTTPS';
    case 'AbortError':
      return 'устройство не ответило. Попробуйте ещё раз';
    default:
      return e?.message || 'неизвестная ошибка';
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
  } else if (micGainNode && audioCtx) {
    // Порог 0 — гейт выключаем, микрофон держим открытым.
    gateOpenUntil = 0;
    micGainNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.02);
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
  if (micThreshold <= 0 || !micPipelineActive || !micGainNode || !audioCtx) return;
  const now = performance.now();
  if (micOn && micLevelNorm() >= micThreshold) gateOpenUntil = now + GATE_HOLD_MS;
  const open = now < gateOpenUntil;
  micGainNode.gain.setTargetAtTime(open ? 1 : 0, audioCtx.currentTime, open ? 0.015 : 0.06);
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

/** Обновляет список устройств вывода (audiooutput) и текущий выбор в сторе. */
async function refreshSpeakerInfo() {
  const store = useVoiceStore.getState();
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAKER_KEY) : null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const speakers = devices.filter((d) => d.kind === 'audiooutput');
    store.setSpeakers(speakers);
    const current = saved ? speakers.find((d) => d.deviceId === saved) : null;
    store.setCurrentSpeaker(saved, current?.label ?? '');
  } catch {
    /* enumerateDevices недоступен */
    store.setCurrentSpeaker(saved, '');
  }
}

/** Перечитать список устройств вывода (для UI). */
export function refreshSpeakers() {
  void refreshSpeakerInfo();
}

/**
 * Переключает глобальный мут всех звуков сайта (пиры + sfx) — режим «глушилки»
 * (deafen, как в Discord). Выключил звук — микрофон гаснет автоматически (не
 * слышишь — не говоришь); включил обратно — микрофон возвращается в то
 * состояние, в котором был до глушилки.
 */
export function toggleSpeakers() {
  speakersOn = !speakersOn;
  useVoiceStore.getState().setSpeakersOn(speakersOn);
  if (masterGain) masterGain.gain.value = speakersOn ? 1 : 0;
  getSfx().setAllMuted(!speakersOn);
  if (!speakersOn) {
    micWasOnBeforeDeafen = micOn;
    micOn = false;
  } else {
    micOn = micWasOnBeforeDeafen;
  }
  applyMicState();
  broadcastMediaState();
}

/**
 * Переключает устройство вывода звука для всех входящих аудиопотоков и sfx.
 * Сохраняет выбор в localStorage — применяется к новым синкам автоматически.
 */
export async function setSpeaker(deviceId: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SPEAKER_KEY, deviceId);

  type SinkEl = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  type SinkCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> };

  peerAudio.forEach((pa) => {
    const s = pa.sink as SinkEl;
    if (typeof s.setSinkId === 'function') void s.setSinkId(deviceId).catch(() => {});
  });

  if (audioCtx) {
    const c = audioCtx as SinkCtx;
    if (typeof c.setSinkId === 'function') void c.setSinkId(deviceId).catch(() => {});
  }

  getSfx().setSinkId(deviceId);

  await refreshSpeakerInfo();
  const { currentSpeakerLabel } = useVoiceStore.getState();
  toast('Динамики: ' + (currentSpeakerLabel || 'устройство переключено'));
}

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
    toast.error('Не удалось переключить микрофон: ' + mediaErrorText(err) + '.');
    return;
  }

  const newTrack = stream.getAudioTracks()[0];
  if (!newTrack) return;
  newTrack.contentHint = 'speech'; // голос, не музыка

  if (micPipelineActive && micGainNode && audioCtx) {
    // Цепочка чувствительности поднята: меняем ИСТОЧНИК, исходящая (обработанная)
    // дорожка остаётся прежней — собеседников переподписывать не нужно.
    newTrack.enabled = true; // сырой источник всегда «течёт», мут — на выходной дорожке
    try {
      micSource?.disconnect();
    } catch {
      /* источник мог быть уже отключён */
    }
    rawMicTrack?.stop();
    micSource = audioCtx.createMediaStreamSource(new MediaStream([newTrack]));
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
  toast('Микрофон переключён: ' + (newTrack.label || 'устройство'));
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

function remoteCount(): number {
  return tiles.size - (tiles.has('local') ? 1 : 0);
}

/** Снять плитки собеседников (при переезде их соберёт заново новый транспорт). */
function dropRemoteTiles() {
  for (const id of [...tiles.keys()]) if (id !== 'local') removeTile(id);
}

/**
 * Подключить транспорт к комнате и объявиться на сигналинге. Пропуск = выбор
 * транспорта: он есть — идём в SFU, нет — в mesh.
 */
async function enterRoom(target: string, ticket: VoiceTicket | null) {
  const next = ticket ? await sfu() : mesh();
  if (room !== target) return; // пока грузился чанк, успели уйти в другой канал
  transport = next;
  next.join(target, ticket ?? undefined);
  socket().emit('join', { room: target, name: myName(), clientId: loadClientId() });
  // После join: сервер уже знает имя и впишет его в строку лога.
  diag('transport', `${ticket ? 'sfu' : 'mesh'} room="${target}"`);
  // Сразу за join — своё медиасостояние: сервер только что сбросил его, а мут/
  // глушилка могли остаться с прошлого канала.
  broadcastMediaState();
  setStatus('На связи: ' + target);
}

/**
 * Переезд на другой транспорт, не выходя из канала: сюда сходятся фолбэк на
 * p2p, возвращение медиасервера и смена режима канала владельцем. Звук пропадёт
 * на пару секунд — это дешевле, чем мост между транспортами.
 */
async function remigrate(force?: 'mesh') {
  const target = room;
  if (!target) return;
  cancelSfuRetry();
  tx().leave();
  transport = null;
  dropRemoteTiles();
  const ticket = force === 'mesh' ? null : await requestSfuTicket(target);
  if (room !== target) return;
  await enterRoom(target, ticket);
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
      const ticket = await requestSfuTicket(target);
      if (room !== target) return;
      if (!ticket) {
        scheduleSfuRetry(); // всё ещё лежит — заходим на следующий круг
        return;
      }
      diag('sfu-retry', 'ok — moving back to sfu');
      tx().leave();
      transport = null;
      dropRemoteTiles();
      await enterRoom(target, ticket);
      toast.success('Медиасервер вернулся.');
    })();
  }, SFU_RETRY_MS);
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
    toast.error('Медиасервер недоступен — звоним напрямую.');
    sfx().play('error');
    void remigrate('mesh');
    return;
  }
  diag('sfu-lost', `${reason} → waiting for sfu (${remoteCount()} peers)`);
  toast.error('Медиасервер недоступен. Ждём его: участников слишком много для прямых звонков.');
  sfx().play('error');
  setStatus('Медиасервер недоступен, ждём…');
  scheduleSfuRetry();
}

export async function joinVoice(newRoom: string, label: string) {
  // Уже на связи в этой комнате — значит, мы просто смотрели текст: показываем сетку
  if (newRoom === room) {
    useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast.error('Видеозвонки недоступны: откройте сайт по HTTPS или обновите браузер.');
    setStatus('Связь невозможна');
    return;
  }

  if (!localStream) {
    setStatus('Запрашиваем доступ к микрофону...');
    try {
      localStream = await acquireMic();
    } catch (err) {
      console.error('getUserMedia failed:', err);
      setStatus('Нет доступа к микрофону');
      toast.error('Не удалось выйти на связь: микрофон — ' + mediaErrorText(err) + '.');
      sfx().play('error'); // отказано в доступе к устройству
      return;
    }
    rawMicTrack = localStream.getAudioTracks()[0] ?? null;
    if (rawMicTrack) rawMicTrack.contentHint = 'speech'; // голос, не музыка
    // Сохранённый порог > 0 — поднимаем цепочку гейта ДО join, чтобы новые пиры
    // сразу получили уже затворённую дорожку.
    if (micThreshold > 0) ensureMicPipeline();
    setupLocalVad(); // анализатор своего микрофона для обводки и гейта
    // Доступ выдан — метки устройств теперь видны, наполняем списки
    void refreshMicInfo();
    void refreshSpeakerInfo();
  }

  if (room) leaveVoice(false); // мягко переключаемся между голосовыми — поток живёт
  room = newRoom;

  useUiStore.setState({ view: 'voice', voiceRoom: room, voiceLabel: label });

  addTile('local', myName() + ' (вы)', localStream, true);
  applyMicState();
  syncMediaState();

  // Транспорт выбираем ДО `join`: сразу за ним сервер пришлёт состав комнаты, и
  // к этому моменту должно быть решено, кто его слушает. Спрашиваем у api — не
  // у своего реестра каналов: гость по инвайту реестра не получает вовсе, а
  // разъехавшись с остальными в транспорте, он останется без звука.
  const ticket = await requestSfuTicket(room);
  if (room !== newRoom) return; // пока спрашивали, успели уйти в другой канал
  await enterRoom(room, ticket);
  if (room !== newRoom) return;
  sfx().play('join'); // вышли на связь

  // Подсказка про смену микрофона — один раз, чтобы знали, где переключить
  if (typeof localStorage !== 'undefined' && !localStorage.getItem('relay-mic-hint')) {
    localStorage.setItem('relay-mic-hint', '1');
    toast('Не тот микрофон? Сменить можно кнопкой «▲» на значке микрофона.', { duration: 7000 });
  }
}

// hard=true — полная демобилизация (освобождаем камеру/микрофон, меняем вид).
// hard=false — мягкий выход при переключении голосовых: поток и вид оставит вызывающий.
export function leaveVoice(hard = true) {
  if (hard && room) sfx().play('leave'); // покидаем звонок (не при смене канала)
  cancelSfuRetry();
  if (room) socket().emit('leave');
  tx().leave();
  transport = null; // следующий вход выберет транспорт заново
  teardownPeerAudio();
  clearFocus();
  tiles.clear();
  syncTiles();
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
  // под ней микрофон остаётся выключенным (не слышишь — не говоришь).
  micOn = speakersOn;
  micWasOnBeforeDeafen = true;
  camOn = false;
  syncMediaState();

  // Голос отключили, но текстовый канал мог остаться открытым — показываем его
  const ui = useUiStore.getState();
  if (ui.textRoom) {
    useUiStore.setState({ view: 'text', voiceRoom: null, voiceLabel: '' });
    setStatus('В канале ' + (ui.textLabel || '# ' + ui.textRoom));
  } else {
    useUiStore.setState({ view: 'lobby', voiceRoom: null, voiceLabel: '' });
    setStatus('Отключён');
  }
}

/** Снимаем микшер целиком: узлы Web Audio и скрытые приёмники всех собеседников. */
function teardownPeerAudio() {
  peerAudio.forEach((pa) => {
    pa.entries.forEach((e) => {
      e.source.disconnect();
      e.gain.disconnect();
    });
    pa.sink.srcObject = null;
    pa.sink.remove();
  });
  peerAudio.clear();
}

/**
 * Смена тега на лету: обновляем подпись своей плитки и шлём серверу rename —
 * тот обновит presence голосового канала и ростер текстового, а собеседникам
 * разошлёт peer-renamed (подписи наших плиток у них).
 */
export function renameSelf(name: string) {
  const t = tiles.get('local');
  const label = name + ' (вы)';
  if (t && t.name !== label) {
    tiles.set('local', { ...t, name: label });
    syncTiles();
  }
  socket().emit('rename', { name });
}

/** Клик по статусу в панели голоса — вернуться к видеосетке. */
export function showVoiceStage() {
  if (!room) return;
  useUiStore.setState({ view: 'voice' });
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
  // Включение микрофона под «глушилкой» снимает и её (как в Discord): нелепо
  // говорить, не слыша ответов. toggleSpeakers сам вернёт micOn=true и разошлёт.
  if (!micOn && !speakersOn) {
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
  if (!localStream) return;
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
    toast.error('Камера недоступна: ' + mediaErrorText(err) + '.');
    return;
  }

  camTrack.contentHint = 'motion';
  // Камеру отняла система или выдернули устройство — корректно гасим у всех
  camTrack.onended = () => {
    stopCamera();
    broadcastMediaState();
    syncMediaState();
    toast('Камера отключилась.');
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
  if (!localStream) return;
  if (screenOn) stopScreen();
  else await startScreen();
  broadcastMediaState();
  syncMediaState();
}

async function startScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast.error('Демонстрация экрана недоступна в этом браузере.');
    return;
  }

  // На десктоп-оболочке (Windows) звук экрана снимаем НАТИВНО, исключая процесс
  // relay из захвата, — иначе getDisplayMedia тащит системный микс с голосами
  // собеседников из динамиков, и они слышат сами себя. Тогда у getDisplayMedia
  // просим только видео. См. lib/desktop-screen-audio.ts.
  const nativeAudio = isDesktopWindows();

  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: SCREEN_VIDEO_CONSTRAINTS,
      audio: nativeAudio ? false : SCREEN_AUDIO_CONSTRAINTS,
    });
  } catch (err) {
    const e = err as { name?: string } | null;
    // Пользователь просто закрыл выбор источника — это не ошибка, молчим
    if (!(e && (e.name === 'NotAllowedError' || e.name === 'AbortError'))) {
      toast.error('Не удалось начать демонстрацию: ' + mediaErrorText(err) + '.');
    }
    return;
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
    toast('Демонстрация экрана завершена.');
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
// Театр-режим и полноэкранный режим плитки
// ─────────────────────────────────────────────────────────────────────────

export function toggleFocus(id: string) {
  if (focusedTileId === id) clearFocus();
  else setFocus(id);
}

export function setFocus(id: string) {
  if (!tiles.has(id)) return;
  focusedTileId = id;
  useVoiceStore.getState().setFocus(id);
  tx().focusChanged?.(id); // SFU: крупной плитке — верхний слой simulcast
}

export function clearFocus() {
  if (!focusedTileId) return;
  focusedTileId = null;
  useVoiceStore.getState().setFocus(null);
  tx().focusChanged?.(null);
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
    localAnalyser.fftSize = VAD_FFT_SIZE;
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
  peerAudio.forEach((pa, peerId) => {
    const voice = [...pa.entries.values()].find((e) => !e.isScreen);
    if (isSpeaking(peerId, voice?.analyser, true, now)) ids.push(peerId);
  });

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
    void refreshSpeakerInfo();
  });

  const s = socket();

  mesh().init(); // mesh слушает сигналинг всегда — он же и транспорт по умолчанию

  s.on('peer-joined', ({ name }) => {
    setStatus('Подключился: ' + (name || 'Участник'));
    sfx().play('peerJoin'); // звук подключения участника
    // Новичок ещё не знает, что мы показываем экран/камеру: media-update летит
    // только на переключении. Повторяем текущее состояние, чтобы его плитка
    // сразу знала про наше видео (флаг videoOn), а не ждала косвенных сигналов.
    if (camOn || screenOn) broadcastMediaState();
  });

  s.on('media-update', ({ from, camOn: peerCam, screenOn: peerScreen }) => {
    setTileVideoOn(from, peerCam || peerScreen);
  });

  // Собеседник сменил тег — обновляем подпись его плитки и имя пира.
  s.on('peer-renamed', ({ id, name }) => {
    tx().renamePeer(id, name);
    const t = tiles.get(id);
    if (t && t.name !== name) {
      // Тег сменился — переносим сохранённую громкость на новое имя, чтобы
      // выкрученные проценты не потерялись.
      if (t.volume !== 1 || t.screenVolume !== 1)
        savePeerVol(name, { voice: t.volume, screen: t.screenVolume });
      tiles.set(id, { ...t, name });
      syncTiles();
    }
  });

  // Владелец сменил транспорт канала прямо во время звонка — переезжаем все
  // вместе. Событие летит в комнату (а не только с реестром каналов) как раз
  // ради гостей: реестра у них нет, а разъехаться в транспортах нельзя.
  s.on('voice-mode', ({ room: changed, mode }) => {
    if (!room || changed !== room) return;
    toast('Канал переключён на ' + (mode === 'sfu' ? 'медиасервер' : 'прямые звонки') + '…');
    void remigrate();
  });

  s.on('voice-presence', (p: VoicePresence) => {
    useVoiceStore.getState().setPresence(p && typeof p === 'object' ? p : {});
  });

  s.on('connect', () => {
    // Свой id нужен, чтобы пометить себя в составе голосовых каналов
    useVoiceStore.getState().setMyId(s.id ?? null);
    if (!room) return;
    // Сессия восстановлена после кратковременного обрыва (socket.io connection
    // state recovery): id и комнаты те же, сервер не выкидывал нас из канала,
    // P2P-медиа всё это время текло. Ничего не пересобираем — иначе живой звонок
    // дёргался бы на каждое моргание сети.
    if (s.recovered) {
      setStatus('На связи: ' + room);
      return;
    }
    // Полноценный реконнект: у сокета новый id — все старые соединения мертвы,
    // собираем заново.
    tx().reset();
    toast('Связь с сервером восстановлена.');
    sfx().play('reconnect'); // связь восстановлена
    if (transport === sfuTransport) {
      // Пропуск в медиасервер выписан на прежний socket.id и вместе с ним умер —
      // нужен новый, а значит полный переезд, а не просто повторный join.
      void remigrate();
      return;
    }
    s.emit('join', { room, name: myName(), clientId: loadClientId() });
    setStatus('На связи: ' + room);
  });

  s.on('disconnect', () => {
    if (!room) return;
    setStatus('Связь с сервером потеряна, переподключаемся…');
    toast('Связь с сервером потеряна. Переподключаемся…');
    sfx().play('connLost'); // обрыв связи
  });

  // Метрики связи — целиком дело транспорта: он один знает, что и у кого мерить.
  if (!pingTimer) pingTimer = setInterval(() => tx().pollStats(), 3000);

  // Обводка «говорит сейчас» — частый, но дешёвый опрос анализаторов
  if (!vadTimer) vadTimer = setInterval(updateSpeaking, VAD_TICK_MS);

  // Шумовой гейт микрофона — отдельный, более частый тик для быстрой атаки
  if (!gateTimer) gateTimer = setInterval(evaluateGate, GATE_TICK_MS);
}

'use client';

import { toast } from 'sonner';
import { getSfx } from '@/lib/sfx';
import { tx as msg } from '@/lib/i18n';
import { useVoiceStore } from '@/stores/voice';
import { diag } from '@/lib/voice/diag';
import { roleOf, setTileScreenAudio, tileOf } from '@/lib/voice/tiles';

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
const SPEAKER_KEY = 'relay-speaker-id';

const peerAudio = new Map<string, PeerAudio>();

/**
 * Размер окна анализатора — один на весь звонок: и на голоса собеседников, и
 * на свой микрофон. 512 отсчётов при 48 кГц это ~10 мс, ровно тот масштаб, на
 * котором слышно начало слова.
 */
export const ANALYSER_FFT_SIZE = 512;

/**
 * Что микшеру нужно от того, чем он не владеет.
 */
export interface OutputSurroundings {
  /** Собеседник ушёл совсем — забыть, когда он в последний раз говорил. */
  forgetSpeaker(peerId: string): void;
}

let around: OutputSurroundings = { forgetSpeaker: () => {} };

export function initOutput(surroundings: OutputSurroundings): void {
  around = surroundings;
}

/**
 * Корень графа Web Audio. Он тут не потому, что микшер главнее захвата, а
 * потому, что мастер-громкость («глушилка») живёт ровно здесь: контекст и
 * узел, который её держит, создаются одной строкой и порознь не бывают.
 * Микрофону нужен тот же контекст — он его и спрашивает.
 */
export function getAudioCtx(): AudioContext {
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
  const t = tileOf(peerId);
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

export function attachRemoteAudio(
  peerId: string,
  track: MediaStreamTrack,
  mid: string | null,
  stream: MediaStream | null,
) {
  // Слушателя не подключаем к микшеру вовсе. В прямых звонках сервера между
  // нами нет, и «он не вправе говорить» здесь держится только на этой строчке:
  // клиент у гостя свой, дорожку он может собрать любую — а звучать она будет
  // ровно там, где её примут. Не примем.
  if (roleOf(peerId)?.listen) {
    diag('listener audio dropped', peerId);
    return;
  }
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
  analyser.fftSize = ANALYSER_FFT_SIZE;
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
export function detachRemoteAudio(peerId: string, track: MediaStreamTrack) {
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

export function cleanupPeerAudio(peerId: string) {
  const pa = peerAudio.get(peerId);
  if (!pa) return;
  pa.entries.forEach((e) => {
    e.source.disconnect();
    e.gain.disconnect();
  });
  pa.sink.srcObject = null;
  pa.sink.remove();
  peerAudio.delete(peerId);
  around.forgetSpeaker(peerId);
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
  toast(
    msg('voice.toast.speakerSwitched', {
      device: currentSpeakerLabel || msg('voice.toast.speakerSwitched.fallback'),
    }),
  );
}

/** Снимаем микшер целиком: узлы Web Audio и скрытые приёмники всех собеседников. */
export function teardownPeerAudio() {
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

/** Включён ли звук. Глушилка выключает и микрофон — но это решает дирижёр. */
export function isSpeakersOn(): boolean {
  return speakersOn;
}

/**
 * Мастер-громкость: 0 или 1. «Глушилка» целиком — это ещё и погасший микрофон
 * и sfx, но здесь только та её часть, которой владеет микшер.
 */
export function setSpeakersOn(on: boolean): void {
  speakersOn = on;
  useVoiceStore.getState().setSpeakersOn(on);
  if (masterGain) masterGain.gain.value = on ? 1 : 0;
}

/** Применить громкость к живому узлу собеседника. Плитка помнит, микшер играет. */
export function setPeerGain(peerId: string, kind: 'voice' | 'screen', value: number): void {
  const pa = peerAudio.get(peerId);
  const gain = kind === 'voice' ? pa?.micGain : pa?.screenGain;
  if (gain) gain.gain.value = value;
}

/**
 * Анализаторы голосовых дорожек собеседников — по ним зажигается обводка
 * «говорит сейчас». Звук демонстрации сюда не попадает: фильм не говорит.
 */
export function peerVoiceAnalysers(): [string, AnalyserNode | undefined][] {
  return [...peerAudio].map(([peerId, pa]) => [
    peerId,
    [...pa.entries.values()].find((e) => !e.isScreen)?.analyser,
  ]);
}

/** Перечитать устройства вывода — зовётся, когда доступ к устройствам выдан. */
export function refreshOutputDevices(): void {
  void refreshSpeakerInfo();
}

/**
 * Уже поднятый контекст — или `null`. Отдельно от `getAudioCtx`, и это не
 * синоним: тот контекст СОЗДАЁТ, а спрашивают его там, где ответ «ещё нет»
 * означает «делать нечего» (гейт микрофона, разбор цепочки на выходе).
 */
export function audioContext(): AudioContext | null {
  return audioCtx;
}

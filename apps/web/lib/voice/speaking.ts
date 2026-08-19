'use client';

import { useVoiceStore } from '@/stores/voice';
import { analyserRms, peerVoiceAnalysers } from '@/lib/voice/output';
import { hasLocalAnalyser, isMicOn, micLevelNorm, micRingThreshold } from '@/lib/voice/mic';

/**
 * Обводка «говорит сейчас» — та самая рамка вокруг плитки, что есть в Discord.
 *
 * Считается опросом, а не событиями: WebRTC про речь ничего не сообщает, и
 * единственный источник правды — уровень на анализаторе. Отсюда две вещи,
 * которые здесь важнее остального. Удержание (hangover) — иначе рамка мигает
 * между словами; и мгновенное гашение на муте — «говорит» у выключенного
 * микрофона это не запаздывание индикатора, а враньё.
 *
 * Свой уровень считается иначе, чем чужой: у себя есть порог гейта, и рамка
 * обязана совпадать с ним — зажигаться ровно тогда, когда микрофон реально
 * открывается. У собеседников порога нет, там простой RMS.
 */

// ─── Детект «говорит сейчас» (обводка плитки, как в Discord) ──────────────
// Снимаем RMS-уровень с анализаторов (свой микрофон + голос каждого собеседника)
// и зажигаем обводку выше порога, удерживая её ещё чуть-чуть после паузы, чтобы
// не мигала между словами.
const VAD_THRESHOLD = 0.04; // RMS 0..1: речь обычно выше, тишина/шумодав — ниже
const VAD_HANGOVER_MS = 300; // держим обводку после спада уровня
const VAD_TICK_MS = 100;

let vadTimer: ReturnType<typeof setInterval> | null = null;
const spokeAt = new Map<string, number>();
let lastSpeakingKey = '';

// ─────────────────────────────────────────────────────────────────────────
// Индикация «говорит сейчас» (VAD): обводка плитки по уровню звука
// ─────────────────────────────────────────────────────────────────────────

// Своя обводка: уровень в шкале метра против порога (или пола без гейта), с
// удержанием. На муте — мгновенно гаснет.
function localSpeaking(now: number): boolean {
  if (!isMicOn() || !hasLocalAnalyser()) {
    spokeAt.delete('local');
    return false;
  }
  if (micLevelNorm() >= micRingThreshold()) {
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

/**
 * Тик опроса уровней → список говорящих в стор (только при изменении состава).
 * Вне звонка гасим всё разом: анализаторы мертвы, а рамка на пустой сцене —
 * привет из прошлого разговора.
 */
export function updateSpeaking(inCall: boolean) {
  if (!inCall) {
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

/** Собеседник ушёл — забыть, когда он в последний раз говорил. */
export function forgetSpeaker(peerId: string): void {
  spokeAt.delete(peerId);
}

/** Выход из эфира: гасим всю индикацию разом. */
export function resetSpeaking(): void {
  spokeAt.clear();
  lastSpeakingKey = '';
  useVoiceStore.getState().setSpeakingIds([]);
}

/** Опрос уровней — частый, но дешёвый: чтение анализаторов, без аллокаций. */
export function startSpeakingWatch(inCall: () => boolean): void {
  if (vadTimer) return;
  vadTimer = setInterval(() => updateSpeaking(inCall()), VAD_TICK_MS);
}

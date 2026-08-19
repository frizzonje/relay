'use client';

import type { VoicePresence } from '@relay/shared';
import { useIdentityStore } from '@/stores/identity';
import { readPref, setPref } from '@/lib/prefs';
import { useVoiceStore, type TileNet, type VoiceTile } from '@/stores/voice';
import type { MessageKey } from '@/lib/i18n/translate';

/**
 * Что плиткам нужно от того, чем они не владеют.
 *
 * Список короткий намеренно: плитка — это витрина, и всё, что она умеет сама,
 * заканчивается на «положить в стор». Звук пира и его текущий транспорт живут
 * не здесь, а спросить их приходится ровно в трёх местах.
 */
export interface TileSurroundings {
  /** Собеседник ушёл — снять его узлы в микшере. */
  dropAudio(peerId: string): void;
  /** Применить громкость к живому узлу микшера (плитка помнит её, микшер — играет). */
  setGain(peerId: string, kind: 'voice' | 'screen', value: number): void;
  /** Крупный план сменился: SFU по этому поводу перекладывает слой simulcast. */
  focusChanged(id: string | null): void;
}

// Пока дирижёр не собрал сцену, плитки молчат в пустоту, а не падают: модуль
// грузится раньше первого звонка, и `initTiles` зовётся уже из `initVoice`.
let around: TileSurroundings = {
  dropAudio: () => {},
  setGain: () => {},
  focusChanged: () => {},
};

export function initTiles(surroundings: TileSurroundings): void {
  around = surroundings;
}

const tiles = new Map<string, VoiceTile>();

/**
 * Кто с нами в комнате — из presence: гость по инвайту, слушатель, и отпечаток
 * ключа (лицо человека). Плитка и presence приезжают в непредсказуемом порядке
 * (плитку заводит транспорт, роли — сигналинг), поэтому карта живёт отдельно:
 * `addTile` берёт из неё что успело приехать, а свежий presence правит уже
 * стоящие плитки.
 */
const peerRoles = new Map<string, { guest: boolean; listen: boolean; fingerprint?: string }>();

let focusedTileId: string | null = null;

/** Роль собеседника в этой комнате — гость, слушатель, лицо. */
export function roleOf(
  peerId: string,
): { guest: boolean; listen: boolean; fingerprint?: string } | undefined {
  return peerRoles.get(peerId);
}

/** Плитка по id — микшеру нужна её громкость, дирижёру её имя. */
export function tileOf(peerId: string): VoiceTile | undefined {
  return tiles.get(peerId);
}

/** Сколько собеседников в комнате (себя не считаем). */
export function remoteCount(): number {
  return tiles.size - (tiles.has('local') ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Персональная громкость собеседников. Ползунок ходит 0–3 (0–300%), значение
// применяется к GainNode как есть (без урезания).
//
// Запоминаем по ОТПЕЧАТКУ ключа, а не по имени: имена в relay свободные и не
// уникальные, и «этот долбик на 200%» по имени означал бы, что выкрученная
// громкость достаётся любому тёзке. Гостю по инвайту отпечатка не выдают —
// для него ключом остаётся имя, другого у него нет.
//
// Сама настройка принадлежит человеку и едет с ним на другие устройства
// (lib/prefs); localStorage под ней остался кэшем, поэтому записанное прежними
// версиями по имени продолжает работать как запасной вариант.
// ─────────────────────────────────────────────────────────────────────────

export const PEER_VOL_MAX = 3;
type PeerVol = { voice?: number; screen?: number };

function loadPeerVols(): Record<string, PeerVol> {
  const value = readPref<unknown>('volume', {});
  return value && typeof value === 'object' ? (value as Record<string, PeerVol>) : {};
}

/** Чем этот собеседник записан в настройках: отпечаток, а у гостя — имя. */
function volumeKey(peerId: string, name: string): string {
  return peerRoles.get(peerId)?.fingerprint || name;
}

/** Сохранённая громкость: по отпечатку, а если его нет — по имени (старые записи). */
function peerVol(peerId: string, name: string): PeerVol {
  const all = loadPeerVols();
  return all[volumeKey(peerId, name)] ?? all[name] ?? {};
}

export function savePeerVol(peerId: string, name: string, patch: PeerVol) {
  const key = volumeKey(peerId, name);
  if (!key) return;
  const all = loadPeerVols();
  setPref('volume', { ...all, [key]: { ...all[key], ...patch } });
}

function syncTiles() {
  useVoiceStore.getState().setTiles([...tiles.values()]);
}

export function addTile(id: string, name: string, stream: MediaStream | null, isLocal: boolean) {
  const existing = tiles.get(id);
  if (!existing) {
    // Для собеседника восстанавливаем ранее выкрученную ему громкость.
    const saved = isLocal ? {} : peerVol(id, name);
    const role = isLocal ? undefined : peerRoles.get(id);
    tiles.set(id, {
      id,
      name,
      stream,
      state: '' as const,
      isLocal,
      screen: false,
      volume: saved.voice ?? 1,
      screenVolume: saved.screen ?? 1,
      hasScreenAudio: false,
      // Своё лицо знаем сами, чужое — из presence, если он уже приехал; если
      // нет, его подставит syncPeerRoles, когда приедет.
      fingerprint: isLocal
        ? (useIdentityStore.getState().me?.fingerprint ?? undefined)
        : role?.fingerprint,
      guest: role?.guest,
      listen: role?.listen,
    });
  } else if (stream && existing.stream !== stream) {
    tiles.set(id, { ...existing, stream });
  } else {
    return; // нечего менять
  }
  syncTiles();
}

export function setTileState(id: string, state: MessageKey | '') {
  const t = tiles.get(id);
  if (!t || t.state === state) return;
  tiles.set(id, { ...t, state });
  syncTiles();
}

export function setTileScreen(id: string, screen: boolean) {
  const t = tiles.get(id);
  if (!t || t.screen === screen) return;
  tiles.set(id, { ...t, screen });
  syncTiles();
}

export function setTileVideoOn(id: string, on: boolean) {
  const t = tiles.get(id);
  if (!t || t.videoOn === on) return;
  tiles.set(id, { ...t, videoOn: on });
  syncTiles();
}

export function setTileScreenAudio(id: string, on: boolean) {
  const t = tiles.get(id);
  if (!t || t.hasScreenAudio === on) return;
  tiles.set(id, { ...t, hasScreenAudio: on });
  syncTiles();
}

// Качество связи меняется каждые 3 с — обновляем плитку, только если реально
// сдвинулись округлённые метрики (иначе лишний ре-рендер всей сетки на тик).
export function setTileNet(id: string, net: TileNet) {
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
export function removeTile(id: string) {
  around.dropAudio(id);
  if (focusedTileId === id) clearFocus();
  tiles.delete(id);
  syncTiles();
}

/** Снять плитки собеседников (при переезде их соберёт заново новый транспорт). */
export function dropRemoteTiles() {
  for (const id of [...tiles.keys()]) if (id !== 'local') removeTile(id);
}

/** Полный сброс сцены: выход из канала. */
export function clearTiles() {
  tiles.clear();
  syncTiles();
}

/** Переписать имя собеседника: он сменил тег. */
export function renameTile(id: string, name: string): void {
  const t = tiles.get(id);
  if (!t || t.name === name) return;
  tiles.set(id, { ...t, name });
  syncTiles();
}

/**
 * Переписать подпись своей плитки. Отдельно от `renameSelf`: ровно это же нужно
 * устройству, которое узнало о смене имени с другого своего устройства, — а
 * просить там сервер уже не о чем, он сам об этом и рассказал.
 */
export function relabelSelf(label: string) {
  const t = tiles.get('local');
  if (t && t.name !== label) {
    tiles.set('local', { ...t, name: label });
    syncTiles();
  }
}

/**
 * Кто в нашей комнате гость и кто из гостей только слушает. Нужно двум местам:
 * микшеру (звук слушателя не принимаем вовсе) и плиткам (подпись и «выгнать»).
 * Роль приезжает с presence, поэтому здесь же правим уже стоящие плитки —
 * транспорт мог завести их раньше.
 */
export function syncPeerRoles(presence: VoicePresence, room: string | null) {
  peerRoles.clear();
  let changed = false;
  for (const p of (room && presence[room]) || []) {
    const guest = p.guest === true;
    peerRoles.set(p.id, { guest, listen: p.listen === true, fingerprint: p.fingerprint });
    const t = tiles.get(p.id);
    if (t && guest && (t.guest !== true || t.listen !== (p.listen === true))) {
      tiles.set(p.id, { ...t, guest: true, listen: p.listen === true });
      changed = true;
    }
    // Лицо приезжает тем же presence и точно так же может опоздать за плиткой.
    // Без этого собеседник до конца звонка оставался бы безымянным пятном.
    if (t && p.fingerprint && t.fingerprint !== p.fingerprint) {
      tiles.set(p.id, { ...tiles.get(p.id)!, fingerprint: p.fingerprint });
      changed = true;
    }
    // Плитка могла встать раньше, чем приехало лицо: транспорт быстрее
    // сигналинга. Тогда громкость искали по имени и не нашли — ищем ещё раз,
    // теперь по отпечатку. Иначе выкрученная человеку громкость возвращалась
    // бы через раз, и понять почему было бы невозможно.
    if (t && p.fingerprint) applySavedVolume(p.id, t.name);
  }
  // Гостем перестать быть нельзя, а вот уйти — можно: плитка пережившего своего
  // хозяина флага осталась бы помеченной.
  for (const t of tiles.values()) {
    if (t.guest && !peerRoles.get(t.id)?.guest) {
      tiles.set(t.id, { ...t, guest: undefined, listen: undefined });
      changed = true;
    }
  }
  if (changed) syncTiles();
}

/**
 * Применить сохранённую громкость к уже стоящей плитке — не записывая ничего
 * обратно: это не выбор человека, а восстановление сделанного им раньше.
 */
function applySavedVolume(peerId: string, name: string) {
  const t = tiles.get(peerId);
  if (!t || t.isLocal) return;
  const saved = peerVol(peerId, name);
  const voice = saved.voice ?? 1;
  const screen = saved.screen ?? 1;
  if (t.volume === voice && t.screenVolume === screen) return;
  around.setGain(peerId, 'voice', voice);
  around.setGain(peerId, 'screen', screen);
  tiles.set(peerId, { ...t, volume: voice, screenVolume: screen });
  syncTiles();
}

/** Громкость голоса собеседника, 0–3 (1 = 100%). Дёргается из VideoTile. */
export function setPeerVolume(peerId: string, vol: number) {
  const v = Math.max(0, Math.min(PEER_VOL_MAX, vol));
  around.setGain(peerId, 'voice', v);
  const t = tiles.get(peerId);
  if (t) {
    tiles.set(peerId, { ...t, volume: v });
    savePeerVol(peerId, t.name, { voice: v }); // запоминаем на следующий заход
    syncTiles();
  }
}

/** Громкость звука демонстрации собеседника, 0–3 (1 = 100%). */
export function setPeerScreenVolume(peerId: string, vol: number) {
  const v = Math.max(0, Math.min(PEER_VOL_MAX, vol));
  around.setGain(peerId, 'screen', v);
  const t = tiles.get(peerId);
  if (t) {
    tiles.set(peerId, { ...t, screenVolume: v });
    savePeerVol(peerId, t.name, { screen: v });
    syncTiles();
  }
}

// ─── Крупный план ─────────────────────────────────────────────────────────

export function toggleFocus(id: string) {
  if (focusedTileId === id) clearFocus();
  else setFocus(id);
}

export function setFocus(id: string) {
  if (!tiles.has(id)) return;
  focusedTileId = id;
  useVoiceStore.getState().setFocus(id);
  around.focusChanged(id); // SFU: крупной плитке — верхний слой simulcast
}

export function clearFocus() {
  if (!focusedTileId) return;
  focusedTileId = null;
  useVoiceStore.getState().setFocus(null);
  around.focusChanged(null);
}

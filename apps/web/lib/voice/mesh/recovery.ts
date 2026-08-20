'use client';

import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';
import { tx } from '@/lib/i18n';
import type { TransportHost } from '../types';

/**
 * Лестница восстановления связи с одним собеседником:
 *   ступень 1 → ICE-restart (дёшево; частая причина обрыва — сменился сетевой путь);
 *   ступень 2 → пересборка соединения с нуля, через раз — ТОЛЬКО через TURN
 *               (relay-only): это спасает симметричный NAT/DPI, где host/srflx
 *               мертвы, а прямой путь не собирается.
 *
 * Пересборки повторяются с растущей паузой и НЕ кончаются никогда, пока
 * собеседник числится в канале: снять его — дело сервера (`peer-left`). Раньше
 * лестница сдавалась после двух ступеней и убирала плитку, и звонок оставался
 * молчать до перезахода — даже если сеть чинилась через десять секунд.
 *
 * Состояние лестницы — своё, ключом тот же `peerId`. Оно ПЕРЕЖИВАЕТ пересборку:
 * соединение выбрасывается и поднимается заново, а счёт попыток идёт тот же.
 * Раньше эти пять полей лежали в записи о собеседнике, вместе с ней умирали на
 * каждой пересборке и вручную переписывались в новую — по одному, руками, и
 * забыть там было проще всего.
 */

// `disconnected` часто поднимается сам (моргнула сеть, сменился путь) — даём
// паузу, но короткую: каждая лишняя секунда здесь — секунда тишины в разговоре.
const RECOVER_GRACE_MS = 4000;
// Сторож ступени: не помогло за это окно — идём дальше по лестнице.
const RECOVER_WINDOW_MS = 7000;
// «Вежливая» сторона ждёт на столько дольше на каждой ступени. Пересобирать
// соединение должен кто-то ОДИН: две встречные пересборки — это два новых pc,
// два отпечатка DTLS и лишний круг переговоров на ровном месте.
const POLITE_LAG_MS = 2500;
// Потолок паузы между повторными пересборками (растёт от RECOVER_WINDOW_MS).
const REBUILD_MAX_DELAY_MS = 30_000;

/**
 * Жив ли сигналинг. Без него ни одна ступень не работает: и offer ICE-restart'а,
 * и offer пересборки уходят через сокет. Пока он лежит, лестницу держим на паузе —
 * иначе она вхолостую прожжёт все ступени, пока чинить нечего (сокет вернётся —
 * догоним, см. resync).
 */
export function signalingUp(): boolean {
  try {
    return getSocket().connected !== false;
  } catch {
    return false;
  }
}

/** Собеседник глазами лестницы — не больше, чем ей нужно. */
export interface LadderPeer {
  name: string;
  /** «Вежливая» сторона ждёт дольше на каждой ступени. */
  polite: boolean;
  connected: boolean;
  pc: RTCPeerConnection;
}

export interface LadderDeps {
  host: TransportHost;
  /** Собеседник из таблицы пиров; null — его уже нет. */
  peer(peerId: string): LadderPeer | null;
  /** Есть ли в конфиге TURN: без него эскалация на relay-only бессмысленна. */
  hasTurn(): boolean;
  /** Закрыть соединение, оставив плитку: собеседник никуда не уходил. */
  dropConnection(peerId: string): void;
  /** Поднять соединение заново — инициатором (наш offer унесёт дорожки). */
  createPeer(peerId: string, name: string, relayOnly: boolean): void;
}

export interface Ladder {
  /** Связь есть: лестницу сбрасываем целиком. */
  markUp(peerId: string): void;
  /**
   * Сторож на ПЕРВОЕ соединение: offer мог не доехать, ICE — не собраться, а сам
   * по себе такой pc из 'connecting' не выйдет никогда. Окно шире обычного —
   * холодный старт с TURN бывает небыстрым.
   */
  armFirst(peerId: string): void;
  /**
   * `disconnected` — даём паузу, вдруг поднимется само. Если лестница уже идёт,
   * её сторож главнее: он считает окно текущей ступени, а не грейс.
   */
  armGrace(peerId: string): void;
  /** Шаг лестницы прямо сейчас (`failed`, догон после сигналинга). */
  recover(peerId: string): void;
  /** Сразу ступень 2, минуя ICE-restart (сторож тишины уже его пробовал). */
  rebuild(peerId: string): void;
  /** Забыть, на какой мы ступени, не трогая счёт пересборок (resync). */
  rewind(peerId: string): void;
  /** Снять сторож, оставив счёт: соединение выбрасывают, лестница продолжается. */
  disarm(peerId: string): void;
  /** Собеседника больше нет — с ним и вся его лестница. */
  forget(peerId: string): void;
  forgetAll(): void;
}

interface Rung {
  /** 0 — ничего, 1 — сделан ICE-restart, 2 — идут пересборки. */
  stage: number;
  /** Сколько раз пересобирали: задаёт и паузу, и политику ICE (через раз — TURN). */
  rebuilds: number;
  /**
   * Когда пересобрали в последний раз — чтобы пересборка, рухнувшая сразу, не
   * утаскивала в цикл «упало → пересобрали → упало» на скорости отказа ICE.
   */
  rebuiltAt: number;
  /** Про эту связь уже жаловались в тост — не повторяться на каждом круге. */
  warned: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createLadder({
  host,
  peer,
  hasTurn,
  dropConnection,
  createPeer,
}: LadderDeps): Ladder {
  const rungs = new Map<string, Rung>();

  function rungOf(peerId: string): Rung {
    let rung = rungs.get(peerId);
    if (!rung) {
      rung = { stage: 0, rebuilds: 0, rebuiltAt: 0, warned: false, timer: null };
      rungs.set(peerId, rung);
    }
    return rung;
  }

  function disarm(peerId: string) {
    const rung = rungs.get(peerId);
    if (!rung?.timer) return;
    clearTimeout(rung.timer);
    rung.timer = null;
  }

  // Завести сторож следующей ступени. «Вежливая» сторона ждёт чуть дольше:
  // пересборку должен вести кто-то один, иначе оба выбрасывают живые pc навстречу.
  function arm(peerId: string, delayMs: number) {
    const who = peer(peerId);
    if (!who) return;
    disarm(peerId);
    const rung = rungOf(peerId);
    rung.timer = setTimeout(
      () => {
        rung.timer = null;
        recover(peerId);
      },
      delayMs + (who.polite ? POLITE_LAG_MS : 0),
    );
  }

  // Пауза до следующей пересборки — растёт с числом уже сделанных, до потолка.
  function rebuildDelay(rebuilds: number): number {
    return Math.min(RECOVER_WINDOW_MS * Math.max(1, rebuilds), REBUILD_MAX_DELAY_MS);
  }

  // Дёргается из handleStateChange (failed/disconnected) и из собственных сторожей.
  function recover(peerId: string) {
    const who = peer(peerId);
    if (!who) return;
    disarm(peerId);
    const rung = rungOf(peerId);
    // Уже снова на связи (гонка таймеров) — ничего не делаем.
    if (who.connected) {
      rung.stage = 0;
      return;
    }
    if (!signalingUp()) {
      arm(peerId, RECOVER_WINDOW_MS); // сигналинг лежит — ступень не доедет
      return;
    }

    if (rung.stage === 0) {
      rung.stage = 1;
      host.diag('mesh recover', `stage 1: restart-ice with ${who.name}`);
      host.setTileState(peerId, 'tile.state.reconnecting');
      who.pc.restartIce();
      // Сторож: если ICE-restart не поднял связь за окно — идём на следующую ступень.
      arm(peerId, RECOVER_WINDOW_MS);
      return;
    }

    rebuild(peerId);
  }

  // Ступень 2: закрываем мёртвый pc и поднимаем новый как инициатор — наш offer
  // унесёт дорожки, удалённая сторона узнает пересборку по сменившемуся отпечатку
  // DTLS и ответит уже со свежего pc (см. обработчик 'offer'). Плитку сохраняем —
  // обновляем только статус.
  function rebuild(peerId: string) {
    const old = peer(peerId);
    if (!old) return;
    // Своих дорожек нет (вышли из канала прямо сейчас) — пересобирать нечего.
    if (!host.localStream()) return;
    const rung = rungOf(peerId);

    // Пауза между пересборками. Сеть, которая не даёт связь третий раз подряд, не
    // починится от того, что мы будем долбиться в неё каждые семь секунд, — а
    // пересборка, рухнувшая мгновенно, иначе увела бы в цикл на скорости отказа ICE.
    const wait = rebuildDelay(rung.rebuilds);
    const since = Date.now() - rung.rebuiltAt;
    if (rung.rebuilds > 0 && since < wait) {
      arm(peerId, wait - since);
      return;
    }

    const { name } = old;
    rung.rebuilds += 1;
    // Нечётная попытка идёт через TURN (если он есть), чётная — обычным путём:
    // сеть могла и починиться, а реле — лишний крюк по задержке и чужой трафик.
    const relayOnly = hasTurn() && rung.rebuilds % 2 === 1;
    // Жалуемся ровно один раз на пира: дальше молча продолжаем попытки.
    const warn = !rung.warned && rung.rebuilds > 1;
    rung.warned ||= warn;

    dropConnection(peerId);
    host.diag(
      'mesh recover',
      `stage 2: rebuild #${rung.rebuilds}${relayOnly ? ' relay-only' : ''} with ${name}`,
    );
    // relay-only — отдельная подпись: прямой путь не собрался, идём через TURN.
    host.setTileState(peerId, relayOnly ? 'tile.state.fallback' : 'tile.state.reconnecting');
    createPeer(peerId, name, relayOnly); // инициатор — мы
    if (!peer(peerId)) return;

    rung.stage = 2;
    rung.rebuiltAt = Date.now();
    arm(peerId, rebuildDelay(rung.rebuilds));

    if (warn) {
      toast.error(tx('voice.toast.peerUnreachable', { name }));
      host.playSfx('error'); // соединиться не вышло
    }
  }

  return {
    markUp(peerId) {
      disarm(peerId);
      const rung = rungOf(peerId);
      rung.stage = 0;
      rung.rebuilds = 0;
      rung.warned = false; // связь была — следующий провал стоит показать снова
    },

    armFirst(peerId) {
      arm(peerId, RECOVER_WINDOW_MS * 2);
    },

    armGrace(peerId) {
      if (rungOf(peerId).stage !== 0) return;
      arm(peerId, RECOVER_GRACE_MS);
    },

    recover,
    rebuild,

    rewind(peerId) {
      rungOf(peerId).stage = 0;
    },

    disarm,

    forget(peerId) {
      disarm(peerId);
      rungs.delete(peerId);
    },

    forgetAll() {
      rungs.forEach((_rung, peerId) => disarm(peerId));
      rungs.clear();
    },
  };
}

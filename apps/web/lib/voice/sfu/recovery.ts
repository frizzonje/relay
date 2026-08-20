'use client';

import type { TransportHost } from '../types';

/**
 * Лестница восстановления связи с медиасервером.
 *
 * В mesh лестница чинила связь с КАЖДЫМ собеседником отдельно (ICE-restart →
 * пересборка relay-only). Здесь собеседник ровно один — сервер, — поэтому и
 * лестница одна на звонок, зато её обрыв уносит сразу всех: последняя ступень
 * не «снять пира», а позвать дирижёра (он решит, ехать ли в p2p).
 *
 * Здесь только состояние и решения: чем именно чинить — ступени приезжают
 * снаружи. Смысл разреза в этом и есть. Шесть переменных лестницы правились из
 * девяти мест, включая обработчики сокета и вход в комнату, — и ровно в этом
 * зазоре жили «зелёная связь без микрофона» и «сдались, но сторож всё ещё
 * тикает».
 */

// Окно на каждую ступень: не поднялись за него — идём дальше. Столько же ждёт
// mesh на своём ICE-restart.
const RECOVER_WINDOW_MS = 8_000;

// Сколько ждём медиасервер на входе: welcome + оба транспорта. Не поднялись —
// это отказ, а не «ещё чуть-чуть»: дирижёр уведёт звонок в p2p.
const SETUP_TIMEOUT_MS = 12_000;

export interface LadderDeps {
  host: TransportHost;
  /** Развалилась ли связь с сервером прямо сейчас. */
  broken(): boolean;
  /** Есть ли ещё сокет: без него чинить нечем и незачем. */
  hasSocket(): boolean;
  /** На связи ли сокет прямо сейчас (обрыв сигналинга — отдельная история). */
  socketConnected(): boolean;
  /** Ступень 1: переизбрать ICE, не трогая дорожки. */
  restartIce(): Promise<void>;
  /** Ступень 2: выбросить транспорты и построить заново поверх того же сокета. */
  rebuild(): Promise<void>;
  /**
   * Сказать на плитках, что связь чинится, — и убрать надпись, когда починили.
   * Транспорт у медиасервера один на всех, поэтому и надпись на всех сразу:
   * развалился он, а не связь с кем-то одним.
   */
  tellTiles(broken: boolean): void;
}

export interface Ladder {
  /** Мы встали. До этого момента лестница бессмысленна: чинить нечего. */
  markUp(): void;
  isUp(): boolean;
  /** Уже сдались и позвали дирижёра. */
  gaveUp(): boolean;
  /** Сторож входа: не поднялись за окно — это отказ. */
  armSetup(): void;
  /** Транспорт сообщил о смене состояния. */
  transportState(direction: 'send' | 'recv', state: string): void;
  /** Сигналинг оборвался: даём окно на возврат, потом сдаёмся. */
  signalingLost(): void;
  /** Лестница кончилась. Куда ехать дальше — не наше решение, а дирижёра. */
  giveUp(reason: 'setup' | 'lost'): void;
  /** Разбор: снять все сторожа и забыть, где мы были. */
  reset(): void;
}

export function createLadder({
  host,
  broken,
  hasSocket,
  socketConnected,
  restartIce,
  rebuild,
  tellTiles,
}: LadderDeps): Ladder {
  // 0 — всё в порядке, 1 — сделан ICE-restart, 2 — транспорты пересобраны.
  // Дальше идти некуда, решает дирижёр.
  let stage = 0;
  /**
   * Сказано ли на плитках, что связь чинится. Снимать надпись, которую ставили
   * не мы, нельзя — на входе там стоит «соединение…», и погасить его раньше
   * времени значило бы объявить готовым то, чего ещё нет.
   */
  let saidReconnecting = false;
  let failTimer: ReturnType<typeof setTimeout> | null = null;
  let setupTimer: ReturnType<typeof setTimeout> | null = null;
  let socketTimer: ReturnType<typeof setTimeout> | null = null;
  // ready — мы хоть раз встали; lost — уже сдались и позвали дирижёра.
  let ready = false;
  let lost = false;

  function say(brokenNow: boolean) {
    if (brokenNow === saidReconnecting) return;
    saidReconnecting = brokenNow;
    tellTiles(brokenNow);
  }

  function clearTimers() {
    for (const timer of [failTimer, setupTimer, socketTimer]) {
      if (timer) clearTimeout(timer);
    }
    failTimer = null;
    setupTimer = null;
    socketTimer = null;
  }

  function schedule(delayMs: number) {
    // Лестница уже идёт; мы ещё не вставали; мы уже сдались и позвали дирижёра.
    if (failTimer || !ready || lost) return;
    failTimer = setTimeout(() => {
      failTimer = null;
      void climb();
    }, delayMs);
  }

  async function climb() {
    if (!hasSocket() || !broken()) {
      stage = 0; // отпустило само, пока ждали
      return;
    }
    if (stage === 0) {
      stage = 1;
      host.setStatus('voice.status.sfuReconnecting');
      host.diag('sfu recover', 'stage 1: restart-ice');
      await restartIce();
      schedule(RECOVER_WINDOW_MS); // сторож: не помогло — следующая ступень
      return;
    }
    if (stage === 1) {
      stage = 2;
      host.setStatus('voice.status.sfuRebuilding');
      host.diag('sfu recover', 'stage 2: rebuild transports');
      await rebuild();
      schedule(RECOVER_WINDOW_MS);
      return;
    }
    giveUp('lost');
  }

  function giveUp(reason: 'setup' | 'lost') {
    if (lost) return; // дирижёр уже позван — второй раз незачем
    lost = true;
    clearTimers();
    host.setStatus('voice.status.sfuUnavailable');
    host.transportLost(reason);
  }

  return {
    markUp() {
      ready = true;
      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = null;
    },
    isUp: () => ready,
    gaveUp: () => lost,

    armSetup() {
      setupTimer = setTimeout(() => {
        setupTimer = null;
        if (!ready) giveUp('setup');
      }, SETUP_TIMEOUT_MS);
    },

    transportState(direction, state) {
      if (state === 'connected') {
        // Встали (сами или после ступени лестницы) — сбрасываем её.
        if (failTimer) clearTimeout(failTimer);
        failTimer = null;
        stage = 0;
        // Транспорта два, и встать они могут не одновременно: пока второй лежит,
        // связи всё ещё нет, и снимать надпись рано.
        if (!broken()) say(false);
        return;
      }
      // 'disconnected' часто сам проходит за секунду-другую (перескок сети),
      // поэтому даём ему фору; 'failed' — окончательно, лечим сразу.
      if (state !== 'failed' && state !== 'disconnected') return;
      host.diag('sfu transport', `${direction} ${state}`);
      // Только когда звонок уже стоял: на входе на плитках своя надпись, и
      // «переподключение…» вместо «соединение…» было бы про другое.
      if (ready) say(true);
      schedule(state === 'failed' ? 0 : 4_000);
    },

    signalingLost() {
      if (!ready || lost) return;
      host.diag('sfu signaling lost');
      host.setStatus('voice.status.sfuSignalingLost');
      if (socketTimer) clearTimeout(socketTimer);
      socketTimer = setTimeout(() => {
        socketTimer = null;
        if (!socketConnected()) giveUp('lost');
      }, RECOVER_WINDOW_MS);
    },

    giveUp,

    reset() {
      clearTimers();
      stage = 0;
      saidReconnecting = false;
      ready = false;
      lost = false;
    },
  };
}

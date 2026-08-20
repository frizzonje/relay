'use client';

import type { Transport } from 'mediasoup-client/types';
import type { TransportHost } from '../types';
import { gradeQuality, pingGrade } from '../quality';
import {
  netDelta,
  readStats,
  sumStats,
  toHistory,
  type NetSnapshot,
  type StatsSnapshot,
} from '../stats';
import type { Ask } from './protocol';
import type { ConsumerEntry, Subscriber } from './subscribe';
import type { UplinkStatus } from '@/stores/voice';

/**
 * Всё, что показывают о звонке цифры: пинг, палочки качества, здоровье своего
 * аплинка и сторож односторонней тишины.
 *
 * Читатели разные, а источник у них один — снимок статистики за тик (см.
 * ../stats.ts). Поэтому и предмет один: разведи их по разным местам, и они
 * снова начнут спрашивать `getStats` каждый сам, каждый в свой момент времени.
 */

// Столько молчания входящей дорожки считаем сбоем, а не паузой в разговоре.
// Порог тот же, что и в mesh: мут у нас — `track.enabled = false`, RTP при этом
// продолжает идти, так что молчащий собеседник байты всё равно шлёт.
const SILENCE_MS = 8_000;

/** Отсев пропавших снимков, он же сужение типа: `undefined` из карты сюда не едет. */
const isSnapshot = (s: StatsSnapshot | undefined): s is StatsSnapshot => s !== undefined;

export interface MetricsDeps {
  host: TransportHost;
  subscriber: Subscriber;
  ask: Ask;
  /** Транспорты до сервера — с них снимается RTT. */
  transports(): (Transport | null)[];
  /** Здоровье своего аплинка знает публикация: producer'ы у неё. */
  uplink(): Promise<UplinkStatus>;
  /** Развалилась ли связь с сервером. */
  broken(): boolean;
  /** Встали ли мы хоть раз и не сдались ли уже. */
  isUp(): boolean;
  gaveUp(): boolean;
  /** Ступени починки пути до сервера — те же, которыми ходит лестница. */
  restartIce(): Promise<void>;
  rebuild(): Promise<void>;
}

export interface Metrics {
  /** Тик опроса: один снимок с каждого источника, все читатели по нему. */
  tick(): Promise<void>;
  /**
   * Погасить палочки у всех сразу: путь до медиасервера один на всех, и если
   * развалился он, то про связь с каждым мы не знаем ничего.
   *
   * Гасить приходится явно. Само по себе молчание транспорта выглядит на
   * счётчиках consumer'ов как полный штиль: потерь за интервал ноль, rtt
   * `null`, — и `gradeQuality(null, 0)` уверенно рисует четыре палочки ровно в
   * ту минуту, когда связи нет. Индикатор для того и нужен, чтобы в тишине
   * ответить «у меня или у него», и врать он не имеет права. В mesh это есть с
   * самого начала (`connState !== 'connected'` — и всё в `null`).
   */
  dim(): void;
  reset(): void;
}

export function createMetrics({
  host,
  subscriber,
  ask,
  transports,
  uplink,
  broken,
  isUp,
  gaveUp,
  restartIce,
  rebuild,
}: MetricsDeps): Metrics {
  // Счётчики прошлого тика по собеседникам — из них считаются потери за
  // интервал и мгновенный битрейт.
  const netHistory = new Map<string, NetSnapshot>();
  // Входящий звук по consumerId: сколько байт видели в прошлый раз, когда они
  // в последний раз росли и сколько раз мы уже будили эту дорожку.
  const audioFlow = new Map<string, { bytes: number; since: number; kicks: number }>();

  function dim() {
    for (const peerId of subscriber.peerIds()) {
      netHistory.delete(peerId);
      host.setTileNet(peerId, {
        grade: 'bad',
        rttMs: null,
        lossPct: null,
        jitterMs: null,
        relay: null,
        sendKbps: null,
        recvKbps: null,
        videoRes: null,
        fps: null,
        codec: null,
        via: 'sfu',
        layer: null,
      });
    }
  }

  // ── Палочки качества ──────────────────────────────────────────────────
  //
  // Семантика здесь другая, чем в mesh, и подменять одно другим нельзя: RTT и
  // потери — это НАШ канал до сервера, а не до собеседника; его половину пути
  // мы не видим в принципе. Поэтому «↑ кбит/с к нему» и «через реле» на плитке
  // молчат (их больше нет), зато появляется то, чего в mesh не бывает: какой
  // слой simulcast реально доехал. Тултип помечен `via: 'sfu'`.

  /** RTT до медиасервера — общий для всех плиток: путь-то один. */
  async function serverRtt(): Promise<number | null> {
    for (const transport of transports()) {
      if (!transport || transport.closed) continue;
      try {
        const rtt = readStats(await transport.getStats()).rttMs;
        if (rtt != null) return rtt;
      } catch {
        /* транспорт мог закрыться под руками — просто пробуем второй */
      }
    }
    return null;
  }

  function updatePing(rtt: number | null) {
    if (subscriber.peerIds().length === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'ping.alone' });
      return;
    }
    if (rtt == null) {
      host.setPing({
        waiting: true,
        ms: null,
        grade: null,
        label: isUp() ? 'ping.measuring' : 'ping.connecting',
      });
      return;
    }
    host.setPing({ waiting: false, ms: rtt, grade: pingGrade(rtt), label: '' });
  }

  /**
   * Один снимок с каждой чужой дорожки за тик — и два читателя на него.
   *
   * Палочки и сторож тишины спрашивали каждый свой `getStats`, то есть звук
   * собеседника опрашивался дважды за тик и в два разных момента: сторож видел
   * байты, которых палочки в том же тике уже не видели.
   */
  async function collectConsumerStats(): Promise<Map<string, StatsSnapshot>> {
    const snaps = new Map<string, StatsSnapshot>();
    for (const entry of subscriber.entries()) {
      if (entry.consumer.closed) continue;
      try {
        snaps.set(entry.producerId, readStats(await entry.consumer.getStats()));
      } catch {
        /* consumer мог закрыться между тиками */
      }
    }
    return snaps;
  }

  function updatePeerQuality(rtt: number | null, snaps: Map<string, StatsSnapshot>) {
    // Связь до сервера развалилась — мерить нечего и незачем: см. `dim`.
    if (broken()) {
      dim();
      return;
    }
    for (const peerId of subscriber.peerIds()) {
      const mine = subscriber.entries().filter((e) => e.peerId === peerId);
      if (mine.length === 0) {
        netHistory.delete(peerId); // ещё ничего не слушаем — мерить нечего
        continue;
      }

      // Дорожек у собеседника несколько, а плитка одна: складываем в один снимок.
      const snap = sumStats(mine.map((e) => snaps.get(e.producerId)).filter(isSnapshot));

      // Потери и битрейт — за интервал, а не накопленным итогом с начала звонка.
      const now = Date.now();
      const delta = netDelta(netHistory.get(peerId), snap, now);
      netHistory.set(peerId, toHistory(snap, now));

      // Слой берём с камеры: у демонстрации он один, показывать нечего.
      const cam = mine.find((e) => e.source === 'cam');
      const layer = cam ? subscriber.layerOf(cam.consumer.id) : null;

      host.setTileNet(peerId, {
        grade: gradeQuality(rtt, delta.lossPct ?? 0),
        rttMs: rtt,
        lossPct: delta.lossPct,
        jitterMs: snap.jitterMs,
        relay: null, // TURN в этом режиме не участвует — путь всегда через сервер
        sendKbps: null, // исходящий у нас общий на всех, «к нему» не существует
        recvKbps: delta.recvKbps,
        videoRes: snap.videoRes,
        fps: snap.fps,
        codec: snap.codec,
        via: 'sfu',
        layer,
      });
    }
  }

  // ── Сторож односторонней тишины ───────────────────────────────────────
  //
  // Самая частая жалоба на звонок: «связь есть, палочки горят, а звука нет, и
  // само не проходит». В mesh её ловит `monitorAudioFlow` по байтам входящего
  // аудио; здесь до сих пор не ловил никто, хотя на медиасервере у этого сбоя
  // есть свой отдельный путь, вдобавок к сетевому: consumer приезжает на паузе
  // и снимается с неё отдельным запросом `resume`. Не дошёл запрос — дорожка
  // осталась на паузе навсегда, и снаружи это неотличимо от «прислали тишину».
  //
  // Отсюда и лестница, и её первая ступень, которой в mesh быть не может:
  // повторить `resume`. Дальше — общая сетевая: переизбрать ICE, потом собрать
  // транспорты заново.
  //
  // Условия «звук шёл и оборвался» здесь, в отличие от mesh, нет намеренно:
  // consumer существует только потому, что у собеседника есть дорожка, — и
  // ноль байт с самого начала как раз и означает ту самую вечную паузу.
  async function monitorAudioFlow(snaps: Map<string, StatsSnapshot>) {
    // Лестница уже идёт своим ходом — второй раз чинить то же самое незачем.
    if (!isUp() || gaveUp() || broken()) return;

    const now = Date.now();
    const wake: { entry: ConsumerEntry; secs: number }[] = [];
    let worstKick = 0;

    for (const entry of subscriber.entries()) {
      if (entry.consumer.kind !== 'audio' || entry.consumer.closed) continue;
      const snap = snaps.get(entry.producerId);
      if (!snap) continue; // дорожка закрылась под руками сборщика
      const bytes = snap.audioBytesRecv;
      const prev = audioFlow.get(entry.consumer.id);
      if (!prev || bytes > prev.bytes) {
        audioFlow.set(entry.consumer.id, { bytes, since: now, kicks: 0 });
        // Молчал, а теперь пошёл — снять с плитки надпись, которую поставили мы.
        if (prev?.kicks) subscriber.sayTileState(entry.peerId);
        continue;
      }
      if (now - prev.since <= SILENCE_MS) continue;

      // Байты не растут дольше порога. Отметку времени двигаем сразу: она же и
      // не даёт лестнице сорваться в цикл — следующая попытка не раньше чем
      // через SILENCE_MS.
      const kicks = prev.kicks + 1;
      const secs = Math.round((now - prev.since) / 1000);
      audioFlow.set(entry.consumer.id, { bytes, since: now, kicks });
      const name = subscriber.nameOf(entry.peerId) ?? entry.peerId;
      console.warn(
        `[sfu] нет входящего звука от «${name}» (${entry.peerId}) ${secs}с; bytesReceived=${bytes}`,
      );
      host.setTileState(entry.peerId, 'tile.state.reconnecting');
      if (kicks === 1) wake.push({ entry, secs });
      worstKick = Math.max(worstKick, kicks);
    }

    // Ступень 1 — по каждой молчащей дорожке отдельно: она и молчит отдельно.
    for (const { entry, secs } of wake) {
      host.diag(
        'sfu silence',
        `${subscriber.nameOf(entry.peerId) ?? entry.peerId} ${secs}s: resume`,
      );
      if (!(await ask('resume', { consumerId: entry.consumer.id }))) {
        host.diag('sfu resume failed', `wake ${entry.peerId}`);
      }
    }
    // Ступени 2 и 3 — общие: чинится не дорожка, а путь до сервера. Поэтому и
    // одна попытка на тик, сколько бы дорожек ни молчало.
    if (worstKick === 2) {
      host.diag('sfu silence', 'stage 2: restart-ice');
      await restartIce();
    } else if (worstKick > 2) {
      host.diag('sfu silence', 'stage 3: rebuild transports');
      await rebuild();
    }
  }

  return {
    async tick() {
      const rtt = await serverRtt();
      const snaps = await collectConsumerStats();
      updatePing(rtt);
      // Палочки — до сторожа: сторож чинит связь, и после его ступени снимок
      // этого тика описывал бы дорожки, которых уже нет.
      updatePeerQuality(rtt, snaps);
      host.setUplink(await uplink());
      await monitorAudioFlow(snaps);
    },

    dim,

    reset() {
      netHistory.clear();
      audioFlow.clear();
    },
  };
}

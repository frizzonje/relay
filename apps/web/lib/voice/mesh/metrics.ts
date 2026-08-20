'use client';

import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost } from '../types';
import { gradeQuality, pingGrade } from '../quality';
import {
  netDelta,
  readStats,
  toHistory,
  worseUplink,
  type NetSnapshot,
  type StatsSnapshot,
} from '../stats';
import type { Silence, SilenceFix } from './silence';

/**
 * Всё, что показывают о звонке цифры: пинг, палочки качества на плитках,
 * здоровье своего аплинка и сторож односторонней тишины.
 *
 * Читатели разные, а источник у них один — снимок статистики за тик. Поэтому и
 * предмет один: разведи их по разным местам, и они снова начнут спрашивать
 * `getStats` каждый сам, каждый в свой момент времени. Точно так же устроены
 * метрики SFU (`sfu/metrics.ts`).
 *
 * Палочки — тот же getStats, что кормит панель пинга, но пер-пир: RTT из
 * candidate-pair, потери за интервал (дельта packetsLost/Received между тиками)
 * и джиттер аудио. Результат едет в `tile.net`, рисует его SignalBars.
 *
 * Пороги, проценты и битрейт — в `lib/voice/quality.ts`: по тем же цифрам
 * считает SFU-транспорт, и расходиться им нельзя. Палочка должна значить одно
 * и то же, каким бы транспортом ни пришёл звук.
 */

/** Собеседник глазами метрик. */
export interface MetricsPeer {
  name: string;
  pc: RTCPeerConnection;
  /**
   * Сводное состояние, а не сырой `connectionState`: на Safari/iOS последний
   * ненадёжен — висит в 'connecting' при живом медиа.
   */
  connected: boolean;
}

export interface MetricsDeps {
  host: TransportHost;
  silence: Silence;
  /** Таблица собеседников на этот тик. */
  peers(): Map<string, MetricsPeer>;
  /** Мы в звонке? Вне его цифрам некуда ехать. */
  inRoom(): boolean;
  /** Починить связь, в которой звук был и пропал. Чинит лестница, не метрики. */
  repair(peerId: string, fix: SilenceFix): void;
}

export interface Metrics {
  /** Тик опроса: один снимок с каждого соединения, все читатели по нему. */
  tick(): Promise<void>;
  /** Соединения больше нет — историю счётчиков с ним. */
  forget(peerId: string): void;
  reset(): void;
}

export function createMetrics({ host, silence, peers, inRoom, repair }: MetricsDeps): Metrics {
  const netHistory = new Map<string, NetSnapshot>();

  /**
   * Один снимок с каждого соединения за тик — и три читателя на него.
   *
   * Раньше пинг, палочки и сторож тишины ходили в `getStats` каждый сам, то
   * есть на пятерых с видео выходило пятнадцать полных снимков статистики
   * каждые три секунды. Дело даже не в работе: это были три РАЗНЫХ момента
   * времени, и сторож видел байты, которых палочки в том же тике уже не
   * видели. Свести такие показания в одну картину нельзя в принципе.
   */
  async function collect(table: Map<string, MetricsPeer>): Promise<Map<string, StatsSnapshot>> {
    const snaps = new Map<string, StatsSnapshot>();
    for (const [id, peer] of table) {
      if (!peer.connected) continue;
      try {
        snaps.set(id, readStats(await peer.pc.getStats()));
      } catch {
        /* getStats может кинуть на закрывающемся pc — пропускаем пира */
      }
    }
    return snaps;
  }

  function updatePing(table: Map<string, MetricsPeer>, snaps: Map<string, StatsSnapshot>) {
    if (table.size === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'ping.alone' });
      return;
    }

    let rttMs: number | null = null;
    for (const snap of snaps.values()) {
      if (snap.rttMs !== null && (rttMs === null || snap.rttMs < rttMs)) rttMs = snap.rttMs;
    }
    // «Устанавливаем связь» и «меряем» — разные вещи: связь есть, а цифры ещё
    // не приехали. Отвечает на это состояние соединения, а не наличие снимка.
    const anyConnected = [...table.values()].some((p) => p.connected);

    if (rttMs === null) {
      host.setPing({
        waiting: true,
        ms: null,
        grade: null,
        label: anyConnected ? 'ping.measuring' : 'ping.connecting',
      });
      return;
    }

    host.setPing({ waiting: false, ms: rttMs, grade: pingGrade(rttMs), label: '' });
  }

  function updatePeerQuality(table: Map<string, MetricsPeer>, snaps: Map<string, StatsSnapshot>) {
    // Худшее «узкое место» аплинка по всем пирам (bandwidth важнее cpu). Считаем
    // за один проход и раскладываем в стор после цикла — это СВОЙ показатель, общий.
    let worstUplink: UplinkStatus = 'ok';

    for (const [id, peer] of table) {
      // Связь переустанавливается — палочки гаснут (bad), метрики неизвестны.
      if (!peer.connected) {
        netHistory.delete(id);
        host.setTileNet(id, {
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
        });
        continue;
      }

      const snap = snaps.get(id);
      if (!snap) continue; // соединение закрылось под руками сборщика
      // Своё «узкое место» — общее на всех: аплинк у нас один, а видим мы его
      // с каждого соединения по-своему. Берём худшее.
      worstUplink = worseUplink(worstUplink, snap.uplink);

      // Потери и битрейт — за интервал, а не накопленным итогом с начала звонка.
      const now = Date.now();
      const delta = netDelta(netHistory.get(id), snap, now);
      netHistory.set(id, toHistory(snap, now));

      host.setTileNet(id, {
        grade: gradeQuality(snap.rttMs, delta.lossPct ?? 0),
        rttMs: snap.rttMs,
        lossPct: delta.lossPct,
        jitterMs: snap.jitterMs,
        relay: snap.relay,
        sendKbps: delta.sendKbps,
        recvKbps: delta.recvKbps,
        videoRes: snap.videoRes,
        fps: snap.fps,
        codec: snap.codec,
      });
    }

    host.setUplink(worstUplink);
  }

  return {
    async tick() {
      if (!inRoom()) return;
      const table = peers();
      const snaps = await collect(table);
      updatePing(table, snaps);
      // Палочки — до сторожа: сторож чинит связь, и после его ступени снимок
      // этого тика описывал бы соединение, которого уже нет.
      updatePeerQuality(table, snaps);

      const probes = [...table].map(([id, peer]) => ({
        id,
        name: peer.name,
        pc: peer.pc,
        connected: peer.connected,
        audioBytesRecv: snaps.get(id)?.audioBytesRecv ?? null,
      }));
      for (const { peerId, fix } of silence.check(probes)) repair(peerId, fix);
    },

    forget(peerId) {
      netHistory.delete(peerId);
    },

    reset() {
      netHistory.clear();
    },
  };
}

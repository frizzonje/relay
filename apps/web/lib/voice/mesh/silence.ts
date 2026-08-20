'use client';

import type { TransportHost } from '../types';

/**
 * Сторож односторонней тишины — ровно тот сбой, на который жалуются: `pc` бодро
 * рапортует `connected`, палочки горят, а звука нет, и сам он из этого состояния
 * не выйдет никогда.
 *
 * Признак простой: байты входящего аудио перестали расти. Сторож их считает и
 * говорит наружу ОДНО — кого чинить и насколько сильно. Чинит лестница: решение
 * «restart-ice или пересборка» здесь принимается по числу подряд идущих
 * срабатываний, а не по состоянию соединения, и смешивать эти два счёта в одном
 * файле не за чем.
 *
 * Ложных срабатываний не боимся: мут у нас — это `track.enabled = false`, RTP при
 * этом продолжает идти (DTX в SDP выключен принудительно), а собеседника, который
 * не слал звук НИ РАЗУ, отсекает условие `prev.bytes > 0`.
 */

// Связь «есть», а входящего звука нет столько — считаем поломкой и чиним.
const SILENCE_MS = 8000;

/** Что сторожу нужно знать о собеседнике на этом тике. */
export interface SilenceProbe {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  /** Связь по сводному состоянию (не сырой connectionState — он врёт на iOS). */
  connected: boolean;
  /** Байты входящего ЗВУКА из снимка getStats; null — снимка на этом тике нет. */
  audioBytesRecv: number | null;
}

/** Насколько сильно чинить: первое срабатывание — дёшево, дальше — с нуля. */
export type SilenceFix = 'restart-ice' | 'rebuild';

export interface Silence {
  /** Один тик. Возвращает, кого чинить и насколько сильно. */
  check(peers: SilenceProbe[], now?: number): { peerId: string; fix: SilenceFix }[];
  /** Соединения больше нет — счётчик вместе с ним. */
  forget(peerId: string): void;
  forgetAll(): void;
}

export interface SilenceDeps {
  host: TransportHost;
  /**
   * Жив ли сигналинг. Пока он лежит, чинить нечем — ни один offer не доедет, — и
   * счётчик попыток трогать нельзя: иначе за время обрыва он сам себя доведёт до
   * пересборки, а чинить будет уже нечего.
   */
  signalingUp(): boolean;
}

export function createSilence({ host, signalingUp }: SilenceDeps): Silence {
  const flow = new Map<string, { bytes: number; since: number; kicks: number }>();

  return {
    check(peers, now = Date.now()) {
      const fixes: { peerId: string; fix: SilenceFix }[] = [];

      for (const peer of peers) {
        if (!peer.connected) {
          flow.delete(peer.id);
          continue;
        }
        const bytes = peer.audioBytesRecv;
        if (bytes === null) continue; // снимка нет — судить не о чем

        const prev = flow.get(peer.id);
        if (!prev || bytes > prev.bytes) {
          // Звук идёт — счётчик попыток сбрасываем.
          flow.set(peer.id, { bytes, since: now, kicks: 0 });
          continue;
        }
        // Байты не растут дольше порога — фиксируем и не спамим каждые 3 с.
        if (now - prev.since <= SILENCE_MS) continue;

        // В лог кладём currentDirection каждого transceiver'а: если тишина от
        // кривого направления m-line после glare, а не от сети, это видно
        // только там.
        const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
        const dirs = transceivers
          .map((t) => `${t.receiver?.track?.kind ?? '?'}:${t.currentDirection ?? '?'}`)
          .join(', ');
        const secs = Math.round((now - prev.since) / 1000);
        console.warn(
          `[voice] нет входящего звука от «${peer.name}» (${peer.id}) ` +
            `${secs}с; bytesReceived=${bytes}; transceivers=[${dirs}]`,
        );

        // Звук шёл и оборвался — чиним. Порог даёт следующую попытку не раньше
        // чем через SILENCE_MS, так что лестница не срывается в цикл.
        const fixable = prev.bytes > 0 && signalingUp();
        const kicks = fixable ? prev.kicks + 1 : prev.kicks;
        flow.set(peer.id, { bytes, since: now, kicks });
        if (!fixable) continue;

        const fix: SilenceFix = kicks === 1 ? 'restart-ice' : 'rebuild';
        host.diag('mesh silence', `${peer.name} ${secs}s: ${fix}; transceivers=[${dirs}]`);
        fixes.push({ peerId: peer.id, fix });
      }

      return fixes;
    },

    forget(peerId) {
      flow.delete(peerId);
    },

    forgetAll() {
      flow.clear();
    },
  };
}

'use client';

import type { SfxName } from '@/lib/sfx';
import type { TileNet, UplinkStatus, VoicePing } from '@/stores/voice';

/**
 * Шов между дирижёром (`lib/voice.ts`) и транспортом медиа.
 *
 * Дирижёр владеет устройствами, гейтом микрофона, микшером входящего звука,
 * плитками и всем UI-состоянием. Транспорт не знает ни про то, ни про другое —
 * он только доставляет локальные дорожки собеседникам и отдаёт входящие
 * обратно дирижёру через `TransportHost`.
 *
 * Первая реализация — `mesh.ts` (p2p, perfect negotiation). Вторая, `sfu.ts`,
 * появится в шаге D плана (docs/sfu-plan.md) и встанет под тот же интерфейс.
 */

/** Что транспорт может попросить у дирижёра: локальные дорожки + витрина. */
export interface TransportHost {
  // ── Локальное медиа (владеет дирижёр) ──────────────────────────────────
  /** Поток с микрофоном и, если включены, камерой/экраном. */
  localStream(): MediaStream | null;
  /** Дорожка звука демонстрации — идёт отдельным sender'ом, не глушится мутом. */
  screenAudioTrack(): MediaStreamTrack | null;
  /** Что уходит в видео-слот прямо сейчас: экран, камера или ничего. */
  videoTrack(): MediaStreamTrack | null;
  camOn(): boolean;
  screenOn(): boolean;
  /** Тумблер «качество/ФПС» демонстрации — влияет на degradationPreference. */
  screenDegradation(): RTCDegradationPreference;

  // ── Витрина (плитки, статусы, метрики) ─────────────────────────────────
  addTile(id: string, name: string, stream: MediaStream | null, isLocal: boolean): void;
  /** Убрать плитку целиком: узлы звука, фокус, сама плитка. */
  removeTile(id: string): void;
  setTileState(id: string, state: string): void;
  setTileNet(id: string, net: TileNet): void;
  /** Снять узлы микшера, оставив плитку (пересборка соединения с тем же пиром). */
  cleanupPeerAudio(peerId: string): void;
  /** Входящая аудиодорожка → в микшер (громкость, VAD, роль голос/демонстрация). */
  attachRemoteAudio(
    peerId: string,
    track: MediaStreamTrack,
    mid: string | null,
    stream: MediaStream | null,
  ): void;
  setStatus(text: string): void;
  setPing(ping: VoicePing): void;
  setUplink(status: UplinkStatus): void;
  playSfx(name: SfxName): void;
}

/** Транспорт медиа: mesh сегодня, SFU — следующим. */
export interface VoiceTransport {
  /** Подписка на сигналинг. Зовётся один раз на приложение (`initVoice`). */
  init(): void;
  /** Дирижёр вошёл в комнату (сам `join` на сокете шлёт он же). */
  join(room: string): void;
  /** Выход из комнаты: закрыть соединения и очистить своё состояние. */
  leave(): void;

  /** Появилась/сменилась видеодорожка (камера или экран) — раздать собеседникам. */
  publishVideo(): void;
  /** Видео погасло — освободить видео-слот у собеседников. */
  unpublishVideo(): void;
  /** Началась демонстрация: видео экрана + отдельная дорожка его звука. */
  publishScreen(): void;
  /** Демонстрация закончилась. */
  unpublishScreen(): void;
  /** Исходящая дорожка микрофона заменена (смена устройства, подъём гейта). */
  replaceMicTrack(oldTrack: MediaStreamTrack | null, newTrack: MediaStreamTrack): void;
  /** Пере-применить параметры видео (сменился режим демонстрации). */
  retuneVideo(): void;

  /** Тик метрик: пинг в панели, палочки качества, диагностика тишины. */
  pollStats(): void;
  /** Собеседник сменил тег. */
  renamePeer(id: string, name: string): void;
  /** Сокет переподключился с НОВЫМ id — прежние соединения мертвы. */
  reset(): void;
}

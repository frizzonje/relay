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
  /**
   * Входящая аудиодорожка → в микшер (громкость, VAD, роль голос/демонстрация).
   *
   * `slot` — ключ порядка дорожек внутри собеседника: первый по нему считается
   * голосом, остальные звуком демонстрации. Mesh кладёт туда `mid` transceiver'а
   * (роль иначе не узнать), SFU — фиксированный номер по роли producer'а,
   * которую сервер называет прямо.
   */
  attachRemoteAudio(
    peerId: string,
    track: MediaStreamTrack,
    slot: string | null,
    stream: MediaStream | null,
  ): void;
  /**
   * Снять узлы микшера у одной дорожки. Mesh это не нужно: там дорожка умирает
   * вместе с соединением и приходит `ended`. В SFU producer закрывают поштучно
   * (перестали шарить экран — умолк только его звук), а закрытие consumer'а
   * `ended` не порождает — сообщаем явно.
   */
  detachRemoteAudio(peerId: string, track: MediaStreamTrack): void;
  setStatus(text: string): void;
  setPing(ping: VoicePing): void;
  setUplink(status: UplinkStatus): void;
  playSfx(name: SfxName): void;
}

/**
 * Пропуск в медиасервер: короткоживущий токен от api и адрес самого сервера.
 * Есть только у SFU-транспорта — mesh про него ничего не знает.
 */
export interface VoiceTicket {
  url: string;
  token: string;
}

/** Транспорт медиа: mesh и SFU, выбор по режиму канала. */
export interface VoiceTransport {
  /** Подписка на сигналинг. Зовётся один раз на приложение (`initVoice`). */
  init(): void;
  /** Дирижёр вошёл в комнату (сам `join` на сокете шлёт он же). */
  join(room: string, ticket?: VoiceTicket): void;
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
  /**
   * Сменилась плитка «на весь экран». Для SFU это команда пересобрать
   * подписки: крупной плитке верхний слой simulcast, остальным нижний.
   * Mesh шлёт всем одно и то же и метод не реализует.
   */
  focusChanged?(id: string | null): void;
  /** Сокет переподключился с НОВЫМ id — прежние соединения мертвы. */
  reset(): void;
}

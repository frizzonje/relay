import { create } from 'zustand';
import type { VoicePresence } from '@relay/shared';

/**
 * Реактивная «витрина» голосового канала. Вся императивная механика mesh-WebRTC
 * (RTCPeerConnection, MediaStream, sender'ы, perfect negotiation) живёт в
 * `lib/voice.ts`; сюда менеджер выкладывает лишь то, что нужно для отрисовки
 * React-компонентами (плитки, состояние кнопок, состав голосовых каналов,
 * фокус-режим).
 */
export interface VoiceTile {
  /** 'local' для своей плитки, иначе socket-id собеседника. */
  id: string;
  name: string;
  /** Медиапоток (у себя — localStream, у собеседников — e.streams[0]). */
  stream: MediaStream | null;
  /** Подпись статуса: '' | 'соединение…' | 'переподключение…'. */
  state: string;
  isLocal: boolean;
  /** Локальная демонстрация экрана — плитку не зеркалим и показываем целиком. */
  screen: boolean;
  /**
   * Достоверное состояние видео: true — камера/экран активны, false — отключены.
   * Для своей плитки обновляется локально при старте/остановке.
   * Для чужих — приходит через socket `media-update` от собеседника.
   * undefined — состояние пока неизвестно (до первого сигнала).
   */
  videoOn?: boolean;
  /**
   * Громкость голоса (микрофона) собеседника, 0–2 (1 = 100%). Применяется
   * к GainNode в lib/voice.ts. У своей плитки не используется.
   */
  volume?: number;
  /** Громкость звука демонстрации экрана собеседника, 0–2 (1 = 100%). */
  screenVolume?: number;
  /**
   * У собеседника есть живая аудиодорожка демонстрации экрана — показываем
   * иконку громкости трансляции на плитке.
   */
  hasScreenAudio?: boolean;
  /**
   * Качество связи с собеседником (per-peer getStats): grade для «палочек» +
   * сырые метрики для тултипа. undefined — пока не измерено / своя плитка.
   */
  net?: TileNet;
}

/**
 * Качество P2P-связи с собеседником, снятое с getStats (lib/voice.updatePeerQuality).
 * Метрики округлены на стороне менеджера, чтобы плитка не перерисовывалась на
 * каждый микроскачок float.
 */
export interface TileNet {
  /** Класс качества для сигнальных палочек (4/3/2/1 деление). */
  grade: 'strong' | 'good' | 'weak' | 'bad';
  /** Round-trip time, мс (null — пока не измерен). */
  rttMs: number | null;
  /** Потери пакетов за последний интервал, % (null — нет базовой точки). */
  lossPct: number | null;
  /** Джиттер входящего аудио, мс (null — нет данных). */
  jitterMs: number | null;
}

export type ScreenMode = 'quality' | 'fps';

/** Состояние панели «Голос подключён» (обновляется при замере пинга). */
export interface VoicePing {
  /** Идёт установка связи / замер — показываем подпись с многоточием. */
  waiting: boolean;
  /** RTT в мс, когда измерен (иначе null). */
  ms: number | null;
  /** Класс окраски пинга по порогам 80/200 мс. */
  grade: 'good' | 'mid' | 'bad' | null;
  /** Текст-подпись для режима ожидания. */
  label: string;
}

interface VoiceState {
  tiles: VoiceTile[];
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  screenMode: ScreenMode;
  /** Статус подключения для шапки/панели голоса. */
  status: string;
  presence: VoicePresence;
  /** Свой socket-id — чтобы пометить себя «(вы)» в составе каналов. */
  myId: string | null;
  ping: VoicePing;
  /** Плитка, развёрнутая в «театр-режим» (или null). */
  focusedId: string | null;
  /** Id плиток, чей владелец сейчас говорит (для обводки-индикации). */
  speakingIds: string[];
  /** Список доступных микрофонов (audioinput) — наполняется после выдачи доступа. */
  mics: MediaDeviceInfo[];
  /** deviceId активного микрофона (или null, пока не в звонке). */
  currentMicId: string | null;
  /** Человекочитаемое имя активного микрофона (метка устройства). */
  currentMicLabel: string;
  /** Порог срабатывания микрофона, 0–1 (0 = гейт выключен, слышно всегда). */
  micThreshold: number;
  /** Все звуки сайта включены (false = глобальный мут: и пиры, и sfx). */
  speakersOn: boolean;
  /** Список доступных устройств воспроизведения (audiooutput). */
  speakers: MediaDeviceInfo[];
  /** deviceId выбранного устройства вывода (null = системный дефолт). */
  currentSpeakerId: string | null;
  /** Человекочитаемое имя выбранного устройства вывода. */
  currentSpeakerLabel: string;
  /** Список доступных камер (videoinput). */
  cameras: MediaDeviceInfo[];
  /** deviceId выбранной камеры (или null — устройство по умолчанию). */
  currentCamId: string | null;
  /** Человекочитаемое имя выбранной камеры. */
  currentCamLabel: string;
  /** Аппаратное шумоподавление микрофона (getUserMedia constraint). */
  noiseSuppression: boolean;
  /** Режим Push-to-talk: микрофон открыт, только пока удерживается пробел. */
  pushToTalk: boolean;

  setTiles: (tiles: VoiceTile[]) => void;
  setMedia: (m: Partial<Pick<VoiceState, 'micOn' | 'camOn' | 'screenOn' | 'screenMode'>>) => void;
  setStatus: (status: string) => void;
  setPresence: (presence: VoicePresence) => void;
  setMyId: (id: string | null) => void;
  setPing: (ping: VoicePing) => void;
  setFocus: (id: string | null) => void;
  setSpeakingIds: (ids: string[]) => void;
  setMics: (mics: MediaDeviceInfo[]) => void;
  setCurrentMic: (id: string | null, label: string) => void;
  setMicThreshold: (v: number) => void;
  setSpeakersOn: (v: boolean) => void;
  setSpeakers: (speakers: MediaDeviceInfo[]) => void;
  setCurrentSpeaker: (id: string | null, label: string) => void;
  setCameras: (cameras: MediaDeviceInfo[]) => void;
  setCurrentCamera: (id: string | null, label: string) => void;
  setNoiseSuppression: (v: boolean) => void;
  setPushToTalk: (v: boolean) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  tiles: [],
  micOn: true,
  camOn: false,
  screenOn: false,
  screenMode: 'quality',
  status: '',
  presence: {},
  myId: null,
  ping: { waiting: true, ms: null, grade: null, label: '' },
  focusedId: null,
  speakingIds: [],
  mics: [],
  currentMicId: null,
  currentMicLabel: '',
  micThreshold: 0,
  speakersOn: true,
  speakers: [],
  currentSpeakerId: null,
  currentSpeakerLabel: '',
  cameras: [],
  currentCamId: null,
  currentCamLabel: '',
  noiseSuppression: true,
  pushToTalk: false,

  setTiles: (tiles) => set({ tiles }),
  setMedia: (m) => set(m),
  setStatus: (status) => set({ status }),
  setPresence: (presence) => set({ presence }),
  setMyId: (id) => set({ myId: id }),
  setPing: (ping) => set({ ping }),
  setFocus: (id) => set({ focusedId: id }),
  setSpeakingIds: (ids) => set({ speakingIds: ids }),
  setMics: (mics) => set({ mics }),
  setCurrentMic: (id, label) => set({ currentMicId: id, currentMicLabel: label }),
  setMicThreshold: (v) => set({ micThreshold: v }),
  setSpeakersOn: (v) => set({ speakersOn: v }),
  setSpeakers: (speakers) => set({ speakers }),
  setCurrentSpeaker: (id, label) => set({ currentSpeakerId: id, currentSpeakerLabel: label }),
  setCameras: (cameras) => set({ cameras }),
  setCurrentCamera: (id, label) => set({ currentCamId: id, currentCamLabel: label }),
  setNoiseSuppression: (v) => set({ noiseSuppression: v }),
  setPushToTalk: (v) => set({ pushToTalk: v }),
}));

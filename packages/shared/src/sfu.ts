/**
 * Протокол медиасервера: сокет `/sfu/` между клиентом и `apps/sfu`.
 *
 * Отдельный от основного сигналинга разговор — и отдельный файл, но контракт
 * тот же: обе стороны берут формы отсюда, и разойтись им может помешать
 * компилятор, а не внимательность. Клиент прошлой версии обязан звонить
 * клиенту новой, поэтому всё здесь меняется только добавлением.
 *
 * Медиатипы (RTP-возможности, параметры, DTLS, ICE) у сторон разные по
 * происхождению — `mediasoup` на сервере, `mediasoup-client` в браузере, — и
 * контракт тащить ни один из них не должен. Поэтому они — параметр `M`:
 * каждая сторона подставляет свои, а форма разговора остаётся общей.
 */

/** Роль дорожки: по ней клиент решает, куда её деть — в микшер или в плитку. */
export type SfuSource = 'mic' | 'cam' | 'screen' | 'screen-audio';

export const SFU_SOURCES: readonly SfuSource[] = ['mic', 'cam', 'screen', 'screen-audio'];

export type SfuMediaKind = 'audio' | 'video';

/** Медиатипы стороны. По умолчанию — `unknown`: форма без доверия к значениям. */
export interface SfuMedia {
  rtpCapabilities: unknown;
  rtpParameters: unknown;
  dtlsParameters: unknown;
  iceParameters: unknown;
  /** Всё, что нужно клиенту, чтобы завести у себя транспорт. */
  transportParams: unknown;
}

export interface SfuProducerInfo {
  id: string;
  kind: SfuMediaKind;
  source: SfuSource;
}

/** Участник комнаты и дорожки, которые он сейчас отдаёт. */
export interface SfuPeerSnapshot {
  peerId: string;
  name: string;
  producers: SfuProducerInfo[];
}

export interface SfuConsumer<M extends SfuMedia = SfuMedia> {
  id: string;
  producerId: string;
  peerId: string;
  kind: SfuMediaKind;
  rtpParameters: M['rtpParameters'];
  source: SfuSource;
}

/** Слой simulcast, который сервер реально отдаёт по этому consumer'у. */
export interface SfuConsumerLayers {
  consumerId: string;
  spatialLayer: number | null;
  temporalLayer: number | null;
}

/** Ответ на запрос: либо полезная нагрузка, либо причина отказа. */
export type SfuAck<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Запрос без тела. */
type NoBody = Record<string, never>;
/** Ответ без полезной нагрузки — только `ok`. */
type NoReply = object;

/**
 * Запросы клиента: событие → [тело, полезная нагрузка ответа]. Каждый запрос
 * отвечает `SfuAck` от второго элемента.
 */
export interface SfuRequests<M extends SfuMedia = SfuMedia> {
  'create-transport': [
    { direction: 'send' | 'recv' },
    { params: M['transportParams']; direction: 'send' | 'recv' },
  ];
  'connect-transport': [{ transportId: string; dtlsParameters: M['dtlsParameters'] }, NoReply];
  'restart-ice': [{ transportId: string }, { iceParameters: M['iceParameters'] }];
  'close-transport': [{ transportId: string }, NoReply];
  produce: [
    {
      transportId: string;
      kind: SfuMediaKind;
      rtpParameters: M['rtpParameters'];
      source: SfuSource | undefined;
    },
    { id: string },
  ];
  'close-producer': [{ producerId: string }, NoReply];
  snapshot: [NoBody, { peers: SfuPeerSnapshot[] }];
  consume: [
    { transportId: string; producerId: string; rtpCapabilities?: M['rtpCapabilities'] },
    { consumer: SfuConsumer<M> },
  ];
  resume: [{ consumerId: string }, NoReply];
  pause: [{ consumerId: string }, NoReply];
  'close-consumer': [{ consumerId: string }, NoReply];
  'preferred-layers': [
    { consumerId: string; spatialLayer: number; temporalLayer?: number },
    NoReply,
  ];
}

export type SfuRequest = keyof SfuRequests;

/** Что сервер шлёт сам, без запроса. */
export interface SfuEvents<M extends SfuMedia = SfuMedia> {
  welcome: {
    peerId: string;
    routerRtpCapabilities: M['rtpCapabilities'];
    peers: SfuPeerSnapshot[];
  };
  'peer-joined': { peerId: string; name: string };
  'peer-left': { peerId: string };
  'new-producer': { peerId: string; producer: SfuProducerInfo };
  'producer-closed': { peerId: string; producerId: string };
  'consumer-layers': SfuConsumerLayers;
  'sfu-error': { error: string };
}

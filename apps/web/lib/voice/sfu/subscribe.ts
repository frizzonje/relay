'use client';

import type { Consumer, Device, Transport } from 'mediasoup-client/types';
import { tx } from '@/lib/i18n';
import type { TransportHost } from '../types';
import {
  AUDIO_SLOT,
  TOP_SPATIAL_LAYER,
  type Ask,
  type ConsumerPayload,
  type ProducerInfo,
  type Source,
} from './protocol';

/**
 * Чужие дорожки и витрина, которую они собой наполняют.
 *
 * Владеет всем, что относится к собеседникам: подписками, их именами, тем,
 * какое видео сейчас отдано плитке, и каким слоем simulcast сервер отвечает.
 * Наружу отсюда уходит ровно одно — плитка; сюда снаружи не пишет никто.
 */

/** Чужая дорожка, которую мы слушаем: сам consumer плюс чья она и какой роли. */
export interface ConsumerEntry {
  /** Ключ — id producer'а на той стороне: по нему сервер сообщает о закрытии. */
  producerId: string;
  consumer: Consumer;
  peerId: string;
  source: Source;
}

export interface SubscribeDeps {
  host: TransportHost;
  /** Транспорт, по которому едут чужие дорожки (лестница его пересобирает). */
  recvTransport(): Transport | null;
  device(): Device | null;
  ask: Ask;
  /**
   * Стоит ли наша связь с сервером. От этого зависит надпись на плитке — и
   * только от этого: медиа здесь общее, и ждёт плитка не собеседника, а нас.
   */
  linked(): boolean;
}

export interface Subscriber {
  consume(peerId: string, info: ProducerInfo): Promise<void>;
  dropConsumer(producerId: string): void;
  /** Собеседник появился: плитка, имя, надпись. Дорожки приедут следом. */
  addPeer(peerId: string, name: string): void;
  dropPeer(peerId: string): void;
  rename(peerId: string, name: string): void;
  peerIds(): string[];
  nameOf(peerId: string): string | undefined;
  entries(): ConsumerEntry[];
  /** Крупный план сменился — перекладываем слои simulcast. */
  setFocus(id: string | null): void;
  /** Сервер сообщил, какой слой реально отдаёт по этому consumer'у. */
  layerReported(consumerId: string, spatialLayer: number | null): void;
  layerOf(consumerId: string): number | null;
  /** Сказать на всех плитках, что связь чинится (или что починили). */
  sayAll(state: 'reconnecting' | 'settled'): void;
  /** Пересчитать надпись на одной плитке по состоянию нашей связи. */
  sayTileState(peerId: string): void;
  /** Разбор: закрыть подписки и забыть собеседников. Плитки снимает дирижёр. */
  clear(): void;
}

export function createSubscriber({
  host,
  recvTransport,
  device,
  ask,
  linked,
}: SubscribeDeps): Subscriber {
  // Consumer'ы по producerId — так их снимает `producer-closed`.
  const consumers = new Map<string, ConsumerEntry>();
  const names = new Map<string, string>();
  // Какая видеодорожка сейчас отдана плитке собеседника (null — показываем
  // аватарку). По ней `syncTileVideo` решает, есть ли что менять.
  const shownVideo = new Map<string, MediaStreamTrack | null>();
  // Реально доехавший слой simulcast по consumerId — сервер сообщает его сам
  // (`consumer-layers`), это факт, а не наша заявка в `preferred-layers`.
  const gotLayer = new Map<string, number | null>();
  let focusedId: string | null = null;

  function tracksOf(peerId: string, kind: 'audio' | 'video'): MediaStreamTrack[] {
    return [...consumers.values()]
      .filter((e) => e.peerId === peerId && e.consumer.kind === kind)
      .map((e) => e.consumer.track);
  }

  /** Поток для скрытого стока микшера — только звук: видео он не «прокачивает». */
  function audioOf(peerId: string): MediaStream {
    return new MediaStream(tracksOf(peerId, 'audio'));
  }

  /**
   * Отдать плитке видеодорожку собеседника — новым объектом потока и ТОЛЬКО
   * когда она действительно сменилась.
   *
   * Оба условия здесь выстраданы. Новый объект нужен потому, что дорожки в поток
   * кладём мы сами, а скриптовый `MediaStream.addTrack()` события `addtrack` не
   * порождает — по спецификации его шлёт только движок (в mesh поток приезжал из
   * `ontrack`, там движок и слал). Плитка подписана ровно на это событие, так что
   * подмена дорожки в прежнем потоке для неё не происходит вовсе: видео приезжает,
   * декодируется и навсегда остаётся невидимым под аватаркой.
   *
   * А «только когда сменилась» — потому что каждый новый объект это ещё и
   * переприсваивание `srcObject`, которое обрывает висящий `play()` с AbortError.
   * Подписки приходят пачкой (mic, screen, screen-audio при входе в идущий
   * разговор), и пересборка на каждую давала очередь оборванных play() — а плитка
   * считает любой отказ play() запретом автовоспроизведения и показывает «браузер
   * заглушил звук». Звук до плитки всё равно не доходит: он идёт в микшер, а
   * элемент заглушён навсегда, — поэтому здесь ровно одна видеодорожка и ничего
   * больше.
   */
  function syncTileVideo(peerId: string) {
    const track = tracksOf(peerId, 'video')[0] ?? null;
    if ((shownVideo.get(peerId) ?? null) === track) return;
    shownVideo.set(peerId, track);
    host.addTile(
      peerId,
      names.get(peerId) ?? tx('voice.peer.fallback'),
      new MediaStream(track ? [track] : []),
      false,
    );
  }

  /**
   * Веха «пакеты реально пошли». Дорожка consumer'а рождается `muted` и снимает
   * мут первым дошедшим RTP — но полагаться на одно лишь событие нельзя: живьём
   * оно не пришло ни разу, ни при входе, ни в идущем разговоре. Поэтому сначала
   * смотрим само свойство, и только если дорожка ещё молчит — ждём событие.
   */
  function reportRtp(track: MediaStreamTrack, source: Source, peerId: string) {
    const tell = () => host.diag('sfu rtp', `${source} from ${peerId}`);
    if (!track.muted) {
      tell();
      return;
    }
    const onRtp = () => {
      track.removeEventListener('unmute', onRtp);
      tell();
    };
    track.addEventListener('unmute', onRtp);
  }

  // Плитка на весь экран просит верхний слой, остальные — нижний. Без этого
  // simulcast бессмысленен: сервер по умолчанию отдаёт максимум всем.
  function applyLayers(peerId: string, consumer: Consumer) {
    if (consumer.kind !== 'video') return;
    // Демонстрация экрана идёт одним слоем — просить у неё нечего.
    if (consumers.get(consumer.producerId)?.source === 'screen') return;
    const spatialLayer = !focusedId || focusedId === peerId ? TOP_SPATIAL_LAYER : 0;
    void ask('preferred-layers', { consumerId: consumer.id, spatialLayer });
  }

  /**
   * Надпись «соединение…» на плитке собеседника.
   *
   * Ждёт она не его, а нас: медиа здесь одно на всех и идёт через сервер, и как
   * только наши транспорты встали, ждать больше нечего. Раньше надпись снимала
   * первая удавшаяся подписка — и собеседник, который не публикует ничего
   * (не выдали микрофон; слушатель закрытого канала своих дорожек не отдаёт
   * вовсе), оставался в «соединение…» до конца звонка. В mesh этого не бывает:
   * там надпись снимает `connected` самого соединения, а не приехавшая дорожка.
   */
  function sayTileState(peerId: string) {
    host.setTileState(peerId, linked() ? '' : 'tile.state.connecting');
  }

  function dropConsumer(producerId: string) {
    const entry = consumers.get(producerId);
    if (!entry) return;
    consumers.delete(producerId);
    gotLayer.delete(entry.consumer.id);
    entry.consumer.close();
    // Дорожки не стало — плитке нужен новый объект потока, иначе она об этом не
    // узнает (`removetrack` скриптовый `removeTrack()` тоже не порождает) и
    // оставит замёрзший последний кадр законченного показа.
    syncTileVideo(entry.peerId);
    // `close()` дорожку останавливает, но `ended` не шлёт — узел микшера
    // пришлось бы оставить висеть. Снимаем его явно.
    if (entry.consumer.kind === 'audio') {
      host.detachRemoteAudio(entry.peerId, entry.consumer.track);
    }
  }

  return {
    async consume(peerId, info) {
      const transport = recvTransport();
      const dev = device();
      if (!transport || !dev) return;
      const res = await ask<{ consumer: ConsumerPayload }>('consume', {
        transportId: transport.id,
        producerId: info.id,
        rtpCapabilities: dev.rtpCapabilities,
      });
      if (!res) {
        // Отказ в подписке — это «его дорожка есть, но у меня её нет», а на
        // десктоп-оболочке консоли никто не видит. Веху обязан увидеть сервер.
        host.diag('sfu consume denied', `${info.source} ${info.kind}`);
        return;
      }
      const c = res.consumer;
      let consumer: Consumer;
      try {
        consumer = await transport.consume({
          id: c.id,
          producerId: c.producerId,
          kind: c.kind,
          rtpParameters: c.rtpParameters,
        });
      } catch (err) {
        console.error('[sfu] consume failed:', err);
        host.diag('sfu consume failed', `${info.source} ${String((err as Error)?.message ?? err)}`);
        return;
      }
      consumers.set(c.producerId, { producerId: c.producerId, consumer, peerId, source: c.source });
      // Единственное доказательство, что пакеты реально пошли: дорожка consumer'а
      // рождается `muted` и снимает мут первым же дошедшим RTP. Без этой вехи
      // «подписался, но чёрный экран» и «подписался, и ничего не прислали» с
      // сервера выглядят одинаково.
      if (c.kind === 'video') reportRtp(consumer.track, c.source, peerId);

      syncTileVideo(peerId);

      if (c.kind === 'audio') {
        // Звук — в тот же микшер, что и в mesh: громкость по собеседнику, VAD,
        // разделение «голос / звук демонстрации». Само видео на плитке заглушено.
        host.attachRemoteAudio(
          peerId,
          consumer.track,
          AUDIO_SLOT[c.source] ?? '9',
          audioOf(peerId),
        );
      } else {
        applyLayers(peerId, consumer);
      }

      // Протокол требует именно такого порядка: consumer приходит на паузе, трек
      // подключён — только теперь просим пустить пакеты. Не дошло — дорожка так и
      // останется на паузе навсегда, и это неотличимо от «прислали чёрный кадр».
      if (!(await ask('resume', { consumerId: consumer.id }))) {
        host.diag('sfu resume failed', `${c.source} from ${peerId}`);
      }
    },

    dropConsumer,

    addPeer(peerId, name) {
      const shown = name || tx('voice.peer.fallback');
      names.set(peerId, shown);
      host.addTile(peerId, shown, null, false);
      sayTileState(peerId);
    },

    dropPeer(peerId) {
      for (const entry of [...consumers.values()]) {
        if (entry.peerId === peerId) dropConsumer(entry.producerId);
      }
      names.delete(peerId);
      shownVideo.delete(peerId);
      host.removeTile(peerId);
    },

    rename(peerId, name) {
      names.set(peerId, name);
    },

    peerIds: () => [...names.keys()],
    nameOf: (peerId) => names.get(peerId),
    entries: () => [...consumers.values()],

    setFocus(id) {
      focusedId = id;
      for (const entry of consumers.values()) applyLayers(entry.peerId, entry.consumer);
    },

    layerReported(consumerId, spatialLayer) {
      gotLayer.set(consumerId, spatialLayer);
    },
    layerOf: (consumerId) => gotLayer.get(consumerId) ?? null,

    sayAll(state) {
      for (const peerId of names.keys()) {
        host.setTileState(peerId, state === 'reconnecting' ? 'tile.state.reconnecting' : '');
      }
    },

    sayTileState,

    clear() {
      consumers.forEach((e) => e.consumer.close());
      consumers.clear();
      names.clear();
      shownVideo.clear();
      gotLayer.clear();
      focusedId = null;
    },
  };
}

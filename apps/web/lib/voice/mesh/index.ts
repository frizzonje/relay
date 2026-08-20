'use client';

import type { IceServer, SdpPayload } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getIceServers } from '@/lib/config';
import { tx } from '@/lib/i18n';
import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost, VoiceTransport } from '../types';
import { gradeQuality, pingGrade } from '../quality';
import {
  netDelta,
  readStats,
  toHistory,
  worseUplink,
  type NetSnapshot,
  type StatsSnapshot,
} from '../stats';
import { createSenders, tuneSdp } from './senders';
import { createLadder, signalingUp } from './recovery';
import { createSilence } from './silence';

/**
 * Mesh-транспорт: каждый шлёт своё медиа каждому напрямую (perfect negotiation,
 * лестница восстановления ICE-restart → пересборка соединения, палочки качества
 * по getStats).
 *
 * Здесь живёт ВСЁ, что знает про `RTCPeerConnection`. Устройства, гейт микрофона,
 * микшер входящего звука и плитки — не здесь, они у дирижёра (`lib/voice.ts`),
 * доступ к ним только через `TransportHost`.
 *
 * На 2–3 участниках mesh лучше SFU: ниже задержка, ноль нагрузки на сервер,
 * медиа не идёт через чужую машину. Потолок — видео на 4+ (см. docs/plans/old/sfu.md).
 */

// ─────────────────────────────────────────────────────────────────────────
// Состояние пира
// ─────────────────────────────────────────────────────────────────────────

interface Peer {
  pc: RTCPeerConnection;
  name: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  // Сводное состояние связи (см. combinedConnState) — чтобы не дёргать UI на
  // каждое дублирующее событие connection/ice state.
  connState: PeerConnState;
  // Отпечаток DTLS удалённой стороны. Сменился — собеседник пересобрал свой pc,
  // и наш надо выбрасывать, а не «доводить» ренеготиацией: браузер не примет
  // чужой отпечаток на живом транспорте, и связь останется полусобранной.
  fingerprint: string | null;
}

type PeerConnState = 'connecting' | 'connected' | 'disconnected' | 'failed';

// Сводим connectionState и iceConnectionState в одно состояние. connected/
// completed по любому из двух = связь есть; failed/disconnected — по любому.
function combinedConnState(pc: RTCPeerConnection): PeerConnState {
  const c = pc.connectionState;
  const i = pc.iceConnectionState;
  if (c === 'connected' || i === 'connected' || i === 'completed') return 'connected';
  if (c === 'failed' || i === 'failed') return 'failed';
  if (c === 'disconnected' || i === 'disconnected') return 'disconnected';
  return 'connecting';
}

// Отпечаток DTLS из SDP (`a=fingerprint:sha-256 AB:CD:…`). Единственный признак,
// по которому видно, что за тем же собеседником стоит УЖЕ ДРУГОЙ pc: сокет и id
// у него прежние, а соединение он собрал заново.
function fingerprintOf(sdp: string | undefined): string | null {
  const m = /^a=fingerprint:\s*\S+\s+(\S+)/im.exec(sdp ?? '');
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Качество связи на каждой плитке (Discord-подобные «палочки»)
// ─────────────────────────────────────────────────────────────────────────
// Тот же getStats, что кормит панель пинга, но пер-пир: RTT (candidate-pair),
// потери пакетов (дельта packetsLost/Received между тиками) и джиттер аудио.
// Копим предыдущий снимок счётчиков, чтобы считать потери за интервал, а не
// накопленным итогом с начала звонка. Результат кладём в tile.net — рисует
// SignalBars в VideoTile.

// Пороги, проценты и битрейт — в lib/voice/quality.ts: те же цифры считает
// SFU-транспорт, и расходиться им нельзя (палочки должны значить одно и то же).

// ─────────────────────────────────────────────────────────────────────────

export function createMeshTransport(host: TransportHost): VoiceTransport {
  const peers = new Map<string, Peer>();
  const netHistory = new Map<string, NetSnapshot>();

  let room: string | null = null;
  let iceServers: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  let initialized = false;

  const socket = () => getSocket();
  const senders = createSenders(host);
  const ladder = createLadder({
    host,
    peer: (peerId) => {
      const peer = peers.get(peerId);
      if (!peer) return null;
      return {
        name: peer.name,
        polite: peer.polite,
        connected: peer.connState === 'connected',
        pc: peer.pc,
      };
    },
    hasTurn,
    dropConnection,
    createPeer: (peerId, name, relayOnly) => void createPeer(peerId, name, true, relayOnly),
  });
  const silence = createSilence({ host, signalingUp });

  // ── Сигналинг (perfect negotiation) ───────────────────────────────────

  // initiator=true — это МЫ инициируем связь (зашли в комнату, где уже сидят);
  // тогда своё видео/звук экрана отдаём сразу, наш первый offer их и унесёт.
  // initiator=false — мы ОТВЕЧАЕМ на чужой offer (к нам кто-то зашёл/перезашёл);
  // свой экран в этом случае добавляет уже обработчик offer'а ПОСЛЕ ответа —
  // см. комментарий там, иначе перезашедший участник трансляции не увидит.
  function createPeer(
    peerId: string,
    name: string,
    initiator: boolean,
    relayOnly = false,
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: iceServers as RTCIceServer[],
      // relay-only (только TURN) включаем при эскалации после неустранимого провала
      // прямого пути — см. escalateToRelay. Обычно 'all' (host+srflx+relay).
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
      // Заранее собираем пул кандидатов — связь устанавливается заметно быстрее
      iceCandidatePoolSize: 4,
    });
    const peer: Peer = {
      pc,
      name,
      // «Вежливая» сторона уступает при одновременных offer'ах; роль по id
      polite: (socket().id ?? '') < peerId,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      connState: 'connecting',
      fingerprint: null,
    };
    peers.set(peerId, peer);

    const localStream = host.localStream()!;
    const screenAudio = host.screenAudioTrack();
    // Звук экрана отправим отдельным sender'ом ниже — здесь только микрофон
    localStream.getAudioTracks().forEach((track) => {
      if (track === screenAudio) return;
      pc.addTrack(track, localStream);
    });
    // Слушатель (гость закрытого канала) своих дорожек не отдаёт вовсе — а без
    // единой дорожки соединение не собирается: в offer не окажется ни одной
    // m-строки, и negotiationneeded не сработает даже разок. Просим приём
    // явно — двумя recvonly-линиями под голос и картинку. Их же добирает
    // браузер сам, когда собеседник добавляет вторую дорожку (звук показа).
    if (localStream.getTracks().length === 0) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    // Камера или демонстрация уже включены — новый собеседник сразу получает
    // картинку. Только когда инициатор МЫ: наш offer унесёт её без доп. круга.
    // Если же мы отвечаем на чужой offer, добавление видео здесь потребовало бы
    // встречного offer'а, а он после answer срабатывает не на всех браузерах —
    // отдаём своё видео отвечающей стороной уже после ответа (обработчик 'offer').
    if (initiator) {
      if (host.screenOn()) senders.sendScreenTo(peerId, pc);
      else if (host.camOn()) senders.sendVideoTo(peerId, pc);
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        // Пока ждали createOffer, мог прийти встречный offer (glare) и сменить
        // состояние. Тогда свой локальный offer уже не нужен: ответим в обработчике
        // 'offer', и наш answer заодно унесёт собеседнику свежие дорожки. Без этой
        // проверки setLocalDescription упал бы и оставил связь полусобранной.
        if (pc.signalingState !== 'stable') return;
        offer.sdp = tuneSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        socket().emit('offer', { to: peerId, sdp: pc.localDescription as SdpPayload });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate)
        socket().emit('ice-candidate', { to: peerId, candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
      host.addTile(peerId, name, e.streams[0], false);
      // Звук пускаем через микшер (раздельная громкость голоса/демонстрации),
      // видео остаётся на <video>; чужой элемент заглушён, чтобы не дублировать звук.
      // Роль дорожки определяем по mid её transceiver'а — см. attachRemoteAudio.
      if (e.track.kind === 'audio')
        host.attachRemoteAudio(peerId, e.track, e.transceiver?.mid ?? null, e.streams[0] ?? null);
    };

    // Состояние соединения определяем по двум сигналам сразу: connectionState
    // и iceConnectionState. На части браузеров (iOS Safari, мобильные) первый
    // приходит ненадёжно — медиа уже течёт, а connectionState висит в 'connecting',
    // из-за чего плитка вечно показывает «соединение…». ICE-состояние закрывает
    // этот пробел: connected/completed по любому из них = связь есть.
    const handleStateChange = () => {
      const state = combinedConnState(pc);
      if (peer.connState === state) return;
      peer.connState = state;
      switch (state) {
        case 'connected':
          // Связь есть — лестницу восстановления сбрасываем целиком.
          ladder.markUp(peerId);
          host.setTileState(peerId, '');
          // bitrate-cap/тюнинг применяем только после ICE — иначе setParameters кидает
          senders.tuneVideo(peerId, host.screenOn());
          void senders.tuneAudio(peerId, pc);
          break;
        case 'disconnected':
          // Может само подняться (кратковременная смена сети) — даём паузу, затем
          // запускаем лестницу. Если лестница уже идёт (ступень 1+), её сторож
          // главнее: он считает окно текущей ступени, а не грейс.
          host.setTileState(peerId, 'tile.state.reconnecting');
          ladder.armGrace(peerId);
          break;
        case 'failed':
          host.setTileState(peerId, 'tile.state.reconnecting');
          ladder.recover(peerId);
          break;
        // 'connecting' — промежуточное состояние, в том числе сразу после
        // restartIce. Сторож ступени здесь НЕ трогаем: раньше он на этом переходе
        // гасился, и связь, не дошедшая до connected, застревала в
        // «переподключении…» навсегда — до перезахода в канал.
      }
    };
    pc.onconnectionstatechange = handleStateChange;
    pc.oniceconnectionstatechange = handleStateChange;

    // Плитка появляется сразу, со статусом — а не в момент прихода медиа
    host.addTile(peerId, name, null, false);
    host.setTileState(peerId, 'tile.state.connecting');
    // Сторож и на ПЕРВОЕ соединение: offer мог не доехать, ICE — не собраться, а
    // сам по себе такой pc из 'connecting' не выйдет никогда. Окно шире обычного —
    // холодный старт с TURN бывает небыстрым.
    ladder.armFirst(peerId);
    return pc;
  }

  // Закрыть соединение с пиром, оставив плитку: связь мы пересобираем с тем же
  // собеседником, и с точки зрения витрины он никуда не уходил.
  function dropConnection(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    ladder.disarm(peerId);
    peer.pc.close();
    peers.delete(peerId);
    senders.forget(peerId);
    silence.forget(peerId);
    netHistory.delete(peerId);
    host.cleanupPeerAudio(peerId);
  }

  function removePeer(peerId: string) {
    if (!peers.has(peerId)) return;
    dropConnection(peerId);
    ladder.forget(peerId);
    host.removeTile(peerId);
  }

  // Есть ли в конфиге TURN-сервер (turn:/turns:). От этого зависит, имеет ли смысл
  // эскалация на relay-only при неустранимом провале прямого пути.
  function hasTurn(): boolean {
    return iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => typeof u === 'string' && /^turns?:/i.test(u));
    });
  }

  async function drainCandidates(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    const queued = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('addIceCandidate failed:', err);
      }
    }
  }

  // ── Метрики ───────────────────────────────────────────────────────────

  /**
   * Один снимок с каждого соединения за тик — и три читателя на него.
   *
   * Раньше пинг, палочки и сторож тишины ходили в `getStats` каждый сам, то
   * есть на пятерых с видео выходило пятнадцать полных снимков статистики
   * каждые три секунды. Дело даже не в работе: это были три РАЗНЫХ момента
   * времени, и сторож видел байты, которых палочки в том же тике уже не
   * видели. Свести такие показания в одну картину нельзя в принципе.
   */
  async function collectStats(): Promise<Map<string, StatsSnapshot>> {
    const snaps = new Map<string, StatsSnapshot>();
    for (const [id, peer] of peers) {
      // Сводное состояние, а не сырой connectionState: на Safari/iOS последний
      // ненадёжен (висит в 'connecting' при живом медиа).
      if (peer.connState !== 'connected') continue;
      try {
        snaps.set(id, readStats(await peer.pc.getStats()));
      } catch {
        /* getStats может кинуть на закрывающемся pc — пропускаем пира */
      }
    }
    return snaps;
  }

  function updateVoicePing(snaps: Map<string, StatsSnapshot>) {
    if (!room) return;

    if (peers.size === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'ping.alone' });
      return;
    }

    let rttMs: number | null = null;
    for (const snap of snaps.values()) {
      if (snap.rttMs !== null && (rttMs === null || snap.rttMs < rttMs)) rttMs = snap.rttMs;
    }
    // «Устанавливаем связь» и «меряем» — разные вещи: связь есть, а цифры ещё
    // не приехали. Отвечает на это состояние соединения, а не наличие снимка.
    const anyConnected = [...peers.values()].some((p) => p.connState === 'connected');

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

  function updatePeerQuality(snaps: Map<string, StatsSnapshot>) {
    if (!room) return;
    // Худшее «узкое место» аплинка по всем пирам (bandwidth важнее cpu). Считаем
    // за один проход и раскладываем в стор после цикла — это СВОЙ показатель, общий.
    let worstUplink: UplinkStatus = 'ok';

    for (const [id, peer] of peers) {
      // Связь переустанавливается — палочки гаснут (bad), метрики неизвестны.
      if (peer.connState !== 'connected') {
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

  // Сторож односторонней тишины: считает он (mesh/silence.ts), а чинит лестница.
  function fixSilence(snaps: Map<string, StatsSnapshot>) {
    const probes = [...peers].map(([id, peer]) => ({
      id,
      name: peer.name,
      pc: peer.pc,
      connected: peer.connState === 'connected',
      audioBytesRecv: snaps.get(id)?.audioBytesRecv ?? null,
    }));
    for (const { peerId, fix } of silence.check(probes)) {
      const peer = peers.get(peerId);
      if (!peer) continue;
      host.setTileState(peerId, 'tile.state.reconnecting');
      if (fix === 'restart-ice') peer.pc.restartIce();
      else ladder.rebuild(peerId);
    }
  }

  // ── Реализация интерфейса ─────────────────────────────────────────────

  return {
    init() {
      if (initialized) return;
      initialized = true;

      // ICE-серверы с бэка (там может быть TURN); пока летит запрос — дефолтный STUN
      getIceServers()
        .then((servers) => {
          if (servers.length) iceServers = servers;
        })
        .catch(() => {});

      const s = socket();

      // Новичок получает список старожилов; addTrack в createPeer запустит offer
      s.on('peers', (list) => {
        if (!room || !host.localStream()) return;
        for (const { id, name } of list) {
          if (!peers.has(id)) createPeer(id, name || tx('voice.peer.fallback'), true); // инициатор — мы
        }
      });

      s.on('offer', async ({ from, name, sdp }) => {
        if (!room || !host.localStream()) return;
        let peer = peers.get(from);
        const remoteFp = fingerprintOf((sdp as RTCSessionDescriptionInit | undefined)?.sdp);
        // Отпечаток DTLS сменился — за тем же id стоит уже ДРУГОЙ pc: собеседник
        // пересобрал связь (его лестница дошла до ступени 2). Ренеготиацией такой
        // offer не принять — браузер не пустит чужой отпечаток на живой транспорт,
        // и раньше это давало ровно «оба в канале, оба молчат». Пересобираем и мы.
        const rebuilt = !!(peer && peer.fingerprint && remoteFp && remoteFp !== peer.fingerprint);
        // Труп прошлого соединения: setRemoteDescription на мёртвом/закрытом pc
        // связь не поднимет — выкидываем и принимаем offer на свежий pc.
        const dead =
          !!peer && (peer.pc.connectionState === 'failed' || peer.pc.signalingState === 'closed');
        if (peer && (dead || rebuilt)) {
          host.diag(
            'mesh peer rebuilt',
            `${peer.name}: ${rebuilt ? 'new dtls fingerprint' : peer.pc.connectionState}`,
          );
          dropConnection(from);
          host.setTileState(from, 'tile.state.reconnecting');
          peer = undefined;
        }
        const fresh = !peer;
        if (!peer) {
          createPeer(from, name || tx('voice.peer.fallback'), false); // мы — отвечающая сторона
          peer = peers.get(from)!;
        }
        const pc = peer.pc;

        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        try {
          await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
          if (remoteFp) peer.fingerprint = remoteFp;
          await drainCandidates(from);
          const answer = await pc.createAnswer();
          answer.sdp = tuneSdp(answer.sdp);
          await pc.setLocalDescription(answer);
          s.emit('answer', { to: from, sdp: pc.localDescription as SdpPayload });

          // Только теперь, ответив свежему пиру, отдаём ему СВОЮ камеру/демонстрацию.
          // Связь уже стабильна — addTrack здесь запускает обычную ренеготиацию (тот
          // же путь, что при старте показа в живом звонке), а не хрупкий «доп. offer
          // поверх answer», который после переподключения участник нередко не получал.
          if (fresh && (host.screenOn() || host.camOn())) {
            if (host.screenOn()) senders.sendScreenTo(from, pc);
            else senders.sendVideoTo(from, pc);
          }
        } catch (err) {
          console.error('offer handling failed:', err);
        }
      });

      s.on('answer', async ({ from, sdp }) => {
        const peer = peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        try {
          await peer.pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
          // Запоминаем отпечаток и с answer'а: когда инициаторы мы, offer'ов от
          // собеседника может не быть вовсе — а сравнивать при его пересборке надо.
          const fp = fingerprintOf((sdp as RTCSessionDescriptionInit | undefined)?.sdp);
          if (fp) peer.fingerprint = fp;
          await drainCandidates(from);
        } catch (err) {
          console.error('answer handling failed:', err);
        }
      });

      s.on('ice-candidate', async ({ from, candidate }) => {
        const peer = peers.get(from);
        if (!peer) return;
        try {
          if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(candidate);
          } else {
            peer.pendingCandidates.push(candidate);
          }
        } catch (err) {
          if (!peer.ignoreOffer) console.error('addIceCandidate failed:', err);
        }
      });

      s.on('peer-left', ({ id }) => {
        const peer = peers.get(id);
        host.setStatus('voice.status.peerLeft', { name: peer?.name || tx('voice.peer.fallback') });
        removePeer(id);
        host.playSfx('peerLeave'); // звук отключения участника
      });
    },

    join(newRoom) {
      room = newRoom;
    },

    leave() {
      if (!room) return; // нас тут и не было — выходить нечего
      peers.forEach((peer) => peer.pc.close());
      peers.clear();
      ladder.forgetAll();
      senders.forgetAll();
      silence.forgetAll();
      netHistory.clear();
      room = null;
      host.setUplink('ok'); // пиров нет — своё «узкое место» сбрасываем
    },

    publishVideo() {
      peers.forEach((peer, id) => senders.sendVideoTo(id, peer.pc));
    },

    unpublishVideo() {
      peers.forEach((_peer, id) => senders.stopVideo(id));
    },

    publishScreen() {
      peers.forEach((peer, id) => senders.sendScreenTo(id, peer.pc));
    },

    unpublishScreen() {
      peers.forEach((_peer, id) => senders.stopScreen(id));
    },

    replaceMicTrack(oldTrack, newTrack) {
      peers.forEach((peer) => {
        peer.pc.getSenders().forEach((sn) => {
          if (sn.track && sn.track === oldTrack) sn.replaceTrack(newTrack).catch(() => {});
        });
      });
    },

    retuneVideo() {
      peers.forEach((_peer, id) => senders.tuneVideo(id, true));
    },

    pollStats() {
      void (async () => {
        const snaps = await collectStats();
        updateVoicePing(snaps);
        // Палочки — до сторожа: сторож чинит связь, и после его ступени снимок
        // этого тика описывал бы соединение, которого уже нет.
        updatePeerQuality(snaps);
        fixSilence(snaps);
      })();
    },

    renamePeer(id, name) {
      const peer = peers.get(id);
      if (peer) peer.name = name;
    },

    reset() {
      // Снимаем снимок ключей: removePeer мутирует Map по ходу.
      [...peers.keys()].forEach((id) => removePeer(id));
    },

    // Сокет вернулся с ТЕМ ЖЕ id (socket.io восстановил сессию). Пиров не трогаем —
    // те, у кого медиа пережило обрыв, продолжают говорить, — но лестница всё это
    // время стояла на паузе (без сигналинга ступени не доезжают), а связь за эти
    // секунды могла и развалиться. Догоняем: всем, кто не на связи, — с первой ступени.
    resync() {
      if (!room) return;
      for (const [id, peer] of peers) {
        if (peer.connState === 'connected') continue;
        host.diag('mesh resync', `${peer.name}: ${peer.connState}`);
        ladder.rewind(id);
        host.setTileState(id, 'tile.state.reconnecting');
        ladder.recover(id);
      }
    },
  };
}

'use client';

import { toast } from 'sonner';
import type { IceServer, SdpPayload } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getIceServers } from '@/lib/config';
import { boostVideoBitrate, boostAudioBitrate } from '@/lib/sdp';
import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost, VoiceTransport } from './types';
import { gradeQuality, kbps, limitReason, pingGrade, type NetSnapshot } from './quality';

/**
 * Mesh-транспорт: каждый шлёт своё медиа каждому напрямую (perfect negotiation,
 * лестница восстановления ICE-restart → relay-only, палочки качества по getStats).
 *
 * Здесь живёт ВСЁ, что знает про `RTCPeerConnection`. Устройства, гейт микрофона,
 * микшер входящего звука и плитки — не здесь, они у дирижёра (`lib/voice.ts`),
 * доступ к ним только через `TransportHost`.
 *
 * На 2–3 участниках mesh лучше SFU: ниже задержка, ноль нагрузки на сервер,
 * медиа не идёт через чужую машину. Потолок — видео на 4+ (см. docs/sfu-plan.md).
 */

// ─────────────────────────────────────────────────────────────────────────
// Потолки битрейта (SDP задаёт предел кодеку, setParameters — sender'у)
// ─────────────────────────────────────────────────────────────────────────

const VIDEO_MAX_BITRATE = 2_500_000;
const SCREEN_MAX_BITRATE = 8_000_000;

// Потолки битрейта аудио-кодировщика по ролям. Голос держим на «discord-уровне»,
// а звук демонстрации (музыка/фильм) пускаем заметно жирнее — там слышно разницу.
const MIC_AUDIO_MAX_BITRATE = 128_000;
const SCREEN_AUDIO_MAX_BITRATE = 256_000;

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
  failTimer: ReturnType<typeof setTimeout> | null;
  videoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  // Сводное состояние связи (см. combinedConnState) — чтобы не дёргать UI на
  // каждое дублирующее событие connection/ice state.
  connState: PeerConnState;
  // Собрано ли соединение с политикой relay-only (только TURN) — тогда дальше
  // эскалировать некуда. См. recoverPeer/escalateToRelay.
  relayOnly: boolean;
  // Стадия лестницы восстановления: 0 — ничего, 1 — сделан ICE-restart, 2 —
  // пересобрано relay-only. Сбрасывается в 0 при выходе на связь.
  recoverStage: number;
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
  const audioFlow = new Map<string, { bytes: number; since: number }>();

  let room: string | null = null;
  let iceServers: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  let initialized = false;

  const socket = () => getSocket();

  // ── SDP и параметры sender'ов ─────────────────────────────────────────
  // boostVideoBitrate/boostAudioBitrate вынесены в lib/sdp.ts (чистый модуль).
  // Тюним и видео (x-google-bitrate), и голос (Opus: стерео/битрейт/FEC) —
  // иначе звонок звучит глухо на дефолтном ~32 кбит/с моно.

  function tuneSdp(sdp: string | undefined): string | undefined {
    return boostAudioBitrate(boostVideoBitrate(sdp));
  }

  // Поднимаем потолок битрейта у одного аудио-sender'а. SDP задаёт
  // maxaveragebitrate кодеку, а это — фактический максимум кодировщика.
  async function setAudioSenderBitrate(sender: RTCRtpSender, max: number) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings.forEach((e) => {
        e.maxBitrate = max;
        // Голос/звук демонстрации важнее картинки: под нагрузкой WebRTC душит
        // потоки по приоритету. Без этого голос рвётся наравне с видео, когда
        // кто-то параллельно льёт экран на 8 Мбит/с. high = и DSCP-метка, и
        // распределение полосы в пользу аудио.
        e.priority = 'high';
        e.networkPriority = 'high';
      });
      await sender.setParameters(params);
    } catch (err) {
      console.warn('audio setParameters failed:', err);
    }
  }

  // Тюним все аудио-sender'ы пира: звук демонстрации — под высокий потолок
  // (музыка/фильм), микрофон и прочее — под голосовой.
  async function tuneAudioSenders(peer: Peer) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue;
      const max =
        sender === peer.screenAudioSender ? SCREEN_AUDIO_MAX_BITRATE : MIC_AUDIO_MAX_BITRATE;
      await setAudioSenderBitrate(sender, max);
    }
  }

  async function tuneVideoSender(sender: RTCRtpSender, isScreen = false) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = isScreen ? SCREEN_MAX_BITRATE : VIDEO_MAX_BITRATE;
      // Экран — по выбору пользователя (тумблер Качество/ФПС); камера — сбалансированно
      params.degradationPreference = isScreen ? host.screenDegradation() : 'balanced';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('setParameters failed:', err);
    }
  }

  // ── Публикация локальных дорожек ──────────────────────────────────────

  // Отдаём собеседнику текущую видеодорожку (камеру ИЛИ экран) через общий video-sender
  function sendVideoTo(peer: Peer) {
    const track = host.videoTrack();
    if (!track) return;
    if (peer.videoSender) {
      peer.videoSender.replaceTrack(track).catch(() => {});
    } else {
      peer.videoSender = peer.pc.addTrack(track, host.localStream()!);
    }
    void tuneVideoSender(peer.videoSender, host.screenOn());
  }

  // Демонстрация = видео экрана (общий слот) + отдельная аудиодорожка со звуком экрана
  function sendScreenTo(peer: Peer) {
    sendVideoTo(peer);
    const audio = host.screenAudioTrack();
    if (!audio) return;
    if (peer.screenAudioSender) {
      peer.screenAudioSender.replaceTrack(audio).catch(() => {});
    } else {
      peer.screenAudioSender = peer.pc.addTrack(audio, host.localStream()!);
    }
    // Звуку демонстрации — высокий потолок сразу (показ мог стартовать уже после
    // того, как связь установилась, и общий tuneAudioSenders по нему не прошёлся).
    void setAudioSenderBitrate(peer.screenAudioSender, SCREEN_AUDIO_MAX_BITRATE);
  }

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
      failTimer: null,
      videoSender: null,
      screenAudioSender: null,
      connState: 'connecting',
      relayOnly,
      recoverStage: 0,
    };
    peers.set(peerId, peer);

    const localStream = host.localStream()!;
    const screenAudio = host.screenAudioTrack();
    // Звук экрана отправим отдельным sender'ом ниже — здесь только микрофон
    localStream.getAudioTracks().forEach((track) => {
      if (track === screenAudio) return;
      pc.addTrack(track, localStream);
    });
    // Камера или демонстрация уже включены — новый собеседник сразу получает
    // картинку. Только когда инициатор МЫ: наш offer унесёт её без доп. круга.
    // Если же мы отвечаем на чужой offer, добавление видео здесь потребовало бы
    // встречного offer'а, а он после answer срабатывает не на всех браузерах —
    // отдаём своё видео отвечающей стороной уже после ответа (обработчик 'offer').
    if (initiator) {
      if (host.screenOn()) sendScreenTo(peer);
      else if (host.camOn()) sendVideoTo(peer);
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
      if (peer.failTimer) {
        clearTimeout(peer.failTimer);
        peer.failTimer = null;
      }
      switch (state) {
        case 'connected':
          peer.recoverStage = 0; // связь есть — лестницу восстановления сбрасываем
          host.setTileState(peerId, '');
          // bitrate-cap/тюнинг применяем только после ICE — иначе setParameters кидает
          if (peer.videoSender) void tuneVideoSender(peer.videoSender, host.screenOn());
          void tuneAudioSenders(peer);
          break;
        case 'disconnected':
          // Может само подняться (кратковременная смена сети) — даём паузу, затем
          // запускаем лестницу восстановления.
          host.setTileState(peerId, 'переподключение…');
          peer.failTimer = setTimeout(() => recoverPeer(peerId), 8000);
          break;
        case 'failed':
          host.setTileState(peerId, 'переподключение…');
          recoverPeer(peerId);
          break;
      }
    };
    pc.onconnectionstatechange = handleStateChange;
    pc.oniceconnectionstatechange = handleStateChange;

    // Плитка появляется сразу, со статусом — а не в момент прихода медиа
    host.addTile(peerId, name, null, false);
    host.setTileState(peerId, 'соединение…');
    return pc;
  }

  function removePeer(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    if (peer.failTimer) clearTimeout(peer.failTimer);
    peer.pc.close();
    peers.delete(peerId);
    netHistory.delete(peerId);
    audioFlow.delete(peerId);
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

  // Лестница восстановления связи с пиром:
  //   стадия 0 → ICE-restart (дёшево; частая причина обрыва — сменился сетевой путь);
  //   стадия 1 → пересборка соединения ТОЛЬКО через TURN (relay-only), если TURN
  //              есть и мы ещё не relay-only: спасает симметричный NAT/DPI, где
  //              host/srflx-кандидаты мертвы, а прямой путь не собирается;
  //   иначе   → сдаёмся и снимаем пира.
  // Дёргается из handleStateChange (failed/disconnected) и из собственных сторожей.
  function recoverPeer(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    if (peer.failTimer) {
      clearTimeout(peer.failTimer);
      peer.failTimer = null;
    }
    // Уже снова на связи (гонка таймеров) — ничего не делаем.
    if (peer.connState === 'connected') return;

    if (peer.recoverStage === 0) {
      peer.recoverStage = 1;
      peer.pc.restartIce();
      // Сторож: если ICE-restart не поднял связь за окно — идём на следующую стадию.
      peer.failTimer = setTimeout(() => recoverPeer(peerId), 8000);
      return;
    }

    if (peer.recoverStage === 1 && !peer.relayOnly && hasTurn()) {
      peer.recoverStage = 2;
      escalateToRelay(peerId);
      return;
    }

    // Дальше идти некуда — прямого пути сеть не даёт, а TURN либо уже пробован,
    // либо не настроен.
    toast.error(
      'Не удалось соединиться с «' +
        peer.name +
        '»: сеть блокирует подключение. Администратору стоит проверить TURN-сервер.',
    );
    host.playSfx('error'); // соединиться не вышло
    removePeer(peerId);
  }

  // Пересобираем соединение с пиром, разрешив ТОЛЬКО TURN-кандидатов. Закрываем
  // мёртвый pc и поднимаем новый как инициатор: наш relay-only offer унесёт дорожки,
  // удалённая сторона примет его штатно (perfect negotiation + guard на мёртвый pc
  // в обработчике 'offer'). Плитку сохраняем — обновляем только статус.
  function escalateToRelay(peerId: string) {
    const old = peers.get(peerId);
    if (!old) return;
    const name = old.name;
    if (old.failTimer) clearTimeout(old.failTimer);
    old.pc.close();
    host.cleanupPeerAudio(peerId);
    peers.delete(peerId);
    // Стадия 2 лестницы: отдельная подпись — прямой путь не собрался, идём через
    // TURN. Отличаем от обычного «переподключение…» (стадия 1, ICE-restart).
    host.setTileState(peerId, 'резервный канал…');
    createPeer(peerId, name, true, true); // инициатор, relay-only
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

  async function updateVoicePing() {
    if (!room) return;

    if (peers.size === 0) {
      host.setPing({ waiting: true, ms: null, grade: null, label: 'один в канале' });
      return;
    }

    let rttMs: number | null = null;
    let anyConnected = false;
    for (const [, peer] of peers) {
      // Сводное состояние, а не сырой connectionState: на Safari/iOS последний
      // ненадёжен (висит в 'connecting' при живом медиа), и панель пинга иначе
      // вечно показывала бы «устанавливаем связь» при работающем звонке.
      if (peer.connState !== 'connected') continue;
      anyConnected = true;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            report.state === 'succeeded' &&
            report.currentRoundTripTime != null
          ) {
            const ms = Math.round(report.currentRoundTripTime * 1000);
            if (rttMs === null || ms < rttMs) rttMs = ms;
          }
        });
      } catch {
        /* getStats может кинуть на закрывающемся pc — игнорируем */
      }
    }

    if (rttMs === null) {
      host.setPing({
        waiting: true,
        ms: null,
        grade: null,
        label: anyConnected ? 'замеряем задержку' : 'устанавливаем связь',
      });
      return;
    }

    host.setPing({ waiting: false, ms: rttMs, grade: pingGrade(rttMs), label: '' });
  }

  async function updatePeerQuality() {
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

      let rtt: number | null = null;
      let lost = 0;
      let recv = 0;
      let jitterMs: number | null = null;
      let bytesSent = 0;
      let bytesRecv = 0;
      let width: number | null = null;
      let height: number | null = null;
      let fps: number | null = null;
      let videoCodecId: string | undefined;
      // Кандидат-пары: id выбранной (наименьший RTT) — по нему потом читаем тип пути.
      let bestPairLocalId: string | undefined;
      let bestPairRemoteId: string | undefined;
      let stats: RTCStatsReport;
      try {
        stats = await peer.pc.getStats();
      } catch {
        /* getStats может кинуть на закрывающемся pc — пропускаем пира */
        continue;
      }
      stats.forEach((r) => {
        if (
          r.type === 'candidate-pair' &&
          r.state === 'succeeded' &&
          r.currentRoundTripTime != null
        ) {
          const ms = Math.round(r.currentRoundTripTime * 1000);
          if (rtt === null || ms < rtt) {
            rtt = ms;
            bestPairLocalId = (r as { localCandidateId?: string }).localCandidateId;
            bestPairRemoteId = (r as { remoteCandidateId?: string }).remoteCandidateId;
          }
        }
        const kind = (r as { kind?: string; mediaType?: string }).kind ?? r.mediaType;
        if (r.type === 'inbound-rtp' && (kind === 'audio' || kind === 'video')) {
          lost += (r as { packetsLost?: number }).packetsLost ?? 0;
          recv += (r as { packetsReceived?: number }).packetsReceived ?? 0;
          bytesRecv += (r as { bytesReceived?: number }).bytesReceived ?? 0;
          const j = (r as { jitter?: number }).jitter;
          if (kind === 'audio' && j != null) jitterMs = Math.round(j * 1000);
          if (kind === 'video') {
            const rv = r as {
              frameWidth?: number;
              frameHeight?: number;
              framesPerSecond?: number;
              codecId?: string;
            };
            if (rv.frameWidth && rv.frameHeight) {
              width = rv.frameWidth;
              height = rv.frameHeight;
            }
            if (rv.framesPerSecond != null) fps = Math.round(rv.framesPerSecond);
            if (rv.codecId) videoCodecId = rv.codecId;
          }
        }
        if (r.type === 'outbound-rtp' && (kind === 'audio' || kind === 'video')) {
          bytesSent += (r as { bytesSent?: number }).bytesSent ?? 0;
          if (kind === 'video') {
            const reason = limitReason(
              (r as { qualityLimitationReason?: string }).qualityLimitationReason,
            );
            if (reason === 'bandwidth') worstUplink = 'bandwidth';
            else if (reason === 'cpu' && worstUplink === 'ok') worstUplink = 'cpu';
          }
        }
      });

      // Тип пути: реле, если локальный ИЛИ удалённый кандидат выбранной пары — relay.
      let relay: boolean | null = null;
      const localCand = bestPairLocalId ? stats.get(bestPairLocalId) : undefined;
      const remoteCand = bestPairRemoteId ? stats.get(bestPairRemoteId) : undefined;
      if (localCand || remoteCand) {
        const lt = (localCand as { candidateType?: string } | undefined)?.candidateType;
        const rt = (remoteCand as { candidateType?: string } | undefined)?.candidateType;
        relay = lt === 'relay' || rt === 'relay';
      }

      // Кодек входящего видео из codecId → mimeType «video/VP8» → «VP8».
      let codec: string | null = null;
      if (videoCodecId) {
        const mime = (stats.get(videoCodecId) as { mimeType?: string } | undefined)?.mimeType;
        if (mime) codec = mime.split('/')[1]?.toUpperCase() ?? null;
      }

      // Потери и битрейт за интервал: дельта относительно прошлого снимка.
      // Первый тик базы ещё не имеет — потери 0, битрейт неизвестен.
      const prev = netHistory.get(id);
      const now = Date.now();
      netHistory.set(id, { lost, recv, bytesSent, bytesRecv, ts: now });
      let lossPct: number | null = null;
      let sendKbps: number | null = null;
      let recvKbps: number | null = null;
      if (prev) {
        const dLost = Math.max(0, lost - prev.lost);
        const dRecv = Math.max(0, recv - prev.recv);
        const total = dLost + dRecv;
        lossPct = total > 0 ? Math.round((dLost / total) * 1000) / 10 : 0;
        const dt = now - prev.ts;
        sendKbps = kbps(bytesSent, prev.bytesSent, dt);
        recvKbps = kbps(bytesRecv, prev.bytesRecv, dt);
      }

      host.setTileNet(id, {
        grade: gradeQuality(rtt, lossPct ?? 0),
        rttMs: rtt,
        lossPct,
        jitterMs,
        relay,
        sendKbps,
        recvKbps,
        videoRes: width && height ? `${width}×${height}` : null,
        fps,
        codec,
      });
    }

    host.setUplink(worstUplink);
  }

  // Диагностика «односторонней тишины». Если связь с пиром установлена, а
  // входящий звук не идёт дольше ~6 с, причина почти всегда одна из двух:
  //   • байт нет вовсе → беда с направлением SDP (recvonly/неактивный m-line)
  //     после glare — это сторона negotiation;
  //   • байты идут, но не слышно → WebAudio/AudioContext (autoplay) — сторона
  //     воспроизведения.
  // Пишем в консоль с currentDirection каждого transceiver'а, чтобы ловить
  // причину на живом сбое, а не гадать. Только лог — не дёргаем UI.
  async function monitorAudioFlow() {
    const now = Date.now();
    for (const [id, peer] of peers) {
      if (peer.connState !== 'connected') {
        audioFlow.delete(id);
        continue;
      }
      let bytes = 0;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((r) => {
          const kind = (r as { kind?: string; mediaType?: string }).kind ?? r.mediaType;
          if (r.type === 'inbound-rtp' && kind === 'audio') bytes += r.bytesReceived ?? 0;
        });
      } catch {
        continue;
      }
      const prev = audioFlow.get(id);
      if (!prev || bytes > prev.bytes) {
        audioFlow.set(id, { bytes, since: now });
        continue;
      }
      // Байты не растут дольше порога — фиксируем и не спамим каждые 3 с
      if (now - prev.since > 6000) {
        const tx = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
        const dirs = tx
          .map((t) => `${t.receiver?.track?.kind ?? '?'}:${t.currentDirection ?? '?'}`)
          .join(', ');
        console.warn(
          `[voice] нет входящего звука от «${peer.name}» (${id}) ` +
            `${Math.round((now - prev.since) / 1000)}с; bytesReceived=${bytes}; transceivers=[${dirs}]`,
        );
        audioFlow.set(id, { bytes, since: now });
      }
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
          if (!peers.has(id)) createPeer(id, name || 'Участник', true); // инициатор — мы
        }
      });

      s.on('offer', async ({ from, name, sdp }) => {
        if (!room || !host.localStream()) return;
        let peer = peers.get(from);
        // Труп прошлого соединения: собеседник пересобирает связь (напр. эскалация на
        // relay-only после провала прямого пути). setRemoteDescription на мёртвом/
        // закрытом pc связь не поднимет — выкидываем и принимаем offer на свежий pc.
        if (peer && (peer.pc.connectionState === 'failed' || peer.pc.signalingState === 'closed')) {
          removePeer(from);
          peer = undefined;
        }
        const fresh = !peer;
        if (!peer) {
          createPeer(from, name || 'Участник', false); // мы — отвечающая сторона
          peer = peers.get(from)!;
        }
        const pc = peer.pc;

        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        try {
          await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
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
            if (host.screenOn()) sendScreenTo(peer);
            else sendVideoTo(peer);
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
        host.setStatus((peer?.name || 'Участник') + ' вышел');
        removePeer(id);
        host.playSfx('peerLeave'); // звук отключения участника
      });
    },

    join(newRoom) {
      room = newRoom;
    },

    leave() {
      peers.forEach((peer) => {
        if (peer.failTimer) clearTimeout(peer.failTimer);
        peer.pc.close();
      });
      peers.clear();
      netHistory.clear();
      audioFlow.clear();
      room = null;
      host.setUplink('ok'); // пиров нет — своё «узкое место» сбрасываем
    },

    publishVideo() {
      peers.forEach((peer) => sendVideoTo(peer));
    },

    unpublishVideo() {
      peers.forEach((peer) => {
        if (peer.videoSender) peer.videoSender.replaceTrack(null).catch(() => {});
      });
    },

    publishScreen() {
      peers.forEach((peer) => sendScreenTo(peer));
    },

    unpublishScreen() {
      peers.forEach((peer) => {
        if (peer.videoSender) peer.videoSender.replaceTrack(null).catch(() => {});
        if (peer.screenAudioSender) peer.screenAudioSender.replaceTrack(null).catch(() => {});
      });
    },

    replaceMicTrack(oldTrack, newTrack) {
      peers.forEach((peer) => {
        peer.pc.getSenders().forEach((sn) => {
          if (sn.track && sn.track === oldTrack) sn.replaceTrack(newTrack).catch(() => {});
        });
      });
    },

    retuneVideo() {
      peers.forEach((peer) => {
        if (peer.videoSender) void tuneVideoSender(peer.videoSender, true);
      });
    },

    pollStats() {
      void updateVoicePing();
      void monitorAudioFlow();
      void updatePeerQuality();
    },

    renamePeer(id, name) {
      const peer = peers.get(id);
      if (peer) peer.name = name;
    },

    reset() {
      // Снимаем снимок ключей: removePeer мутирует Map по ходу.
      [...peers.keys()].forEach((id) => removePeer(id));
    },
  };
}

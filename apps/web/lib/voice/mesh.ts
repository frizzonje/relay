'use client';

import { toast } from 'sonner';
import type { IceServer, SdpPayload } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { getIceServers } from '@/lib/config';
import { tx } from '@/lib/i18n';
import { boostVideoBitrate, boostAudioBitrate } from '@/lib/sdp';
import type { UplinkStatus } from '@/stores/voice';
import type { TransportHost, VoiceTransport } from './types';
import { gradeQuality, pingGrade, type NetSnapshot } from './quality';
import { netDelta, readStats, toHistory, worseUplink } from './stats';

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
// Потолки битрейта (SDP задаёт предел кодеку, setParameters — sender'у)
// ─────────────────────────────────────────────────────────────────────────

const VIDEO_MAX_BITRATE = 2_500_000;
const SCREEN_MAX_BITRATE = 8_000_000;

// Потолки битрейта аудио-кодировщика по ролям. Голос держим на «discord-уровне»,
// а звук демонстрации (музыка/фильм) пускаем заметно жирнее — там слышно разницу.
const MIC_AUDIO_MAX_BITRATE = 128_000;
const SCREEN_AUDIO_MAX_BITRATE = 256_000;

// ─────────────────────────────────────────────────────────────────────────
// Окна лестницы восстановления
// ─────────────────────────────────────────────────────────────────────────

// `disconnected` часто поднимается сам (моргнула сеть, сменился путь) — даём
// паузу, но короткую: каждая лишняя секунда здесь — секунда тишины в разговоре.
const RECOVER_GRACE_MS = 4000;
// Сторож ступени: не помогло за это окно — идём дальше по лестнице.
const RECOVER_WINDOW_MS = 7000;
// «Вежливая» сторона ждёт на столько дольше на каждой ступени. Пересобирать
// соединение должен кто-то ОДИН: две встречные пересборки — это два новых pc,
// два отпечатка DTLS и лишний круг переговоров на ровном месте.
const POLITE_LAG_MS = 2500;
// Потолок паузы между повторными пересборками (растёт от RECOVER_WINDOW_MS).
const REBUILD_MAX_DELAY_MS = 30_000;
// Связь «есть», а входящего звука нет столько — считаем поломкой и чиним.
const SILENCE_MS = 8000;

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
  // Собрано ли соединение с политикой relay-only (только TURN). См. rebuildPeer.
  relayOnly: boolean;
  // Стадия лестницы восстановления: 0 — ничего, 1 — сделан ICE-restart, 2 —
  // идут пересборки. Сбрасывается в 0 при выходе на связь.
  recoverStage: number;
  // Сколько раз уже пересобирали соединение: задаёт и паузу до следующей
  // попытки, и политику ICE (через раз — через TURN).
  rebuilds: number;
  // Когда пересобрали в последний раз — чтобы пересборка, рухнувшая сразу, не
  // утаскивала в цикл «упало → пересобрали → упало» на скорости отказа ICE.
  rebuiltAt: number;
  // Про эту связь уже жаловались в тост — не повторяться на каждом круге.
  warned: boolean;
  // Подряд идущие срабатывания сторожа тишины (связь есть, звука нет).
  silentKicks: number;
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
      rebuilds: 0,
      rebuiltAt: 0,
      warned: false,
      silentKicks: 0,
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
      switch (state) {
        case 'connected':
          // Связь есть — лестницу восстановления сбрасываем целиком.
          clearRecovery(peer);
          peer.recoverStage = 0;
          peer.rebuilds = 0;
          peer.silentKicks = 0;
          peer.warned = false; // связь была — следующий провал стоит показать снова
          host.setTileState(peerId, '');
          // bitrate-cap/тюнинг применяем только после ICE — иначе setParameters кидает
          if (peer.videoSender) void tuneVideoSender(peer.videoSender, host.screenOn());
          void tuneAudioSenders(peer);
          break;
        case 'disconnected':
          // Может само подняться (кратковременная смена сети) — даём паузу, затем
          // запускаем лестницу. Если лестница уже идёт (ступень 1+), её сторож
          // главнее: он считает окно текущей ступени, а не грейс.
          host.setTileState(peerId, 'tile.state.reconnecting');
          if (peer.recoverStage === 0) armRecovery(peerId, RECOVER_GRACE_MS);
          break;
        case 'failed':
          host.setTileState(peerId, 'tile.state.reconnecting');
          recoverPeer(peerId);
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
    armRecovery(peerId, RECOVER_WINDOW_MS * 2);
    return pc;
  }

  function clearRecovery(peer: Peer) {
    if (!peer.failTimer) return;
    clearTimeout(peer.failTimer);
    peer.failTimer = null;
  }

  // Закрыть соединение с пиром, оставив плитку: связь мы пересобираем с тем же
  // собеседником, и с точки зрения витрины он никуда не уходил.
  function dropConnection(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    clearRecovery(peer);
    peer.pc.close();
    peers.delete(peerId);
    netHistory.delete(peerId);
    audioFlow.delete(peerId);
    host.cleanupPeerAudio(peerId);
  }

  function removePeer(peerId: string) {
    if (!peers.has(peerId)) return;
    dropConnection(peerId);
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

  // Жив ли сигналинг. Без него ни одна ступень лестницы не работает: и offer
  // ICE-restart'а, и offer пересборки уходят через сокет. Пока он лежит, лестницу
  // держим на паузе — иначе она вхолостую прожжёт все ступени, пока чинить нечего
  // (сокет вернётся — догоним, см. resync).
  function signalingUp(): boolean {
    try {
      return socket().connected !== false;
    } catch {
      return false;
    }
  }

  // Пауза до следующей пересборки — растёт с числом уже сделанных, до потолка.
  function rebuildDelay(rebuilds: number): number {
    return Math.min(RECOVER_WINDOW_MS * Math.max(1, rebuilds), REBUILD_MAX_DELAY_MS);
  }

  // Завести сторож следующей ступени. «Вежливая» сторона ждёт чуть дольше:
  // пересборку должен вести кто-то один, иначе оба выбрасывают живые pc навстречу.
  function armRecovery(peerId: string, delayMs: number) {
    const peer = peers.get(peerId);
    if (!peer) return;
    clearRecovery(peer);
    peer.failTimer = setTimeout(
      () => {
        peer.failTimer = null;
        recoverPeer(peerId);
      },
      delayMs + (peer.polite ? POLITE_LAG_MS : 0),
    );
  }

  // Лестница восстановления связи с пиром:
  //   ступень 1 → ICE-restart (дёшево; частая причина обрыва — сменился сетевой путь);
  //   ступень 2 → пересборка соединения с нуля, через раз — ТОЛЬКО через TURN
  //               (relay-only): это спасает симметричный NAT/DPI, где host/srflx
  //               мертвы, а прямой путь не собирается.
  // Пересборки повторяются с растущей паузой и НЕ кончаются никогда, пока
  // собеседник числится в канале: снять его — дело сервера (peer-left). Раньше
  // лестница сдавалась после двух ступеней и убирала плитку, и звонок оставался
  // молчать до перезахода — даже если сеть чинилась через десять секунд.
  // Дёргается из handleStateChange (failed/disconnected) и из собственных сторожей.
  function recoverPeer(peerId: string) {
    const peer = peers.get(peerId);
    if (!peer) return;
    clearRecovery(peer);
    // Уже снова на связи (гонка таймеров) — ничего не делаем.
    if (peer.connState === 'connected') {
      peer.recoverStage = 0;
      return;
    }
    if (!signalingUp()) {
      armRecovery(peerId, RECOVER_WINDOW_MS); // сигналинг лежит — ступень не доедет
      return;
    }

    if (peer.recoverStage === 0) {
      peer.recoverStage = 1;
      host.diag('mesh recover', `stage 1: restart-ice with ${peer.name}`);
      host.setTileState(peerId, 'tile.state.reconnecting');
      peer.pc.restartIce();
      // Сторож: если ICE-restart не поднял связь за окно — идём на следующую ступень.
      armRecovery(peerId, RECOVER_WINDOW_MS);
      return;
    }

    rebuildPeer(peerId);
  }

  // Ступень 2 лестницы: закрываем мёртвый pc и поднимаем новый как инициатор —
  // наш offer унесёт дорожки, удалённая сторона узнает пересборку по сменившемуся
  // отпечатку DTLS и ответит уже со свежего pc (см. обработчик 'offer').
  // Плитку сохраняем — обновляем только статус.
  function rebuildPeer(peerId: string) {
    const old = peers.get(peerId);
    if (!old) return;
    // Своих дорожек нет (вышли из канала прямо сейчас) — пересобирать нечего.
    if (!host.localStream()) return;

    // Пауза между пересборками. Сеть, которая не даёт связь третий раз подряд, не
    // починится от того, что мы будем долбиться в неё каждые семь секунд, — а
    // пересборка, рухнувшая мгновенно, иначе увела бы в цикл на скорости отказа ICE.
    const wait = rebuildDelay(old.rebuilds);
    const since = Date.now() - old.rebuiltAt;
    if (old.rebuilds > 0 && since < wait) {
      armRecovery(peerId, wait - since);
      return;
    }

    const { name } = old;
    const rebuilds = old.rebuilds + 1;
    // Нечётная попытка идёт через TURN (если он есть), чётная — обычным путём:
    // сеть могла и починиться, а реле — лишний крюк по задержке и чужой трафик.
    const relayOnly = hasTurn() && rebuilds % 2 === 1;
    // Жалуемся ровно один раз на пира: дальше молча продолжаем попытки.
    const warn = !old.warned && rebuilds > 1;
    const warned = old.warned || warn;

    dropConnection(peerId);
    host.diag(
      'mesh recover',
      `stage 2: rebuild #${rebuilds}${relayOnly ? ' relay-only' : ''} with ${name}`,
    );
    // relay-only — отдельная подпись: прямой путь не собрался, идём через TURN.
    host.setTileState(peerId, relayOnly ? 'tile.state.fallback' : 'tile.state.reconnecting');
    createPeer(peerId, name, true, relayOnly); // инициатор — мы

    const peer = peers.get(peerId);
    if (!peer) return;
    peer.recoverStage = 2;
    peer.rebuilds = rebuilds;
    peer.rebuiltAt = Date.now();
    peer.warned = warned;
    armRecovery(peerId, rebuildDelay(rebuilds));

    if (warn) {
      toast.error(tx('voice.toast.peerUnreachable', { name }));
      host.playSfx('error'); // соединиться не вышло
    }
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
      host.setPing({ waiting: true, ms: null, grade: null, label: 'ping.alone' });
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
        const ms = readStats(await peer.pc.getStats()).rttMs;
        if (ms !== null && (rttMs === null || ms < rttMs)) rttMs = ms;
      } catch {
        /* getStats может кинуть на закрывающемся pc — игнорируем */
      }
    }

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

      let report: RTCStatsReport;
      try {
        report = await peer.pc.getStats();
      } catch {
        /* getStats может кинуть на закрывающемся pc — пропускаем пира */
        continue;
      }
      const snap = readStats(report);
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

  // Сторож «односторонней тишины» — ровно тот сбой, на который жалуются: pc бодро
  // рапортует connected, палочки горят, а звука нет, и сам он из этого состояния
  // не выйдет. Байты входящего аудио перестали расти — сперва ICE-restart, если и
  // после него тихо — пересборка соединения.
  //
  // Ложных срабатываний не боимся: мут у нас — это `track.enabled = false`, RTP
  // при этом продолжает идти (DTX в SDP выключен принудительно), а собеседника,
  // который не слал звук НИ РАЗУ, отсекает условие prev.bytes > 0.
  //
  // В лог кладём currentDirection каждого transceiver'а: если тишина от кривого
  // направления m-line после glare, а не от сети, это видно только там.
  async function monitorAudioFlow() {
    const now = Date.now();
    for (const [id, peer] of peers) {
      if (peer.connState !== 'connected') {
        audioFlow.delete(id);
        continue;
      }
      let bytes = 0;
      try {
        bytes = readStats(await peer.pc.getStats()).audioBytesRecv;
      } catch {
        continue;
      }
      const prev = audioFlow.get(id);
      if (!prev || bytes > prev.bytes) {
        audioFlow.set(id, { bytes, since: now });
        peer.silentKicks = 0; // звук идёт — счётчик попыток сбрасываем
        continue;
      }
      // Байты не растут дольше порога — фиксируем и не спамим каждые 3 с
      if (now - prev.since > SILENCE_MS) {
        const tx = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
        const dirs = tx
          .map((t) => `${t.receiver?.track?.kind ?? '?'}:${t.currentDirection ?? '?'}`)
          .join(', ');
        const secs = Math.round((now - prev.since) / 1000);
        console.warn(
          `[voice] нет входящего звука от «${peer.name}» (${id}) ` +
            `${secs}с; bytesReceived=${bytes}; transceivers=[${dirs}]`,
        );
        audioFlow.set(id, { bytes, since: now });
        // Звук шёл и оборвался — чиним. Порог даёт следующую попытку не раньше
        // чем через SILENCE_MS, так что лестница не срывается в цикл.
        if (prev.bytes > 0 && signalingUp()) {
          peer.silentKicks += 1;
          host.diag(
            'mesh silence',
            `${peer.name} ${secs}s: ${peer.silentKicks === 1 ? 'restart-ice' : 'rebuild'}; transceivers=[${dirs}]`,
          );
          host.setTileState(id, 'tile.state.reconnecting');
          if (peer.silentKicks === 1) peer.pc.restartIce();
          else rebuildPeer(id);
        }
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

    // Сокет вернулся с ТЕМ ЖЕ id (socket.io восстановил сессию). Пиров не трогаем —
    // те, у кого медиа пережило обрыв, продолжают говорить, — но лестница всё это
    // время стояла на паузе (без сигналинга ступени не доезжают), а связь за эти
    // секунды могла и развалиться. Догоняем: всем, кто не на связи, — с первой ступени.
    resync() {
      if (!room) return;
      for (const [id, peer] of peers) {
        if (peer.connState === 'connected') continue;
        host.diag('mesh resync', `${peer.name}: ${peer.connState}`);
        peer.recoverStage = 0;
        host.setTileState(id, 'tile.state.reconnecting');
        recoverPeer(id);
      }
    },
  };
}

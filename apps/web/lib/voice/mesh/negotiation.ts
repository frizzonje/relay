'use client';

import type { SdpPayload } from '@relay/shared';
import { getSocket } from '@/lib/socket';
import { tx } from '@/lib/i18n';
import type { TransportHost } from '../types';
import { tuneSdp } from './senders';

/**
 * Perfect negotiation: кто кому уступает при встречных offer'ах, куда девать
 * ICE-кандидатов, приехавших раньше описания, и как узнать, что за тем же
 * собеседником стоит уже ДРУГОЙ `pc`.
 *
 * Здесь и только здесь читается `signalingState`. Четыре поля, которые раньше
 * лежали в записи о собеседнике вперемешку с ступенью лестницы и счётчиком
 * тишины, — состояние ровно этих переговоров и ничьё больше.
 */

/**
 * Отпечаток DTLS из SDP (`a=fingerprint:sha-256 AB:CD:…`). Единственный признак,
 * по которому видно, что собеседник пересобрал соединение: сокет и id у него
 * прежние, а `pc` — уже другой.
 */
function fingerprintOf(sdp: string | undefined): string | null {
  const m = /^a=fingerprint:\s*\S+\s+(\S+)/im.exec(sdp ?? '');
  return m ? m[1] : null;
}

/** Собеседник глазами переговоров. */
export interface NegotiationPeer {
  pc: RTCPeerConnection;
  name: string;
  /** «Вежливая» сторона уступает при одновременных offer'ах. */
  polite: boolean;
}

export interface NegotiationDeps {
  host: TransportHost;
  /** Собеседник из таблицы пиров; null — его уже нет. */
  peer(peerId: string): NegotiationPeer | null;
  /** Выбросить соединение, оставив плитку. */
  dropConnection(peerId: string): void;
  /** Поднять соединение отвечающей стороной; отдаёт свежий `pc`. */
  createPeer(peerId: string, name: string): RTCPeerConnection;
  /** Отдать собеседнику своё видео/демонстрацию, если они включены. */
  sendMedia(peerId: string, pc: RTCPeerConnection): void;
}

export interface Negotiation {
  /** Свой offer: дорожки сменились, браузер просит переговорить заново. */
  offerTo(peerId: string, pc: RTCPeerConnection): Promise<void>;
  /** Свой ICE-кандидат — собеседнику. */
  sendCandidate(peerId: string, candidate: RTCIceCandidate): void;
  onOffer(msg: { from: string; name?: string; sdp: unknown }): Promise<void>;
  onAnswer(msg: { from: string; sdp: unknown }): Promise<void>;
  onCandidate(msg: { from: string; candidate: RTCIceCandidateInit }): Promise<void>;
  forget(peerId: string): void;
  forgetAll(): void;
}

interface Talk {
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** Кандидаты, приехавшие раньше remoteDescription: добавить их пока нельзя. */
  pending: RTCIceCandidateInit[];
  /** Отпечаток DTLS удалённой стороны, каким мы видели его в последний раз. */
  fingerprint: string | null;
}

export function createNegotiation({
  host,
  peer,
  dropConnection,
  createPeer,
  sendMedia,
}: NegotiationDeps): Negotiation {
  const talks = new Map<string, Talk>();

  function talkOf(peerId: string): Talk {
    let talk = talks.get(peerId);
    if (!talk) {
      talk = { makingOffer: false, ignoreOffer: false, pending: [], fingerprint: null };
      talks.set(peerId, talk);
    }
    return talk;
  }

  async function drainCandidates(peerId: string, pc: RTCPeerConnection) {
    const talk = talkOf(peerId);
    const queued = talk.pending;
    talk.pending = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('addIceCandidate failed:', err);
      }
    }
  }

  return {
    async offerTo(peerId, pc) {
      const talk = talkOf(peerId);
      try {
        talk.makingOffer = true;
        const offer = await pc.createOffer();
        // Пока ждали createOffer, мог прийти встречный offer (glare) и сменить
        // состояние. Тогда свой локальный offer уже не нужен: ответим в onOffer,
        // и наш answer заодно унесёт собеседнику свежие дорожки. Без этой
        // проверки setLocalDescription упал бы и оставил связь полусобранной.
        if (pc.signalingState !== 'stable') return;
        offer.sdp = tuneSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        getSocket().emit('offer', { to: peerId, sdp: pc.localDescription as SdpPayload });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        talk.makingOffer = false;
      }
    },

    sendCandidate(peerId, candidate) {
      getSocket().emit('ice-candidate', { to: peerId, candidate: candidate.toJSON() });
    },

    async onOffer({ from, name, sdp }) {
      let who = peer(from);
      const remoteFp = fingerprintOf((sdp as RTCSessionDescriptionInit | undefined)?.sdp);
      // Отпечаток берём ДО возможного сброса: `dropConnection` уносит переговоры
      // вместе с соединением, и очередь чужих кандидатов вместе с ними — они от
      // прошлой ICE-сессии и новому `pc` не годятся.
      const seenFp = talks.get(from)?.fingerprint ?? null;
      // Отпечаток DTLS сменился — за тем же id стоит уже ДРУГОЙ pc: собеседник
      // пересобрал связь (его лестница дошла до ступени 2). Ренеготиацией такой
      // offer не принять — браузер не пустит чужой отпечаток на живой транспорт,
      // и раньше это давало ровно «оба в канале, оба молчат». Пересобираем и мы.
      const rebuilt = !!(who && seenFp && remoteFp && remoteFp !== seenFp);
      // Труп прошлого соединения: setRemoteDescription на мёртвом/закрытом pc
      // связь не поднимет — выкидываем и принимаем offer на свежий pc.
      const dead =
        !!who && (who.pc.connectionState === 'failed' || who.pc.signalingState === 'closed');
      if (who && (dead || rebuilt)) {
        host.diag(
          'mesh peer rebuilt',
          `${who.name}: ${rebuilt ? 'new dtls fingerprint' : who.pc.connectionState}`,
        );
        dropConnection(from);
        host.setTileState(from, 'tile.state.reconnecting');
        who = null;
      }
      const fresh = !who;
      if (!who) {
        createPeer(from, name || tx('voice.peer.fallback')); // мы — отвечающая сторона
        who = peer(from);
        if (!who) return;
      }
      const pc = who.pc;
      const talk = talkOf(from);

      const collision = talk.makingOffer || pc.signalingState !== 'stable';
      talk.ignoreOffer = !who.polite && collision;
      if (talk.ignoreOffer) return;

      try {
        await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
        if (remoteFp) talk.fingerprint = remoteFp;
        await drainCandidates(from, pc);
        const answer = await pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        getSocket().emit('answer', { to: from, sdp: pc.localDescription as SdpPayload });

        // Только теперь, ответив свежему пиру, отдаём ему СВОЮ камеру/демонстрацию.
        // Связь уже стабильна — addTrack здесь запускает обычную ренеготиацию (тот
        // же путь, что при старте показа в живом звонке), а не хрупкий «доп. offer
        // поверх answer», который после переподключения участник нередко не получал.
        if (fresh) sendMedia(from, pc);
      } catch (err) {
        console.error('offer handling failed:', err);
      }
    },

    async onAnswer({ from, sdp }) {
      const who = peer(from);
      if (!who || who.pc.signalingState !== 'have-local-offer') return;
      try {
        await who.pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
        // Запоминаем отпечаток и с answer'а: когда инициаторы мы, offer'ов от
        // собеседника может не быть вовсе — а сравнивать при его пересборке надо.
        const fp = fingerprintOf((sdp as RTCSessionDescriptionInit | undefined)?.sdp);
        if (fp) talkOf(from).fingerprint = fp;
        await drainCandidates(from, who.pc);
      } catch (err) {
        console.error('answer handling failed:', err);
      }
    },

    async onCandidate({ from, candidate }) {
      const who = peer(from);
      if (!who) return;
      const talk = talkOf(from);
      try {
        if (who.pc.remoteDescription) {
          await who.pc.addIceCandidate(candidate);
        } else {
          talk.pending.push(candidate);
        }
      } catch (err) {
        if (!talk.ignoreOffer) console.error('addIceCandidate failed:', err);
      }
    },

    forget(peerId) {
      talks.delete(peerId);
    },

    forgetAll() {
      talks.clear();
    },
  };
}

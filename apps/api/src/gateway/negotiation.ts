import type { IceCandidatePayload, SdpPayload } from '@relay/shared';

/**
 * Тела негоциации, которые сервер пересылает от участника к участнику.
 *
 * Сервер их не читает, но пересылает — значит, отвечает за то, что именно
 * уходит соседу. Без разбора любой в комнате мог бы слать соседям мегабайт за
 * мегабайтом (потолок socket.io — 1 МБ на сообщение) или поля, которых
 * WebRTC не знает и клиент не ждёт. Поэтому дальше уходит заново собранный
 * объект: только поля `RTCSessionDescriptionInit` и `RTCIceCandidateInit`, и
 * каждое — в своём размере. Не подошло — не пересылаем вовсе: обрезанное SDP
 * хуже отсутствующего, его не применить.
 */

/**
 * Потолок SDP. Живое описание Chrome с камерой, экраном и simulcast — около
 * 15 КБ; запас вчетверо, чтобы новый кодек в браузере не уронил звонки.
 */
const SDP_MAX = 64_000;
/** Строка кандидата — сотня-другая знаков; килобайт с запасом. */
const CANDIDATE_MAX = 1_000;
/** `sdpMid` и `usernameFragment` — короткие метки. */
const TAG_MAX = 256;

const SDP_TYPES: ReadonlySet<string> = new Set<SdpPayload['type']>([
  'offer',
  'answer',
  'pranswer',
  'rollback',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Короткая строка, `null` или ничего; что-то иное — `false`, то есть «битое». */
function tag(value: unknown): string | null | undefined | false {
  if (value === undefined || value === null) return value;
  return typeof value === 'string' && value.length <= TAG_MAX ? value : false;
}

/** Описание сессии или `undefined`, если пересылать нечего. */
export function sdpOf(value: unknown): SdpPayload | undefined {
  const raw = record(value);
  if (!raw || typeof raw.type !== 'string' || !SDP_TYPES.has(raw.type)) return undefined;
  const type = raw.type as SdpPayload['type'];
  if (raw.sdp === undefined) return { type };
  if (typeof raw.sdp !== 'string' || raw.sdp.length > SDP_MAX) return undefined;
  return { type, sdp: raw.sdp };
}

/** ICE-кандидат или `undefined`, если пересылать нечего. */
export function candidateOf(value: unknown): IceCandidatePayload | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const { candidate, sdpMLineIndex } = raw;
  if (
    candidate !== undefined &&
    (typeof candidate !== 'string' || candidate.length > CANDIDATE_MAX)
  )
    return undefined;
  if (
    sdpMLineIndex !== undefined &&
    sdpMLineIndex !== null &&
    !(Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0)
  )
    return undefined;
  const sdpMid = tag(raw.sdpMid);
  const usernameFragment = tag(raw.usernameFragment);
  if (sdpMid === false || usernameFragment === false) return undefined;

  const out: IceCandidatePayload = {};
  if (candidate !== undefined) out.candidate = candidate;
  if (sdpMid !== undefined) out.sdpMid = sdpMid;
  if (sdpMLineIndex !== undefined) out.sdpMLineIndex = sdpMLineIndex as number | null;
  if (usernameFragment !== undefined) out.usernameFragment = usernameFragment;
  return out;
}

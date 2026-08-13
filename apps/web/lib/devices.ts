import { certificateMessage, isPublicKey } from '@relay/shared';
import { SignerError, getSigner, type Signer } from './signer';

/**
 * Устройства личности со стороны клиента: список, отзыв и связка нового.
 *
 * Связка идёт в сторону, обратную привычной по ссылкам-приглашениям: код
 * показывает НОВОЕ устройство, а старое — впускает. Отсюда и два разных пути в
 * этом файле: `askPairing` для того, кто просится, `peekPairing` + `admitDevice`
 * для того, кто уже внутри и ручается своей подписью. Почему так — в
 * `apps/api/src/identity/pairing.service.ts`.
 */

export interface Device {
  id: string;
  name: string;
  /** Отпечаток ключа устройства — им два одинаковых имени и различают. */
  fingerprint: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** То, с которого человек смотрит. Отозвать его нельзя. */
  current: boolean;
  /** Корень: с него личность началась, и впустил его никто. */
  root: boolean;
}

/** Что донор видит перед тем, как впустить. */
export interface PairOffer {
  publicKey: string;
  fingerprint: string;
  deviceName: string;
  /** Сколько коду осталось жить. Не метка времени — часы у сторон разные. */
  expiresIn: number;
}

/**
 * Почему не вышло. Первые пять приходят от сервера и означают разные действия
 * человека; `signer` и `network` — то, до сервера не доехавшее.
 */
export type DeviceFailure =
  /** Личность уже пожила: связка — не слияние двух биографий. */
  | 'has-history'
  /** Кода нет, он протух или это вообще не код. */
  | 'bad-code'
  /** Слишком много промахов — сервер просит подождать. */
  | 'too-many'
  /** Сертификат не сошёлся: подписал не тот ключ. */
  | 'bad-signature'
  /** Код введён на том же устройстве, которое его показало. */
  | 'self'
  /** Отзывается то устройство, с которого человек смотрит. */
  | 'current'
  /** Такого устройства нет — список устарел. */
  | 'unknown'
  /** Ключом подписать не вышло: беда та же, что и на входе. */
  | 'signer'
  | 'network';

export class DeviceError extends Error {
  constructor(
    readonly reason: DeviceFailure,
    readonly cause?: unknown,
  ) {
    super(`devices: ${reason}`);
    this.name = 'DeviceError';
  }
}

const KNOWN: DeviceFailure[] = [
  'has-history',
  'bad-code',
  'too-many',
  'bad-signature',
  'self',
  'current',
  'unknown',
];

function base(): string {
  return process.env.NEXT_PUBLIC_API_URL || '';
}

/**
 * Ответ сервера → причина. Всё непонятое становится `network`: врать человеку
 * точной причиной, которой мы не знаем, хуже, чем предложить повторить.
 */
async function failureOf(res: Response): Promise<DeviceError> {
  const body = await res.json().catch(() => null);
  const reason = (body as { error?: string } | null)?.error;
  return new DeviceError(
    KNOWN.includes(reason as DeviceFailure) ? (reason as DeviceFailure) : 'network',
  );
}

async function ask(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { credentials: 'include', ...init });
  } catch (err) {
    // Оборванная сеть отвергает промис, а не отдаёт ответ.
    throw new DeviceError('network', err);
  }
  if (!res.ok) throw await failureOf(res);
  return res.json();
}

async function post(path: string, body?: unknown): Promise<unknown> {
  return ask(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** Все свои устройства, включая отозванные: отзыв должен быть виден. */
export async function listDevices(): Promise<Device[]> {
  return ((await ask('/api/identity/devices')) as { devices: Device[] }).devices;
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await post('/api/identity/devices/revoke', { deviceId });
}

/** «Впустите меня»: код, который это устройство покажет человеку. */
export async function askPairing(): Promise<{ code: string; expiresIn: number }> {
  return (await post('/api/identity/pair/ask')) as { code: string; expiresIn: number };
}

/** Что стоит за кодом — до всякого подтверждения. */
export async function peekPairing(code: string): Promise<PairOffer> {
  return (await ask(`/api/identity/pair/${encodeURIComponent(code)}`)) as PairOffer;
}

/**
 * Впустить устройство: подписать его ключ своим и отдать подпись серверу.
 *
 * Подписывается ровно то, что человеку показали, — ключ из `peekPairing`, а не
 * что-нибудь, добытое заново: иначе между «человек посмотрел на отпечаток» и
 * «устройство вошло» оказались бы два разных ключа.
 *
 * Свой подписыватель передают только тесты — в бою он один на клиент и знает
 * сам, где лежит ключ: в браузере или в оболочке (см. `signer.ts`).
 */
export async function admitDevice(
  code: string,
  identityId: string,
  publicKey: string,
  signer?: Signer,
) {
  if (!isPublicKey(publicKey)) throw new DeviceError('bad-signature');
  let signature: string;
  try {
    const key = signer ?? (await getSigner());
    signature = await key.sign(certificateMessage(identityId, publicKey));
  } catch (err) {
    // Ключ на месте, но подписать им не вышло — это про ключ, а не про связку.
    throw new DeviceError('signer', err instanceof SignerError ? err : undefined);
  }
  await post('/api/identity/pair/confirm', { code, signature });
}

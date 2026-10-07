import { createHash, webcrypto } from 'node:crypto';

import {
  OWNER_TOKEN_BYTES,
  PAIR_CODE_DIGITS,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  SIGN_ALGORITHM,
} from '@relay/shared';

/**
 * Криптография личности на стороне сервера.
 *
 * Константы, тексты подписываемых сообщений и формы кодов — из контракта
 * (`@relay/shared`), одни на обе стороны. Своё здесь только то, что сервер
 * обязан делать иначе: разбор ключа и подписи из сети на `Buffer` (на мусоре
 * он ведёт себя предсказуемее `atob`) и синхронный отпечаток на `node:crypto`
 * — у клиента он асинхронный, на Web Crypto. Байты отпечатка на выходе те же,
 * и это прибито одними контрольными значениями в `identity.test.ts` здесь и
 * в shared.
 */

const FINGERPRINT_BYTES = 8;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Байты из base64url или `null`: значение приходит из сети. */
function bytes(text: unknown, length: number): Buffer | null {
  if (typeof text !== 'string' || !text || !B64URL.test(text)) return null;
  const buf = Buffer.from(text, 'base64url');
  // Buffer.from не жалуется на мусор, а молча даёт что получится: длину
  // проверяем сами, иначе «почти ключ» доедет до сравнения как ключ.
  return buf.length === length ? buf : null;
}

export function isPublicKey(text: unknown): text is string {
  return bytes(text, PUBLIC_KEY_BYTES) !== null;
}

export function isSignature(text: unknown): text is string {
  return bytes(text, SIGNATURE_BYTES) !== null;
}

/** Отпечаток: первые 8 байт SHA-256 от ключа, `a1b2-c3d4-e5f6-7890`. */
export function fingerprint(publicKey: string): string {
  const raw = bytes(publicKey, PUBLIC_KEY_BYTES);
  if (!raw) throw new Error('not a public key');
  const hex = createHash('sha256')
    .update(raw)
    .digest('hex')
    .slice(0, FINGERPRINT_BYTES * 2);
  return (hex.match(/.{4}/g) ?? []).join('-');
}

/**
 * Новый код связки. Считается тем же генератором, что и нонс: код живёт две
 * минуты и пускает чужое устройство в личность — предсказуемым он быть не
 * может, а `Math.random` предсказуем ровно настолько, насколько это важно.
 */
export function newPairCode(): string {
  const span = 10 ** PAIR_CODE_DIGITS;
  // Отсечка кратности: остаток от деления 2^32 на 10^6 иначе сделал бы первые
  // коды чуть вероятнее прочих. Цена — редкий повтор броска.
  const limit = Math.floor(0xffffffff / span) * span;
  let value = 0;
  do {
    value = webcrypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= limit);
  return String(value % span).padStart(PAIR_CODE_DIGITS, '0');
}

export function newOwnerToken(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(OWNER_TOKEN_BYTES))).toString(
    'base64url',
  );
}

/**
 * Как ключ владельца лежит в базе. Хранить его как есть значило бы, что дамп
 * базы (а `relay backup` делает его регулярно и кладёт файлом рядом) содержит
 * действующий ключ от инсталляции. Сравнивать по хэшу дешевле, чем объяснять
 * это потом.
 *
 * Без соли намеренно: солить имеет смысл то, что можно подобрать, а здесь под
 * хэшем 256 бит из системного генератора.
 */
export function hashOwnerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Имя устройства длиннее этого в списке не помещается. */
export const DEVICE_NAME_MAX = 40;

/**
 * Имя устройства — не ник, и правила у него свои: «Chrome · macOS» обязано
 * остаться собой, то есть пробелы и разделители тут законны. Режем ровно то,
 * что ломает чужой экран: управляющие символы и перевод строки.
 */
export function sanitizeDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX);
}

/** Случайный нонс челленджа. */
export function newNonce(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/**
 * Сходится ли подпись. `false` на всём кривом, а не исключение: и ключ, и
 * подпись приходят из сети целиком, так что «не той длины» и «не сошлась» —
 * одно и то же событие. Этот не тот, за кого себя выдаёт.
 */
export async function verifySignature(
  publicKey: unknown,
  message: string,
  signature: unknown,
): Promise<boolean> {
  const key = bytes(publicKey, PUBLIC_KEY_BYTES);
  const sig = bytes(signature, SIGNATURE_BYTES);
  if (!key || !sig) return false;
  try {
    const imported = await webcrypto.subtle.importKey('raw', key, { name: SIGN_ALGORITHM }, false, [
      'verify',
    ]);
    return await webcrypto.subtle.verify(
      { name: SIGN_ALGORITHM },
      imported,
      sig,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

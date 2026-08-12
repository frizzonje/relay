import { createHash, webcrypto } from 'node:crypto';

/**
 * Криптография личности на стороне сервера — sync-близнец
 * `packages/shared/src/identity.ts`.
 *
 * Копия, а не импорт, по той же причине, что и у пропуска (`../auth/auth.ts`):
 * api намеренно не зависит от пакета фронта, и контракт держится совпадением.
 * Здесь эта цена выше обычного — разъехавшийся отпечаток не поймает ни
 * компилятор, ни типы, — поэтому обе стороны прибиты одними и теми же
 * контрольными значениями в тестах (см. `identity.test.ts` тут и
 * `identity.test.ts` в shared). Меняешь одно — второй тест падает.
 *
 * Отличается только реализацией, не поведением: на сервере base64url считает
 * Buffer, а не `btoa`, и хэш — `node:crypto`, а не `subtle.digest`. Байты на
 * выходе те же.
 */

export const SIGN_ALGORITHM = 'Ed25519';
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const NICK_MAX = 20;

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

/** Что подписывает устройство, входя. Префикс отделяет вход от всего прочего. */
export function authMessage(nonce: string): string {
  return `relay-auth-v1:${nonce}`;
}

/** Ник к показываемому виду: свободный и не уникальный, но не любой. */
export function sanitizeNick(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^@+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, NICK_MAX);
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

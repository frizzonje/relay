/**
 * Личность relay: ключ вместо регистрации.
 *
 * Здесь лежит то, что обязаны считать одинаково обе стороны, — кодирование
 * ключей и подписей, отпечаток и текст подписываемого сообщения. Разъедься эти
 * четыре вещи на байт, и симптом будет один: «подпись не сходится», без
 * малейшего намёка, у кого именно.
 *
 * Ничего секретного тут нет и быть не может: пакет импортируют и web, и api, а
 * приватный ключ не покидает устройство в принципе.
 *
 * Как и весь `@relay/shared`, файл не зависит ни от lib.dom, ни от `node:`:
 * `crypto.subtle` и `btoa/atob` есть глобально и в браузере, и в Node 20.
 */

/**
 * Алгоритм один на весь продукт — Ed25519, без переговоров и без запасного.
 *
 * Соблазн подстелить ECDSA P-256 «на случай старого движка» был: он есть
 * везде. Но алгоритм в такой схеме — это не деталь реализации, а свойство
 * ключа, который человек носит с собой годами. Два алгоритма означали бы две
 * ветки проверки на сервере, две формы публичного ключа в базе и в протоколе —
 * и всё это навсегда, ради движков, которые в 2026-м не тянут и половины того,
 * что приложение уже требует. Проба этапа 0 подтвердила Ed25519 в Chromium, в
 * Safari и в WKWebView; движку, который его не знает, честнее сказать об этом
 * прямо, чем незаметно выдать личность послабее.
 */
export const SIGN_ALGORITHM = 'Ed25519';

/** Сырой публичный ключ Ed25519 — ровно 32 байта, подпись — ровно 64. */
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

/**
 * Отпечаток: первые 8 байт SHA-256 от публичного ключа, `a1b2-c3d4-e5f6-7890`.
 *
 * Его читают глазами и диктуют голосом — отсюда и группы, и шестнадцатеричная
 * запись вместо base64 (в котором `l`, `I` и `1` неразличимы на слух). Восьми
 * байт хватает: подобрать ключ под ЗАДАННЫЙ отпечаток — это 2^64 работы, а
 * случайные совпадения на инсталляции в сотню человек не встречаются. Полный
 * ключ при этом никуда не девается: сверять по нему можно всегда.
 */
export const FINGERPRINT_GROUPS = 4;
const FINGERPRINT_BYTES = 8;

const B64URL = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Обратно в байты. Бросает на всём, что не base64url: значение приходит из
 * сети, и «почти ключ» обязан отличаться от ключа здесь, а не тремя слоями
 * ниже, где он уже принят за свой.
 */
export function fromBase64Url(text: string): Uint8Array {
  if (!text || !B64URL.test(text)) throw new Error('not base64url');
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Похоже ли это на публичный ключ: base64url правильной длины. */
export function isPublicKey(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  try {
    return fromBase64Url(text).length === PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Похоже ли это на подпись. */
export function isSignature(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  try {
    return fromBase64Url(text).length === SIGNATURE_BYTES;
  } catch {
    return false;
  }
}

export async function fingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64Url(publicKey) as BufferSource);
  const hex = Array.from(new Uint8Array(digest).slice(0, FINGERPRINT_BYTES))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (hex.match(/.{4}/g) ?? []).join('-');
}

/**
 * Что именно подписывает устройство, входя. Нонс сюда попадает не голым: ключ
 * подписывает и другие вещи (сертификат нового устройства — следующей задачей),
 * и подпись, снятая с одного назначения, не должна годиться для другого.
 * Префикс — вся разница между «доказал, что это его ключ» и «доказал, что
 * когда-то подписал 32 случайных байта».
 */
export function authMessage(nonce: string): string {
  return `relay-auth-v1:${nonce}`;
}

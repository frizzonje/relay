import { describe, expect, it } from 'vitest';
import {
  PUBLIC_KEY_BYTES,
  SIGN_ALGORITHM,
  authMessage,
  fingerprint,
  fromBase64Url,
  isPublicKey,
  isSignature,
  toBase64Url,
} from './identity';

/**
 * Этот файл проверяют обе стороны разом: сервер и клиент считают отпечаток и
 * кодируют ключи одним и тем же кодом, и единственный способ узнать, что они
 * разошлись, — здесь. Симптом расхождения в бою один на всё: «подпись не
 * сходится», без указания на виновника.
 */

/** Настоящая пара — тот же Ed25519, что будет у устройства. */
async function realKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return toBase64Url(new Uint8Array(raw));
}

describe('base64url', () => {
  it('переживает круг для любого байта', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all));
  });

  it('не содержит того, что ломается в URL и в JSON', () => {
    const noisy = new Uint8Array([251, 255, 254, 190, 239]);
    expect(toBase64Url(noisy)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('пустой ввод — это не пустые байты, а отказ', () => {
    expect(() => fromBase64Url('')).toThrow();
  });

  it('обычный base64 не принимается за base64url', () => {
    // Иначе ключ с '+' в теле молча доехал бы до сравнения и не сошёлся.
    expect(() => fromBase64Url('a+b/c=')).toThrow();
  });
});

describe('что похоже на ключ', () => {
  it('настоящий публичный ключ — 32 байта', async () => {
    const key = await realKey();
    expect(fromBase64Url(key)).toHaveLength(PUBLIC_KEY_BYTES);
    expect(isPublicKey(key)).toBe(true);
  });

  it('ключ правильной формы, но не той длины — не ключ', () => {
    expect(isPublicKey(toBase64Url(new Uint8Array(31)))).toBe(false);
    expect(isPublicKey(toBase64Url(new Uint8Array(33)))).toBe(false);
  });

  it('и не-строка тоже: значение приходит из JSON', () => {
    expect(isPublicKey(undefined)).toBe(false);
    expect(isPublicKey(null)).toBe(false);
    expect(isPublicKey({ length: 32 })).toBe(false);
    expect(isSignature(42)).toBe(false);
  });

  it('подпись — 64 байта', () => {
    expect(isSignature(toBase64Url(new Uint8Array(64)))).toBe(true);
    expect(isSignature(toBase64Url(new Uint8Array(32)))).toBe(false);
  });
});

describe('отпечаток', () => {
  it('читается человеком: четыре группы по четыре', async () => {
    expect(await fingerprint(await realKey())).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });

  it('один и тот же ключ — один и тот же отпечаток', async () => {
    const key = await realKey();
    expect(await fingerprint(key)).toBe(await fingerprint(key));
  });

  it('разные ключи — разные отпечатки', async () => {
    expect(await fingerprint(await realKey())).not.toBe(await fingerprint(await realKey()));
  });

  it('посчитан от известного значения — чтобы вторая реализация сверилась', async () => {
    // 32 нулевых байта. Значение зафиксировано намеренно: identicon рисуется из
    // отпечатка, и его смена перерисовала бы всех людей на всех инсталляциях.
    // sha256(32 нулевых байт) = 66687aadf862bd77…
    expect(await fingerprint(toBase64Url(new Uint8Array(32)))).toBe('6668-7aad-f862-bd77');
  });
});

describe('подписываемое сообщение', () => {
  it('несёт назначение, а не только нонс', () => {
    // Подпись под голым нонсом годилась бы для чего угодно, что этот же ключ
    // подписывает в другом месте продукта.
    expect(authMessage('abc')).toBe('relay-auth-v1:abc');
    expect(authMessage('abc')).toContain('abc');
  });
});

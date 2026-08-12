import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_KEY_BYTES,
  SIGN_ALGORITHM,
  authMessage,
  fingerprint,
  isPublicKey,
  isSignature,
  newNonce,
  sanitizeNick,
  verifySignature,
} from './crypto';

/**
 * Этот файл — половина шва между api и `@relay/shared`. Вторая половина —
 * `packages/shared/src/identity.test.ts`, и контрольные значения в них ОДНИ И
 * ТЕ ЖЕ намеренно: копия крипты без такой привязки разъезжается молча, а
 * симптом в бою один — «подпись не сходится», без указания на виновника.
 *
 * Меняешь поведение здесь — второй тест обязан упасть. Если он не упал,
 * значит правку забыли перенести.
 */

/** Настоящая пара Ed25519 — как у устройства. */
async function pair() {
  const keys = (await webcrypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await webcrypto.subtle.exportKey('raw', keys.publicKey);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: async (message: string) =>
      Buffer.from(
        await webcrypto.subtle.sign(
          { name: SIGN_ALGORITHM },
          keys.privateKey,
          new TextEncoder().encode(message),
        ),
      ).toString('base64url'),
  };
}

describe('контрольные значения (совпадают с shared)', () => {
  it('отпечаток нулевого ключа', () => {
    // sha256(32 нулевых байта) = 66687aadf862bd77… Значение зафиксировано:
    // из отпечатка рисуется identicon, и его смена перерисовала бы всех людей
    // на всех инсталляциях разом.
    expect(fingerprint(Buffer.alloc(32).toString('base64url'))).toBe('6668-7aad-f862-bd77');
  });

  it('подписываемое сообщение', () => {
    expect(authMessage('abc')).toBe('relay-auth-v1:abc');
  });

  it('чистка ника', () => {
    expect(sanitizeNick('  @ах  ты\nну  ')).toBe('ах-ты-ну');
    expect(sanitizeNick('-'.repeat(3) + 'а')).toBe('а');
    expect(sanitizeNick('я'.repeat(30))).toHaveLength(20);
    expect(sanitizeNick(42)).toBe('');
  });
});

describe('что похоже на ключ', () => {
  it('настоящий ключ — 32 байта', async () => {
    const me = await pair();
    expect(isPublicKey(me.publicKey)).toBe(true);
    expect(Buffer.from(me.publicKey, 'base64url')).toHaveLength(PUBLIC_KEY_BYTES);
  });

  it('не та длина — не ключ', () => {
    expect(isPublicKey(Buffer.alloc(31).toString('base64url'))).toBe(false);
    expect(isPublicKey(Buffer.alloc(33).toString('base64url'))).toBe(false);
  });

  it('обычный base64 не принимается за base64url', () => {
    // Иначе ключ с '+' в теле доехал бы до сравнения и молча не сошёлся.
    expect(isPublicKey('a+b/' + 'A'.repeat(40))).toBe(false);
  });

  it('и не-строка тоже: значение приходит из JSON', () => {
    expect(isPublicKey(undefined)).toBe(false);
    expect(isPublicKey(null)).toBe(false);
    expect(isPublicKey({ length: 32 })).toBe(false);
    expect(isSignature(42)).toBe(false);
  });

  it('подпись — 64 байта', () => {
    expect(isSignature(Buffer.alloc(64).toString('base64url'))).toBe(true);
    expect(isSignature(Buffer.alloc(32).toString('base64url'))).toBe(false);
  });
});

describe('проверка подписи', () => {
  it('своя сходится', async () => {
    const me = await pair();
    const msg = authMessage('нонс');
    expect(await verifySignature(me.publicKey, msg, await me.sign(msg))).toBe(true);
  });

  it('чужая — нет', async () => {
    const me = await pair();
    const other = await pair();
    const msg = authMessage('нонс');
    expect(await verifySignature(other.publicKey, msg, await me.sign(msg))).toBe(false);
  });

  it('под другим сообщением — нет', async () => {
    const me = await pair();
    const sig = await me.sign(authMessage('нонс-1'));
    expect(await verifySignature(me.publicKey, authMessage('нонс-2'), sig)).toBe(false);
  });

  it('мусор — это «не сошлось», а не падение', async () => {
    const me = await pair();
    const msg = authMessage('нонс');
    const sig = await me.sign(msg);
    expect(await verifySignature('не-ключ', msg, sig)).toBe(false);
    expect(await verifySignature(me.publicKey, msg, 'не-подпись')).toBe(false);
    expect(await verifySignature(undefined, msg, sig)).toBe(false);
    expect(await verifySignature(me.publicKey, msg, null)).toBe(false);
    // Правильной длины, но не тот ключ: importKey согласится, verify — нет.
    expect(await verifySignature(Buffer.alloc(32).toString('base64url'), msg, sig)).toBe(false);
  });
});

describe('нонс', () => {
  it('каждый раз новый и достаточно длинный', () => {
    const seen = new Set(Array.from({ length: 100 }, newNonce));
    expect(seen.size).toBe(100);
    expect(Buffer.from([...seen][0], 'base64url')).toHaveLength(32);
  });
});

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_KEY_BYTES,
  SIGN_ALGORITHM,
  authMessage,
  certificateMessage,
  fingerprint,
  formatPairCode,
  fromBase64Url,
  isOwnerToken,
  isPairCode,
  isPublicKey,
  isSignature,
  ownerLink,
  pairLink,
  readOwnerToken,
  readPairCode,
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

  it('сертификат устройства не спутать со входом', () => {
    // Разные префиксы — единственное, что мешает подписи под нонсом стать
    // пропуском для чужого ключа в личность.
    expect(certificateMessage('id-1', 'key-1')).toBe('relay-device-v1:id-1:key-1');
    expect(certificateMessage('id-1', 'key-1').startsWith('relay-auth-v1')).toBe(false);
  });

  it('сертификат называет и личность, и ключ', () => {
    // Без личности он годился бы для любой другой, где донор тоже состоит.
    expect(certificateMessage('id-1', 'key-1')).not.toBe(certificateMessage('id-2', 'key-1'));
    expect(certificateMessage('id-1', 'key-1')).not.toBe(certificateMessage('id-1', 'key-2'));
  });
});

describe('код связки', () => {
  it('шесть цифр — и ничего кроме', () => {
    expect(isPairCode('428913')).toBe(true);
    expect(isPairCode('42891')).toBe(false);
    expect(isPairCode('4289133')).toBe(false);
    expect(isPairCode('42891a')).toBe(false);
    expect(isPairCode(428913)).toBe(false);
  });

  it('читается и голым, и с пробелами, и из ссылки', () => {
    // Три источника одного значения: ручной ввод, диктовка и сканер QR.
    expect(readPairCode('428913')).toBe('428913');
    expect(readPairCode(' 428 913 ')).toBe('428913');
    expect(readPairCode('https://relay.example/#pair=428913')).toBe('428913');
  });

  it('чужая ссылка кодом не притворяется', () => {
    expect(readPairCode('https://relay.example/')).toBeNull();
    expect(readPairCode('#pair=42891')).toBeNull();
    expect(readPairCode('')).toBeNull();
  });

  it('ссылка складывается обратно в тот же код', () => {
    // Круг замкнут: то, что нарисовано в QR, сканер читает как исходные цифры.
    expect(readPairCode(pairLink('https://relay.example', '428913'))).toBe('428913');
    // Лишний слэш в origin не рождает вторую косую в ссылке.
    expect(pairLink('https://relay.example/', '428913')).toBe('https://relay.example/#pair=428913');
  });

  it('код во фрагменте, а не в пути и не в запросе', () => {
    // Фрагмент не уезжает на сервер — значит, и в его журналах кода не будет.
    const link = pairLink('https://relay.example', '428913');
    expect(link.split('#')[0]).not.toContain('428913');
  });

  it('на экране разбит на тройки', () => {
    expect(formatPairCode('428913')).toBe('428 913');
  });
});

describe('ключ владельца', () => {
  const token = 'ZGVtby1vd25lci10b2tlbi00My1jaGFycy1sb25nLXh4eHg';

  it('это 43 символа base64url, и ничто другое', () => {
    expect(isOwnerToken(token.slice(0, 43))).toBe(true);
    // Короче, длиннее, с выравниванием или не строка вовсе — не ключ.
    expect(isOwnerToken(token.slice(0, 42))).toBe(false);
    expect(isOwnerToken(`${token.slice(0, 42)}=`)).toBe(false);
    expect(isOwnerToken(null)).toBe(false);
  });

  it('ссылка складывается обратно в тот же ключ', () => {
    const link = ownerLink('https://relay.example/', token.slice(0, 43));
    expect(link).toBe(`https://relay.example/#owner=${token.slice(0, 43)}`);
    expect(readOwnerToken(link)).toBe(token.slice(0, 43));
  });

  it('ключ во фрагменте: на сервер он не уезжает', () => {
    // Здесь это важнее, чем у кода связки: ключ — секрет на предъявителя, и
    // строка в журнале Caddy означала бы владельца инсталляции в журнале.
    expect(ownerLink('https://relay.example', token.slice(0, 43)).split('#')[0]).not.toContain(
      token.slice(0, 43),
    );
  });

  it('чужая ссылка ключом не притворяется', () => {
    expect(readOwnerToken('https://relay.example/')).toBeNull();
    expect(readOwnerToken('#owner=short')).toBeNull();
    expect(readOwnerToken('#pair=428913')).toBeNull();
  });
});

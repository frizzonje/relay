import { describe, expect, it, vi } from 'vitest';
import {
  SIGN_ALGORITHM,
  authMessage,
  fromBase64Url,
  isPublicKey,
  isSignature,
} from '@relay/shared';
import { type KeyStore, SignerError, type StoredPair, getSigner, webSigner } from './signer';

/**
 * Ключ проверяется настоящей криптографией: генерация и подпись идут через тот
 * же `crypto.subtle`, что и в браузере (в Node 20 он глобальный). Подделывать
 * тут нечего — подпись либо сходится публичным ключом, либо нет.
 *
 * Подменено только хранилище: IndexedDB в Node нет, а её обёртка — десяток
 * строк, которые по-настоящему проверяет лишь живой движок (e2e). Зато всё,
 * ради чего этот файл существует, — переживает ли ключ перезапуск, не утекает
 * ли приватная половина, что видит человек при отказе, — проверяется здесь.
 */

/** Хранилище в памяти. `save` кладёт то же самое, что положила бы IndexedDB. */
function memoryStore(): KeyStore & { saves: number } {
  let saved: StoredPair | undefined;
  const store = {
    saves: 0,
    load: async () => saved,
    save: async (pair: StoredPair) => {
      store.saves += 1;
      saved = pair;
    },
    clear: async () => {
      saved = undefined;
    },
  };
  return store;
}

const broken = (where: 'load' | 'save'): KeyStore => ({
  load: async () => {
    if (where === 'load') throw new DOMException('нельзя', 'InvalidStateError');
    return undefined;
  },
  save: async () => {
    throw new DOMException('нельзя', 'InvalidStateError');
  },
  clear: async () => {},
});

async function verify(publicKey: string, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(publicKey) as BufferSource,
    { name: SIGN_ALGORITHM },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: SIGN_ALGORITHM },
    key,
    fromBase64Url(signature) as BufferSource,
    new TextEncoder().encode(message),
  );
}

describe('ключ этого устройства', () => {
  it('рождается один раз и переживает перезапуск', async () => {
    const store = memoryStore();
    const first = await webSigner(store);
    const second = await webSigner(store);

    expect(isPublicKey(first.publicKey)).toBe(true);
    expect(second.publicKey).toBe(first.publicKey);
    // Второй заход не должен ни рожать ключ, ни переписывать сохранённый: это
    // была бы новая личность на каждую загрузку страницы.
    expect(store.saves).toBe(1);
  });

  it('подпись сходится публичным ключом', async () => {
    const signer = await webSigner(memoryStore());
    const message = authMessage('нонс-от-сервера');
    const sig = await signer.sign(message);

    expect(isSignature(sig)).toBe(true);
    expect(await verify(signer.publicKey, message, sig)).toBe(true);
  });

  it('и не сходится для чужого сообщения', async () => {
    const signer = await webSigner(memoryStore());
    const sig = await signer.sign(authMessage('нонс-1'));
    expect(await verify(signer.publicKey, authMessage('нонс-2'), sig)).toBe(false);
  });

  it('подпись после перезапуска — тем же ключом', async () => {
    // Это и есть обещание слоя 2: человек возвращается собой, ничего не вводя.
    const store = memoryStore();
    await webSigner(store);
    const again = await webSigner(store);
    const message = authMessage('нонс');
    expect(await verify(again.publicKey, message, await again.sign(message))).toBe(true);
  });

  it('два устройства — два разных ключа', async () => {
    const a = await webSigner(memoryStore());
    const b = await webSigner(memoryStore());
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('приватная половина', () => {
  it('не достаётся из движка в принципе', async () => {
    const store = memoryStore();
    await webSigner(store);
    const pair = (await store.load())!;

    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', pair.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });

  it('а публичная — достаётся, иначе её нечем показать серверу', async () => {
    const store = memoryStore();
    await webSigner(store);
    const pair = (await store.load())!;
    await expect(crypto.subtle.exportKey('raw', pair.publicKey)).resolves.toBeTruthy();
  });
});

describe('когда личности не будет', () => {
  it('хранилище не читается — отказ, а не новая личность', async () => {
    // Приватный режим и заблокированное хранилище выглядят именно так. Молча
    // сгенерировать ключ здесь означало бы менять человека при каждом заходе.
    await expect(webSigner(broken('load'))).rejects.toMatchObject({ reason: 'no-storage' });
  });

  it('ключ негде сохранить — тоже отказ', async () => {
    await expect(webSigner(broken('save'))).rejects.toMatchObject({ reason: 'no-storage' });
  });

  it('нет WebCrypto — говорим про https, а не про «ошибку»', async () => {
    // Ровно то, что видит человек, открывший инсталляцию по http на IP.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const err = await webSigner(memoryStore()).catch((e) => e);
      expect(err).toBeInstanceOf(SignerError);
      expect(err.reason).toBe('no-crypto');
      expect(err.message).toContain('https');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
  });

  it('движок не умеет Ed25519 — это отдельная причина', async () => {
    const gen = vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new Error('nope'));
    try {
      await expect(webSigner(memoryStore())).rejects.toMatchObject({ reason: 'no-crypto' });
    } finally {
      gen.mockRestore();
    }
  });
});

describe('оболочка десктопа', () => {
  it('веб-путь к ключу там не пробуется даже осторожно', async () => {
    // Запись CryptoKey в IndexedDB вешает процесс хранилища WKWebView вместе с
    // сетью. Цена попытки «а вдруг» — не ошибка, а всё приложение.
    const store = memoryStore();
    const load = vi.spyOn(store, 'load');
    await expect(getSigner({ store, shell: true })).rejects.toMatchObject({ reason: 'shell' });
    expect(load).not.toHaveBeenCalled();
  });

  it('в браузере — обычный веб-подписыватель', async () => {
    const signer = await getSigner({ store: memoryStore(), shell: false });
    expect(isPublicKey(signer.publicKey)).toBe(true);
  });
});

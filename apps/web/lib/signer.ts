import { SIGN_ALGORITHM, toBase64Url } from '@relay/shared';

/**
 * Подписыватель — то, чем устройство доказывает, что оно это оно.
 *
 * Личность в 1.0 — это ключевая пара, рождённая на устройстве; сервер видит
 * только публичную половину и нонс, подписанный приватной. Ни регистрации, ни
 * пароля, ни восстановления: приватный ключ никуда не уезжает.
 *
 * Интерфейс здесь ровно потому, что реализаций две. В браузере ключ —
 * `CryptoKey` с `extractable: false` в IndexedDB: движок хранит его сам и
 * наружу не отдаёт. В десктоп-оболочке этот путь запрещён — проба этапа 0
 * показала, что `put` записи с `CryptoKey` вешает процесс хранилища WKWebView
 * намертво, — и там пара живёт в Rust, в системном keychain, а веб просит
 * подписать через мост (`./signer-shell`).
 *
 * Отсюда форма интерфейса: `sign` асинхронный и принимает строку, а не
 * `CryptoKey` и не байты. Через мост Tauri поедет именно строка, и вторая
 * реализация не должна выворачивать первую наизнанку.
 */

export interface Signer {
  /** Публичная половина ключа этого устройства, base64url. */
  readonly publicKey: string;
  /** Подписать сообщение (см. `authMessage` в shared). Подпись — base64url. */
  sign(message: string): Promise<string>;
}

/**
 * Почему личности нет. Каждый вариант — свой экран, а не общее «что-то пошло
 * не так»: человек ничего не сможет сделать, пока не поймёт, что именно.
 */
export type SignerFailure =
  /** Движок не умеет Ed25519 или WebCrypto вовсе (или страница не в secure context). */
  | 'no-crypto'
  /** IndexedDB недоступна или отказала: приватный режим, заблокированное хранилище. */
  | 'no-storage'
  /** Оболочка десктопа не дала ключ: старая сборка, немой мост, чужой origin. */
  | 'shell'
  /** Оболочке негде держать ключ: система отказала и связке, и файлу. */
  | 'keychain'
  /** Движок согласился, но не сделал. */
  | 'engine';

export class SignerError extends Error {
  constructor(
    readonly reason: SignerFailure,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

/** Где живёт пара между запусками. Отдельно от подписи — ради второй реализации. */
export interface StoredPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** Публичная половина в base64url: считаем один раз, а не при каждом входе. */
  raw: string;
}

export interface KeyStore {
  load(): Promise<StoredPair | undefined>;
  save(pair: StoredPair): Promise<void>;
  clear(): Promise<void>;
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'relay-identity';
const STORE = 'keys';
const RECORD = 'device';

/**
 * Сторож на каждую операцию. Не перестраховка: зависший запрос к IndexedDB не
 * зовёт ни `onsuccess`, ни `onerror` — это ровно то, что проба видела в
 * WKWebView. Без срока экран первого входа остался бы крутиться вечно, и
 * человеку нечего было бы даже рассказать в issue.
 */
const IDB_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new SignerError('no-storage', `хранилище не ответило: ${what}`)),
        IDB_TIMEOUT_MS,
      ),
    ),
  ]);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB отказала'));
  });
}

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new SignerError('no-storage', 'в этом окружении нет IndexedDB'));
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore(STORE);
  };
  return withTimeout(promisify(req), 'открытие базы');
}

async function inStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();
  try {
    return await withTimeout(promisify(fn(db.transaction(STORE, mode).objectStore(STORE))), mode);
  } finally {
    db.close();
  }
}

/** Штатное хранилище браузера. В оболочке десктопа не используется никогда. */
export function indexedDbStore(): KeyStore {
  return {
    load: () => inStore<StoredPair | undefined>('readonly', (s) => s.get(RECORD)),
    save: async (pair) => {
      await inStore('readwrite', (s) => s.put(pair, RECORD));
    },
    clear: async () => {
      await inStore('readwrite', (s) => s.delete(RECORD));
    },
  };
}

// ── Пара ─────────────────────────────────────────────────────────────────────

async function generate(): Promise<StoredPair> {
  // `extractable: false` относится к приватной половине — публичную спецификация
  // отдаёт всегда, иначе её нечем было бы показать серверу.
  const pair = (await crypto.subtle.generateKey({ name: SIGN_ALGORITHM }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    raw: toBase64Url(new Uint8Array(raw)),
  };
}

function usable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

/**
 * Ключ этого браузера: поднять сохранённый или родить новый.
 *
 * Отказ хранилища — это отказ, а не повод молча жить дальше. Сгенерировать
 * ключ, который не переживёт вкладку, значит завести человеку новую личность
 * при каждом заходе: чужие сообщения в ленте, новая строка в базе на каждый F5
 * и никакого способа догадаться, почему.
 */
export async function webSigner(store: KeyStore = indexedDbStore()): Promise<Signer> {
  if (!usable())
    throw new SignerError('no-crypto', 'движок не даёт WebCrypto: нужен https или localhost');

  let pair: StoredPair | undefined;
  try {
    pair = await store.load();
  } catch (err) {
    throw err instanceof SignerError
      ? err
      : new SignerError('no-storage', 'не удалось прочитать ключ', err);
  }

  if (!pair) {
    try {
      pair = await generate();
    } catch (err) {
      throw new SignerError('no-crypto', `движок не умеет ${SIGN_ALGORITHM}`, err);
    }
    try {
      await store.save(pair);
    } catch (err) {
      throw err instanceof SignerError
        ? err
        : new SignerError('no-storage', 'ключ негде сохранить', err);
    }
  }

  const { privateKey, raw } = pair;
  return {
    publicKey: raw,
    async sign(message: string): Promise<string> {
      try {
        const sig = await crypto.subtle.sign(
          { name: SIGN_ALGORITHM },
          privateKey,
          new TextEncoder().encode(message),
        );
        return toBase64Url(new Uint8Array(sig));
      } catch (err) {
        throw new SignerError('engine', 'подпись не удалась', err);
      }
    },
  };
}

/** Мы внутри десктоп-оболочки? Там веб-путь к ключу запрещён. */
function inShell(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

/**
 * Подписыватель для этого клиента. Единственная точка входа для остального
 * кода: он не должен знать, чем именно подписано.
 *
 * В оболочке веб-путь не пробуется даже осторожно. Дело не в чистоте: запись
 * `CryptoKey` в IndexedDB вешает там процесс хранилища целиком, после чего
 * страница остаётся и без базы, и без сети — то есть попытка «а вдруг
 * получится» стоит не ошибки, а всего приложения.
 *
 * Импорт оболочечной реализации отложенный: в браузере этот модуль не нужен, а
 * статическая ссылка замкнула бы круг (`signer-shell` берёт отсюда `Signer` и
 * `SignerError`).
 */
export async function getSigner(opts: { store?: KeyStore; shell?: boolean } = {}): Promise<Signer> {
  if (opts.shell ?? inShell()) {
    const { shellSigner } = await import('./signer-shell');
    return shellSigner();
  }
  return webSigner(opts.store);
}

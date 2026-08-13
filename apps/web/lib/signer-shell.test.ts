import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIGN_ALGORITHM,
  authMessage,
  fromBase64Url,
  isPublicKey,
  isSignature,
  toBase64Url,
} from '@relay/shared';
import { type ShellBridge, shellSigner } from './signer-shell';

/**
 * Оболочка здесь ненастоящая, а криптография — настоящая: поддельный «Rust»
 * держит свою пару и подписывает ею через тот же `crypto.subtle`. Так тест
 * проверяет ровно то, ради чего мост существует: страница получает публичный
 * ключ, которого у неё нет, и подпись, которая этим ключом сходится.
 *
 * Второе, что здесь проверяется, — поведение моста, у которого нет гарантий
 * доставки: молчание, чужой id, отказ в правах. Каждый такой случай обязан
 * стать своей бедой с экраном, а не вечным ожиданием.
 */

type Request = { id: string; op: string; message?: string };
type Handler = (e: { payload: unknown }) => void;

interface FakeShell extends ShellBridge {
  /** Сколько раз web-сторона подписалась на ответы (должна — один раз). */
  subscriptions: number;
  requests: Request[];
}

/**
 * Оболочка, которая отвечает как настоящая. `answer` подменяет ответ целиком:
 * им изображаются отказы Rust и молчание (`null`).
 */
function fakeShell(answer?: (req: Request) => Promise<unknown> | unknown): FakeShell {
  const listeners = new Map<string, Handler>();
  const own = crypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, ['sign', 'verify']);

  const shell: FakeShell = {
    subscriptions: 0,
    requests: [],
    async listen<T>(event: string, handler: (e: { payload: T }) => void) {
      shell.subscriptions += 1;
      listeners.set(event, handler as Handler);
      return () => listeners.delete(event);
    },
    async emit(_event: string, payload?: unknown) {
      const req = payload as Request;
      shell.requests.push(req);
      const reply = await (answer ? answer(req) : native(await own, req));
      if (reply != null) listeners.get('identity-reply')?.({ payload: reply });
    },
  };
  return shell;
}

/** Что ответил бы Rust: публичная половина и подпись своим ключом. */
async function native(pair: CryptoKeyPair, req: Request) {
  if (req.op === 'key') {
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    return { id: req.id, publicKey: toBase64Url(new Uint8Array(raw)) };
  }
  const sig = await crypto.subtle.sign(
    { name: SIGN_ALGORITHM },
    pair.privateKey,
    new TextEncoder().encode(req.message ?? ''),
  );
  return { id: req.id, signature: toBase64Url(new Uint8Array(sig)) };
}

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

afterEach(() => {
  vi.useRealTimers();
});

describe('ключ живёт в оболочке', () => {
  it('страница получает публичный ключ и подпись, которая им сходится', async () => {
    const shell = fakeShell();
    const signer = await shellSigner(shell);
    const message = authMessage('нонс-от-сервера');
    const sig = await signer.sign(message);

    expect(isPublicKey(signer.publicKey)).toBe(true);
    expect(isSignature(sig)).toBe(true);
    expect(await verify(signer.publicKey, message, sig)).toBe(true);
    // Весь разговор — «дай публичный ключ» и «подпиши это». Секрет через мост
    // не едет ни в каком виде, и попросить его нечем.
    expect(shell.requests.map((r) => r.op)).toEqual(['key', 'sign']);
  });

  it('подписка на ответы одна на все запросы', async () => {
    const shell = fakeShell();
    const signer = await shellSigner(shell);
    await signer.sign('раз');
    await signer.sign('два');
    expect(shell.subscriptions).toBe(1);
  });

  it('две оболочки — два разных ключа', async () => {
    const a = await shellSigner(fakeShell());
    const b = await shellSigner(fakeShell());
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('когда оболочка не даёт ключа', () => {
  it('молчит — это «обнови приложение», а не вечное ожидание', async () => {
    vi.useFakeTimers();
    const caught = shellSigner(fakeShell(() => null)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(46_000);
    await expect(caught).resolves.toMatchObject({ reason: 'shell' });
  });

  it('отвечает не на тот запрос — ответ не засчитывается', async () => {
    // Мост широковещательный: чужой ответ обязан пройти мимо, иначе один
    // запрос получил бы подпись, заказанную другим.
    vi.useFakeTimers();
    const caught = shellSigner(fakeShell((req) => ({ ...req, id: 'чужой', publicKey: 'x' }))).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(46_000);
    await expect(caught).resolves.toMatchObject({ reason: 'shell' });
  });

  it('моста нет вовсе — тоже «обнови приложение»', async () => {
    await expect(shellSigner(null)).rejects.toMatchObject({ reason: 'shell' });
  });

  it('ключ негде держать — отдельная беда: чинится системой, а не клиентом', async () => {
    const refusing = fakeShell((req) => ({
      id: req.id,
      error: { kind: 'store', detail: 'keychain отказал' },
    }));
    await expect(shellSigner(refusing)).rejects.toMatchObject({ reason: 'keychain' });
  });

  it('просит не страница сервера — это отказ оболочки', async () => {
    const wrong = fakeShell((req) => ({ id: req.id, error: { kind: 'origin', detail: 'пикер' } }));
    await expect(shellSigner(wrong)).rejects.toMatchObject({ reason: 'shell' });
  });

  it('вместо ключа мусор — принимать его нельзя', async () => {
    const nonsense = fakeShell((req) => ({ id: req.id, publicKey: 'не-ключ' }));
    await expect(shellSigner(nonsense)).rejects.toMatchObject({ reason: 'shell' });
  });

  it('вместо подписи мусор — тоже', async () => {
    const pair = await crypto.subtle.generateKey({ name: SIGN_ALGORITHM }, true, [
      'sign',
      'verify',
    ]);
    const half = fakeShell((req) =>
      req.op === 'key' ? native(pair, req) : { id: req.id, signature: 'не-подпись' },
    );
    const signer = await shellSigner(half);
    await expect(signer.sign('привет')).rejects.toMatchObject({ reason: 'shell' });
  });

  it('оболочка не дала слушать ответы — говорим об оболочке, а не о движке', async () => {
    // Так выглядит origin, не подошедший под capabilities/remote.json.
    const deaf: ShellBridge = {
      listen: () => Promise.reject(new Error('forbidden')),
      emit: () => Promise.resolve(),
    };
    await expect(shellSigner(deaf)).rejects.toMatchObject({ reason: 'shell' });
  });

  it('оболочка не приняла запрос — тоже её беда', async () => {
    const mute: ShellBridge = {
      listen: async () => () => {},
      emit: () => Promise.reject(new Error('forbidden')),
    };
    await expect(shellSigner(mute)).rejects.toMatchObject({ reason: 'shell' });
  });
});

import { authMessage } from '@relay/shared';
import { SignerError, type Signer, getSigner } from './signer';

/**
 * Вход личности со стороны клиента: три запроса, ни одного поля ввода.
 *
 *   1. ключ устройства (родится сам, если его ещё нет);
 *   2. `challenge` — сервер даёт нонс именно на этот ключ;
 *   3. `verify` — устройство подписывает нонс и получает куку личности.
 *
 * Дальше сервер узнаёт человека по куке, а если та протухла (или api
 * перезапустили — сессии живут в его памяти), клиент молча проходит те же три
 * шага заново. Спрашивать человека при этом не о чем: личность — это ключ, а
 * ключ никуда не делся.
 */

export interface Identity {
  id: string;
  publicKey: string;
  fingerprint: string;
  nick: string;
  device: { id: string; name: string };
  /** Личность родилась прямо сейчас — первому входу есть что рассказать. */
  created: boolean;
}

/** Почему не вошли. `signer` — беда с ключом, остальное — с сервером. */
export type LoginFailure =
  | { kind: 'signer'; error: SignerError }
  /** Устройство отозвано владельцем личности: чинится только новой связкой. */
  | { kind: 'revoked' }
  /** Ворота инсталляции: пропуск протух, надо на /login. */
  | { kind: 'gate' }
  | { kind: 'network'; status?: number };

export class LoginError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(`identity login failed: ${failure.kind}`);
    this.name = 'LoginError';
  }
}

function base(): string {
  return process.env.NEXT_PUBLIC_API_URL || '';
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Ответ сервера → причина отказа. 401 на воротах и на подписи различимы телом. */
async function failureOf(res: Response): Promise<LoginFailure> {
  if (res.status === 403) return { kind: 'revoked' };
  if (res.status === 401) {
    // Гейт инсталляции отвечает своим телом; личностные отказы — своим.
    const body = await res.json().catch(() => null);
    const reason = (body as { error?: string } | null)?.error;
    if (reason === 'revoked') return { kind: 'revoked' };
    if (reason && reason.startsWith('bad-')) return { kind: 'network', status: 401 };
    return { kind: 'gate' };
  }
  return { kind: 'network', status: res.status };
}

/**
 * Кто мы для сервера прямо сейчас. `null` — сессии нет; это не ошибка, а
 * обычное состояние первого захода и любого захода после рестарта api.
 */
export async function whoAmI(): Promise<Identity | null> {
  const res = await fetch(`${base()}/api/identity/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new LoginError(await failureOf(res));
  return (await res.json()) as Identity;
}

/**
 * Доказать серверу, кто мы. `nick` и `deviceName` нужны только при самом первом
 * входе этим ключом — дальше сервер уже знает имя и переписывать его входом не
 * станет.
 */
export async function proveIdentity(
  opts: { nick?: string; deviceName?: string; signer?: Signer } = {},
): Promise<Identity> {
  let signer: Signer;
  try {
    signer = opts.signer ?? (await getSigner());
  } catch (err) {
    throw new LoginError({
      kind: 'signer',
      error: err instanceof SignerError ? err : new SignerError('engine', String(err), err),
    });
  }

  const asked = await post('/api/identity/challenge', { publicKey: signer.publicKey });
  if (!asked.ok) throw new LoginError(await failureOf(asked));
  const { nonce } = (await asked.json()) as { nonce: string };

  const signature = await signer.sign(authMessage(nonce));
  const verified = await post('/api/identity/verify', {
    publicKey: signer.publicKey,
    nonce,
    signature,
    nick: opts.nick,
    deviceName: opts.deviceName ?? describeDevice(),
  });
  if (!verified.ok) throw new LoginError(await failureOf(verified));
  return (await verified.json()) as Identity;
}

/** Сменить ник. Возвращает вычищенный сервером вариант. */
export async function renameIdentity(nick: string): Promise<string> {
  const res = await post('/api/identity/nick', { nick });
  if (!res.ok) throw new LoginError(await failureOf(res));
  return ((await res.json()) as { nick: string }).nick;
}

/**
 * Как это устройство назвать в списке устройств. Не отпечаток браузера и не
 * попытка в него: строка нужна человеку, чтобы узнать свой ноутбук среди трёх
 * своих же, — и ничего кроме этого из неё выжать нельзя.
 *
 * Названия движка и системы намеренно не переводятся: строка едет в базу и
 * оттуда показывается всем устройствам этого человека, у которых язык
 * интерфейса может быть свой. «Chrome · macOS» читается одинаково везде.
 */
export function describeDevice(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  // Оболочка называется собой, а не своим движком: в списке устройств человек
  // ищет «приложение на ноутбуке», и `Safari · macOS` (а в WKWebView и вовсе
  // `browser · macOS`) он там не узнает. Браузер на той же машине — отдельное
  // устройство с отдельным ключом, и различать их надо с одного взгляда.
  const engine =
    typeof window !== 'undefined' && window.__TAURI__
      ? 'relay desktop'
      : /Firefox/.test(ua)
        ? 'Firefox'
        : /Edg\//.test(ua)
          ? 'Edge'
          : /Chrome|Chromium/.test(ua)
            ? 'Chrome'
            : /Safari/.test(ua)
              ? 'Safari'
              : 'browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${engine} · ${os}` : engine;
}

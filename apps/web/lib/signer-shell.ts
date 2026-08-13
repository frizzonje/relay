import { isPublicKey, isSignature } from '@relay/shared';
import { SignerError, type Signer } from './signer';

/**
 * Подписыватель десктоп-оболочки: ключа здесь нет, есть право попросить.
 *
 * Пара живёт в Rust (clients/desktop/src-tauri/src/identity.rs) — в webview ей
 * нельзя: `put` записи с `CryptoKey` вешает процесс хранилища WKWebView
 * намертво, а сырые байты в IndexedDB достаёт любой скрипт страницы. Отсюда
 * форма: страница знает свой публичный ключ и умеет получать подписи, но не
 * может ни прочитать секрет, ни унести его с собой.
 *
 * ## Почему события, а не `invoke`
 *
 * Веб-UI грузится с сервера, то есть для оболочки он — удалённый origin, и прав
 * у него ровно `core:event` (capabilities/remote.json). Кастомная команда
 * потребовала бы выдать удалённой странице доступ к командам приложения; пара
 * событий с общим `id` даёт то же самое, ничего не расширяя. Цена — ручное
 * сопоставление ответов и свой срок ожидания, оба здесь.
 *
 * Срок щедрый намеренно: на macOS обращение к keychain вправе показать
 * системный запрос «пустить relay к ключу», и человек отвечает на него руками.
 * Пока идёт ожидание, приложение не заперто — экран личности показывается
 * только когда ответ уже есть (см. stores/identity.ts).
 */

const REQUEST = 'identity-request';
const REPLY = 'identity-reply';

/** Сколько ждём оболочку. Больше похоже на «человек читает диалог ОС», чем на «мост мёртв». */
const TIMEOUT_MS = 45_000;

/** Ответ Rust. Ровно один из трёх ключей осмыслен — какой, решает запрос. */
interface Reply {
  id: string;
  publicKey?: string;
  signature?: string;
  error?: { kind?: string; detail?: string };
}

/** События Tauri в том объёме, в каком они нужны здесь (см. lib/desktop.ts). */
export interface ShellBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  emit(event: string, payload?: unknown): Promise<void>;
}

export function tauriBridge(): ShellBridge | null {
  if (typeof window === 'undefined') return null;
  return (window.__TAURI__?.event as ShellBridge | undefined) ?? null;
}

/**
 * Отказ оболочки → беда, у которой есть экран. `store` («ключ негде держать»)
 * стоит отдельно от всех прочих: чинится он не обновлением клиента, а системой
 * — запущенной связкой ключей и разрешением ей пользоваться.
 */
function refusal(error: Reply['error']): SignerError {
  const detail = error?.detail ?? '';
  return error?.kind === 'store'
    ? new SignerError('keychain', `оболочке негде держать ключ: ${detail}`)
    : new SignerError('shell', `оболочка отказала (${error?.kind ?? 'без причины'}): ${detail}`);
}

let counter = 0;

/**
 * Связь с оболочкой: одна подписка на ответы и стол ожидающих запросов.
 * Одна на окно — подписка навешивается лениво и не снимается, потому что жива
 * ровно столько же, сколько страница.
 */
class ShellLink {
  private waiting = new Map<string, (r: Reply) => void>();
  private subscribed: Promise<void> | null = null;

  constructor(readonly bridge: ShellBridge) {}

  private subscribe(): Promise<void> {
    this.subscribed ??= this.bridge
      .listen<Reply>(REPLY, ({ payload }) => {
        // Чужие ответы (запрос уже сдался по сроку) молча выбрасываем: свой
        // ответ узнаётся по `id`, и путать их нельзя ни в коем случае.
        const settle = this.waiting.get(payload?.id);
        if (settle) {
          this.waiting.delete(payload.id);
          settle(payload);
        }
      })
      .then(() => undefined)
      .catch((err: unknown) => {
        // Подписку отклоняют, когда origin не подошёл под capabilities. Причина
        // одна на все запросы, поэтому запоминать отказ незачем — следующая
        // попытка честно спросит заново.
        this.subscribed = null;
        throw new SignerError('shell', 'оболочка не дала слушать ответы', err);
      });
    return this.subscribed;
  }

  async ask(op: 'key' | 'sign', message?: string): Promise<Reply> {
    await this.subscribe();
    counter += 1;
    const id = `${Date.now().toString(36)}-${counter}`;

    const answer = new Promise<Reply>((resolve, reject) => {
      this.waiting.set(id, resolve);
      setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        reject(new SignerError('shell', `оболочка не ответила на «${op}»`));
      }, TIMEOUT_MS);
    });

    try {
      await this.bridge.emit(REQUEST, { id, op, message });
    } catch (err) {
      this.waiting.delete(id);
      throw new SignerError('shell', 'оболочка не приняла запрос', err);
    }

    const reply = await answer;
    if (reply.error) throw refusal(reply.error);
    return reply;
  }
}

let link: ShellLink | null = null;

function linkTo(bridge: ShellBridge): ShellLink {
  if (!link || link.bridge !== bridge) link = new ShellLink(bridge);
  return link;
}

/**
 * Ключ этого устройства глазами страницы. Публичную половину спрашиваем сразу:
 * без неё нечего показывать серверу, и лучше узнать о немой оболочке здесь,
 * чем на середине входа.
 */
export async function shellSigner(bridge: ShellBridge | null = tauriBridge()): Promise<Signer> {
  if (!bridge) throw new SignerError('shell', 'моста с оболочкой нет');

  const shell = linkTo(bridge);
  const { publicKey } = await shell.ask('key');
  if (!isPublicKey(publicKey)) throw new SignerError('shell', 'оболочка вернула не публичный ключ');

  return {
    publicKey,
    async sign(message: string): Promise<string> {
      const { signature } = await shell.ask('sign', message);
      if (!isSignature(signature)) throw new SignerError('shell', 'оболочка вернула не подпись');
      return signature;
    },
  };
}

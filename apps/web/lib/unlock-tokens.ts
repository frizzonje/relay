/**
 * Пропуска в закрытые серверы: подписанные сервером токены «пароль этого
 * сервера предъявляли» (выдаются в `server-unlock-result`, см. gateway/unlock).
 *
 * Зачем они лежат здесь, а не пароль. Разблокировка живёт на сокете, а сокет
 * рвётся сам по себе — спящий ноутбук, смена сети, перезапуск api. После
 * реконнекта сервер о введённом пароле не помнит, и спросить его заново не у
 * кого: диалог показывают один раз. Каналы закрытого сервера пропадают из
 * реестра прямо под человеком, а вход в них начинает молча отбиваться.
 *
 * Хранить сам пароль было бы проще — и неправильно: он общий на всех, кто
 * ходит в этот сервер, и localStorage ему не место. Пропуск же не открывает
 * ничего, кроме одного сервера, протухает сам и умирает от смены пароля.
 */

const KEY = 'relay-unlock';

type Store = Record<string, string>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [id, token] of Object.entries(parsed)) {
      if (typeof token === 'string' && token) out[id] = token;
    }
    return out;
  } catch {
    // Приватный режим, заблокированное хранилище или битый JSON — живём без
    // запомненных разблокировок: пароль просто спросят заново.
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* хранилище недоступно — разблокировка не переживёт реконнект, и только */
  }
}

/** Все пропуска — в handshake уходит именно этот список (см. lib/socket). */
export function loadUnlockTokens(): string[] {
  return Object.values(read());
}

/** Есть ли пропуск на этот сервер (нет — значит пароль ещё не предъявляли). */
export function hasUnlockToken(serverId: string): boolean {
  return serverId in read();
}

/** Id серверов, на которые лежат пропуска, — чтобы вымести пропавшие. */
export function unlockTokenIds(): string[] {
  return Object.keys(read());
}

/** Запомнить выданный пропуск. */
export function saveUnlockToken(serverId: string, token: string): void {
  const store = read();
  if (store[serverId] === token) return;
  store[serverId] = token;
  write(store);
}

/**
 * Забыть пропуск: сервер его не принял (пароль сменили, сервер удалили) или
 * человек сам вышел из закрытого сервера. Держать мёртвый токен незачем — он
 * будет ездить в каждом handshake и каждый раз молча отбраковываться.
 */
export function dropUnlockToken(serverId: string): void {
  const store = read();
  if (!(serverId in store)) return;
  delete store[serverId];
  write(store);
}

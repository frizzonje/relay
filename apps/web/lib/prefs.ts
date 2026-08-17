import type { PrefKey } from '@relay/shared';
import { getSocket } from '@/lib/socket';

/**
 * Настройки, принадлежащие человеку, а не браузеру.
 *
 * Граница проходит по вопросу «это про людей или про эту машину». Громкость
 * конкретного собеседника и звук конкретного канала — про людей и каналы: они
 * одинаковы на телефоне, на десктопе и в чужом браузере, куда человек зашёл
 * своим ключом. Выбор микрофона, наушников, камеры, горячие клавиши и
 * push-to-talk — про эту клавиатуру и эти наушники, и они остаются там, где и
 * лежали. Синхронизировать выбранный микрофон между устройствами значит
 * сломать оба.
 *
 * localStorage при этом никуда не делся и делся не должен: он остаётся кэшем.
 * Настройки нужны в первый кадр — до того, как поднимется сокет, а иногда и
 * вместо него: у гостя по инвайту и у браузера, не сумевшего родить ключ,
 * личности нет вовсе, и для них всё работает ровно как раньше. Ключи хранения
 * оставлены прежними, чтобы в день обновления никто не обнаружил, что его
 * настройки «сбросились».
 */

/** Где лежит локальная копия. Имена — исторические, менять их незачем. */
export const PREF_STORAGE: Record<PrefKey, string> = {
  sound: 'relay-channel-sound',
  volume: 'relay-peer-vol',
};

const KEYS = Object.keys(PREF_STORAGE) as PrefKey[];

type Listener = (value: unknown) => void;
const listeners = new Map<PrefKey, Set<Listener>>();

/** Локальная копия настройки. `fallback` — когда её нет или она испорчена. */
export function readPref<T>(key: PrefKey, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(PREF_STORAGE[key]);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function cache(key: PrefKey, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PREF_STORAGE[key], JSON.stringify(value));
  } catch {
    // приватный режим/квота — настройка просто не переживёт перезагрузку
  }
}

/**
 * Человек что-то поменял: запоминаем здесь и рассказываем серверу.
 *
 * Ответа не ждём и по нему ничего не решаем. Настройка уже применена — держать
 * громкость собеседника в зависимости от того, дошёл ли пакет, было бы странно;
 * не дошло — синхронизация случится на следующем заходе, когда клиент отдаст
 * серверу своё в ответ на снимок.
 */
export function setPref(key: PrefKey, value: unknown): void {
  cache(key, value);
  const socket = getSocket();
  if (socket.connected) socket.emit('prefs-set', { key, value });
}

/**
 * Настройки приехали с сервера: снимком на входе или правкой с другого
 * устройства этого же человека.
 *
 * У снимка (`full`) есть вторая половина работы: то, что человек настроил в
 * этом браузере ДО того, как у него появилась личность, сервер видит впервые.
 * Такие ключи уезжают наверх — но только те, которых у сервера нет вовсе.
 * Спорить с сервером за уже известный ему ключ клиент не имеет права: иначе
 * старая вкладка, провалявшаяся сутки, возвращала бы звук каналам, которые
 * человек вчера заглушил с телефона.
 */
export function adoptPrefs(
  values: Partial<Record<PrefKey, unknown>>,
  opts: { full?: boolean } = {},
): void {
  const socket = getSocket();
  for (const key of KEYS) {
    const incoming = values?.[key];
    if (incoming !== undefined && incoming !== null) {
      cache(key, incoming);
      for (const listener of listeners.get(key) ?? []) listener(incoming);
      continue;
    }
    if (!opts.full) continue;
    const mine = readPref<unknown>(key, undefined);
    if (mine === undefined || !socket.connected) continue;
    socket.emit('prefs-set', { key, value: mine });
  }
}

/** Узнать, что настройку поменяли на другом устройстве. Возвращает отписку. */
export function onPref(key: PrefKey, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => set.delete(listener);
}

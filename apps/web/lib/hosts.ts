import { readStoredJson, writeStoredJson } from '@/lib/storage';
/**
 * «Другие хосты» — чужие инсталляции relay в рейке (например, сервер друга на
 * своём домене). Это не гильдии одного бэкенда, а отдельные origin'ы: клик по
 * иконке уводит браузер/webview на тот хост целиком. Кука, логин и localStorage
 * у каждого хоста свои. Список живёт только в этом браузере (localStorage).
 */

const HOSTS_KEY = 'relay-hosts';

/** Подпись хоста длиннее не помещается в подсказку рейки. */
export const HOST_LABEL_MAX = 24;

export interface RemoteHost {
  /** Origin инсталляции: https://relay.example.com */
  url: string;
  /** Необязательная подпись; пусто — показываем hostname. */
  label?: string;
}

/**
 * Список из хранилища. Адрес проходит ту же `normalizeHostUrl`, что и
 * введённый руками: клик по строке рейки — `location.assign(url)`, и
 * `javascript:`, пролежавший в хранилище, исполнился бы на этом origin.
 */
export function loadHosts(): RemoteHost[] {
  const parsed = readStoredJson(HOSTS_KEY);
  if (!Array.isArray(parsed)) return [];
  const hosts: RemoteHost[] = [];
  for (const h of parsed) {
    if (!h || typeof h !== 'object') continue;
    const { url: raw, label } = h as { url?: unknown; label?: unknown };
    const url = typeof raw === 'string' ? normalizeHostUrl(raw) : null;
    if (!url) continue;
    hosts.push(typeof label === 'string' ? { url, label } : { url });
  }
  return hosts;
}

export function saveHosts(hosts: RemoteHost[]): void {
  writeStoredJson(HOSTS_KEY, hosts);
}

/**
 * Нормализуем и проверяем адрес: только http(s) с валидным хостом → origin
 * (путь отбрасываем). Мусор («два слова», чужая схема) отсекаем — иначе URL
 * молча percent-энкодит пробелы и пускает всё подряд. Та же логика, что в
 * чузере десктопа (clients/desktop/src/main.js normalize).
 */
export function normalizeHostUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  const withProto = hasScheme ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Хост — домен (метки букв/цифр/дефисов через точку), IPv6 в скобках или
  // одиночная метка (localhost). Пробелы/спецсимволы сюда уже не пройдут.
  const validHost =
    /^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;
  return validHost.test(u.hostname) ? u.origin : null;
}

/** Короткая подпись хоста: hostname без www (для тултипа и инициалов). */
export function hostLabel(host: RemoteHost): string {
  if (host.label?.trim()) return host.label.trim();
  try {
    return new URL(host.url).hostname.replace(/^www\./, '');
  } catch {
    return host.url;
  }
}

/** Этот хост — тот, где мы сейчас открыты? (его иконку подсвечиваем, не уводим) */
export function isCurrentHost(url: string): boolean {
  return typeof window !== 'undefined' && url === window.location.origin;
}

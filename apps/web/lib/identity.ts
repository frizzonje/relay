import { randomCallsign } from '@/lib/avatar';

/**
 * @-тег участника — свободный идентификатор, чтобы различать людей на сервере.
 * Никакой базы и пароля: живёт только в localStorage браузера. Выбирается один
 * раз после входа (IdentityGate), потом его можно сменить в панели пользователя.
 */
const TAG_KEY = 'relay-tag';
// Стабильный id браузера — не для показа, только чтобы сервер отличал перезаход
// того же устройства (лечит «двойника» после F5). Генерируем один раз.
const CID_KEY = 'relay-cid';

/** Приводим ввод к чистому тегу: убираем ведущий @, пробелы→дефис, режем мусор. */
export function sanitizeTag(raw: string): string {
  return raw
    .replace(/^@+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 20);
}

export function loadTag(): string {
  try {
    return (localStorage.getItem(TAG_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveTag(tag: string): void {
  try {
    localStorage.setItem(TAG_KEY, tag);
  } catch {
    /* приватный режим / заблокированное хранилище — молча живём без запоминания */
  }
}

/** Случайный тег-подсказка при первом выборе. */
export function suggestTag(): string {
  return sanitizeTag(randomCallsign());
}

/**
 * Стабильный id этого браузера (localStorage). Персональный на устройство, не
 * привязан к тегу/имени. Сервер по нему выгоняет прошлый сокет того же клиента,
 * оставшийся в голосовом после перезагрузки страницы, — чтобы не двоило.
 */
export function loadClientId(): string {
  try {
    let id = localStorage.getItem(CID_KEY) ?? '';
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(CID_KEY, id);
    }
    return id;
  } catch {
    // приватный режим — id на сессию, без персиста (двойник переживёт F5, но это край)
    return Math.random().toString(36).slice(2);
  }
}

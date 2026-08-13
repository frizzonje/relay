import { randomCallsign } from '@/lib/avatar';

/**
 * Имя гостя по инвайт-ссылке — и только его.
 *
 * Участники сервера с 1.0 зовутся ником своей личности: он живёт в базе, един
 * для всех устройств человека и меняется через сервер (stores/identity). Гость
 * личности не имеет и иметь не может — он не проходил ворота инсталляции, а
 * значит и челлендж ему подписывать нечем: сервер отвергнет его на первом же
 * запросе. Остаётся имя на один разговор, и живёт оно там же, где жило раньше:
 * в localStorage этого браузера.
 */
const TAG_KEY = 'relay-tag';
// Ключ остался прежним: гость, заходивший по прошлой ссылке, не должен
// перепредставляться из-за нашего переезда на личности.
// Стабильный id браузера — не для показа, только чтобы сервер отличал перезаход
// того же устройства (лечит «двойника» после F5). Генерируем один раз.
const CID_KEY = 'relay-cid';
// Запасной id, когда localStorage недоступен: один на загрузку страницы (см.
// loadClientId), а не новый на каждый вызов.
let ephemeralClientId = '';

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
    // Приватный режим / заблокированное хранилище: id живёт до перезагрузки
    // страницы. Но один и тот же — новый на каждый вызов означал бы, что после
    // любого реконнекта сокета человек перестаёт владеть тем, что сам сейчас
    // создал (владение считается по этому id, audit B2), и что «призрака» в
    // эфире больше не по чему выгнать. Переживать F5 без хранилища всё равно
    // нечем — это край, и он остаётся краем.
    ephemeralClientId ||= Math.random().toString(36).slice(2);
    return ephemeralClientId;
  }
}

/**
 * Адреса и маски — для списка закрытых адресов (`access.blockedAddresses`).
 *
 * Один разбор на обе стороны: каталог настроек (`validateSetting`) приводит
 * им записи к канонической форме — в браузере перед отправкой и на сервере
 * перед записью, — а api сверяет с теми же масками входящих (`addressBlocked`).
 * Обещания разбора сторожит тест «закрытые адреса» в settings.test.ts.
 *
 * Чем этот список НЕ является — важнее того, чем является. Он не защищает от
 * нагрузки: запрос всё равно доходит до Node, оплатив TLS, и инструмент против
 * потока — файрвол или прокси перед приложением. И он не запрещает человеку:
 * VPN и мобильный интернет обходят его за минуту. Настройка, от которой ждут
 * больше, чем она даёт, хуже отсутствующей, поэтому обе оговорки стоят и в
 * подсказке поля.
 */

/** Разобранная маска: адрес сети байтами (4 или 16) и длина префикса. */
interface AddressPrefix {
  bytes: number[];
  bits: number;
}

/**
 * Одна четвёрка IPv4. Ноль впереди отвергаем: `010` — это восемь в одних
 * разборщиках и десять в других, и маска, которую два участника пути понимают
 * по-разному, хуже отсутствующей.
 */
function parseV4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IPv6 со всеми законными сокращениями: `::` ровно одно, хвост в виде IPv4
 * (`::ffff:1.2.3.4`) — тоже форма записи, и именно ею Node называет
 * IPv4-клиента на двойном сокете. Не разбери мы её, маска `10.0.0.0/8` не
 * ловила бы `::ffff:10.1.2.3` — то есть выглядела бы работающей и не работала.
 */
function parseV6(text: string): number[] | null {
  let src = text;
  let tail: number[] = [];
  if (src.includes('.')) {
    const colon = src.lastIndexOf(':');
    if (colon < 0) return null;
    const v4 = parseV4(src.slice(colon + 1));
    if (!v4) return null;
    tail = v4;
    // Двоеточие оставляем и снимаем сами — но только если перед ним не «::»,
    // которое само по себе часть адреса.
    src = src.slice(0, colon + 1);
    if (!src.endsWith('::')) src = src.slice(0, -1);
  }
  const want = 8 - tail.length / 2;
  const gap = src.indexOf('::');
  if (gap >= 0 && src.indexOf('::', gap + 1) >= 0) return null;
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(split(gap < 0 ? src : src.slice(0, gap)));
  const rest = groupsOf(gap < 0 ? [] : split(src.slice(gap + 2)));
  if (!head || !rest) return null;
  let groups: number[];
  if (gap < 0) {
    if (head.length !== want) return null;
    groups = head;
  } else {
    // «::» обязано покрывать хотя бы одну группу — иначе это просто лишние
    // двоеточия, а не сокращение.
    if (head.length + rest.length >= want) return null;
    groups = [...head, ...new Array<number>(want - head.length - rest.length).fill(0), ...rest];
  }
  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  return [...bytes, ...tail];
}

function groupsOf(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    out.push(parseInt(part, 16));
  }
  return out;
}

/** Обёртка IPv4 в IPv6 — тот же самый IPv4, и считать его надо им. */
function v4Mapped(bytes: number[]): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Адрес любой из двух семей, в байтах. Обёрнутый IPv4 разворачивается. */
function parseAddress(text: string): number[] | null {
  const bytes = text.includes(':') ? parseV6(text) : parseV4(text);
  if (!bytes) return null;
  return v4Mapped(bytes) ? bytes.slice(12) : bytes;
}

/** Обнулить всё за маской: сеть — это сеть, а не адрес внутри неё. */
function maskBytes(bytes: number[], bits: number): number[] {
  return bytes.map((byte, index) => {
    const left = bits - index * 8;
    if (left >= 8) return byte;
    if (left <= 0) return 0;
    return byte & (0xff << (8 - left)) & 0xff;
  });
}

/**
 * Запись списка → маска. `null` — не адрес.
 *
 * Голый IPv6 разворачивается в `/64`, и это не вольность. Жильё раздаётся
 * блоком /64, а адрес внутри него меняется сам собой (RFC 4941): бан одного
 * `/128` перестал бы действовать через несколько минут, ничего об этом не
 * сказав. Голый IPv4 остаётся самим собой — там адрес выдают поштучно.
 */
function parsePrefix(text: string): AddressPrefix | null {
  const slash = text.indexOf('/');
  const bytes = parseAddress(slash < 0 ? text : text.slice(0, slash));
  if (!bytes) return null;
  let bits = bytes.length === 4 ? 32 : 64;
  if (slash >= 0) {
    const suffix = text.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(suffix)) return null;
    bits = Number(suffix);
    if (bits > bytes.length * 8) return null;
  }
  return { bytes: maskBytes(bytes, bits), bits };
}

/** Каноническая запись IPv6: строчные группы, самый длинный ноль — под «::». */
function textV6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let at = -1;
  let len = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j += 1;
    if (j - i > len) {
      at = i;
      len = j - i;
    }
    i = j;
  }
  const hex = (part: number[]) => part.map((group) => group.toString(16)).join(':');
  if (len < 2) return hex(groups);
  return `${hex(groups.slice(0, at))}::${hex(groups.slice(at + len))}`;
}

/**
 * Каноническая запись маски — то, что владелец увидит после сохранения.
 * `null`, если строка адресом не является.
 *
 * IPv4 без маски пишется голым (он и есть один адрес), IPv6 — всегда с
 * длиной: увидеть, во что развернулась запись, важнее краткости.
 */
export function normalizeAddressPrefix(text: string): string | null {
  const prefix = parsePrefix(text);
  if (!prefix) return null;
  if (prefix.bytes.length === 4) {
    return prefix.bits === 32 ? prefix.bytes.join('.') : `${prefix.bytes.join('.')}/${prefix.bits}`;
  }
  return `${textV6(prefix.bytes)}/${prefix.bits}`;
}

/**
 * Разобранные маски одного и того же списка. Список хранится замороженным и
 * меняется разве что раз в месяц, а спрашивают его на каждом рукопожатии и
 * каждом http-запросе — разбирать пятьсот строк заново каждый раз значило бы
 * платить за настройку тем самым, ради чего она заведена.
 */
const parsedLists = new WeakMap<readonly string[], AddressPrefix[]>();

function prefixesOf(list: readonly string[]): AddressPrefix[] {
  const known = parsedLists.get(list);
  if (known) return known;
  const parsed: AddressPrefix[] = [];
  // Непонятой строке здесь взяться неоткуда (в таблицу их не пускает
  // `validateSetting`), но если возьмётся — она просто никого не блокирует.
  for (const item of list) {
    const prefix = parsePrefix(item);
    if (prefix) parsed.push(prefix);
  }
  parsedLists.set(list, parsed);
  return parsed;
}

/**
 * Закрыт ли этот адрес списком владельца.
 *
 * Семьи не смешиваются: IPv4 не совпадает с IPv6-маской и наоборот. Иначе
 * `::/0`, написанный ради «закрыть всё в шестой версии», закрыл бы заодно и
 * четвёртую — то есть инсталляцию целиком.
 */
export function addressBlocked(list: readonly string[], address: string): boolean {
  if (list.length === 0) return false;
  const probe = parseAddress(address);
  if (!probe) return false;
  for (const prefix of prefixesOf(list)) {
    if (prefix.bytes.length !== probe.length) continue;
    if (sameNetwork(prefix, probe)) return true;
  }
  return false;
}

function sameNetwork(prefix: AddressPrefix, probe: number[]): boolean {
  const masked = maskBytes(probe, prefix.bits);
  return masked.every((byte, index) => byte === prefix.bytes[index]);
}

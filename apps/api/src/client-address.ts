import { normalizeAddressPrefix } from '@relay/shared';

/**
 * Откуда пришёл клиент — для масок закрытых адресов, логов и счётчиков.
 *
 * Два вопроса, и путать их нельзя. «Какой адрес» — для масок и строчки в логе:
 * там нужен адрес как есть. «Чья это сеть» — для всего, что СЧИТАЕТ попытки:
 * счётчик по голому IPv6 не считает ничего, потому что абонент держит целый
 * блок /64 и меняет адрес внутри него сам собой (RFC 4941) — а злоумышленник
 * меняет его на каждую попытку.
 */

/**
 * Адрес клиента. `trust proxy: 1` в main.ts означает: доверяем ровно одному
 * хопу (нашему Caddy), то есть берём ПОСЛЕДНЮЮ запись X-Forwarded-For — ту,
 * которую подставил он. Первая запись — то, что написал клиент, и вязать
 * ограничения к ней значит не иметь ограничений вовсе.
 */
export function clientIp(handshake: {
  headers: Record<string, string | string[] | undefined>;
  address?: string;
}): string {
  const raw = handshake.headers['x-forwarded-for'];
  const line = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof line === 'string') {
    const parts = line.split(',');
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return handshake.address || 'unknown';
}

/**
 * Сеть абонента — ключ всех счётчиков «по адресу»: неудачные пароли, частота
 * входа, бюджет загрузок, выгнанный гость. IPv4 остаётся самим собой (его
 * выдают поштучно), IPv6 сводится к своему /64 — тем же правилом, каким
 * разворачивается голый IPv6 в списке закрытых адресов (`net.ts` в shared).
 * Не адрес вовсе (`unknown`) — возвращается как есть.
 */
export function networkOf(ip: string): string {
  return normalizeAddressPrefix(ip) ?? ip;
}

/** То же для http-запроса: `req.ip` уже учёл `trust proxy` (см. `clientIp`). */
export function requestNetwork(req: { ip?: string }): string {
  return networkOf(req.ip ?? 'unknown');
}

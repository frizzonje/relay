import { Logger } from '@nestjs/common';
import { sfuConfigured } from './sfu-token';

/**
 * Живость медиасервера, а не только наличие env: sfuConfigured() отвечает
 * «должен быть», health-пинг — «есть на самом деле». Без него api раздаёт
 * пропуска в лежащий контейнер, и каждый клиент открывает это сам — таймаутом
 * на входе в звонок, а на 4+ участниках ещё и вечным циклом ретраев с тостами.
 *
 * Кэш короткий и общий на все запросы: клиентские ретраи идут раз в 5 секунд,
 * чаще спрашивать медиасервер незачем, а один пинг на всех — дёшево.
 */

const CACHE_MS = 5000;
const PING_TIMEOUT_MS = 1500;

const logger = new Logger('SfuHealth');
let last: { ts: number; ok: boolean } | null = null;

function healthUrl(): string {
  // Отдельная переменная, не SFU_URL: та — публичный адрес для клиента (обычно
  // `/` за Caddy), а сюда нужен внутренний, докуда api дотянется напрямую.
  const base = (process.env.SFU_INTERNAL_URL ?? 'http://sfu:3100').trim().replace(/\/+$/, '');
  return `${base}/health`;
}

export async function sfuHealthy(): Promise<boolean> {
  if (!sfuConfigured()) return false;
  const now = Date.now();
  if (last && now - last.ts < CACHE_MS) return last.ok;
  let ok = false;
  try {
    const res = await fetch(healthUrl(), { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  // В лог — только переходы: это ровно те моменты, когда звонки начинают или
  // перестают собираться через сервер. Каждый пинг логировать — шум.
  if (!last || last.ok !== ok) {
    if (ok) logger.log(`sfu is up (${healthUrl()})`);
    else logger.warn(`sfu is down (${healthUrl()}) — no passes issued, calls fall back to p2p`);
  }
  last = { ts: now, ok };
  return ok;
}

import { createHmac } from 'node:crypto';

/**
 * Выдача пропуска в медиасервер. Проверяющий близнец — apps/sfu/src/token.ts,
 * формат обязан совпадать байт-в-байт.
 *
 * Токен: `s1.<base64url(JSON claims)>.<HMAC-SHA256(ключ, префикс)>`,
 * ключ = 'relay-sfu-v1:' + SFU_SECRET.
 *
 * Выдаём его по сокету, а не отдельным HTTP-эндпоинтом: сигналинг уже знает,
 * кто ты (пропуск или гостевой токен), в какой ты комнате и какой у тебя id —
 * значит и `room`, и `peerId` берутся из состояния сокета, а не из запроса.
 * Подделать чужой peerId или напроситься в чужую комнату так нельзя в принципе.
 */

const KEY_PREFIX = 'relay-sfu-v1:';

// Короткий срок: токен нужен ровно на момент подключения к /sfu.
const SFU_TOKEN_TTL_MS = 60 * 1000;

export function sfuSecret(): string {
  return process.env.SFU_SECRET ?? '';
}

/** Медиасервер настроен, если есть и адрес для клиента, и общий секрет. */
export function sfuConfigured(): boolean {
  return !!(process.env.SFU_URL ?? '').trim() && !!sfuSecret();
}

export function issueSfuToken(claims: { room: string; peerId: string; name: string }): {
  token: string;
  exp: number;
} {
  const exp = Date.now() + SFU_TOKEN_TTL_MS;
  const body = Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8').toString('base64url');
  const prefix = `s1.${body}`;
  const sig = createHmac('sha256', KEY_PREFIX + sfuSecret())
    .update(prefix)
    .digest('base64url');
  return { token: `${prefix}.${sig}`, exp };
}

import { createHmac } from 'node:crypto';
import { SFU_KEY_CONTEXT, sfuTokenSigned } from '@relay/shared';

/**
 * Выдача пропуска в медиасервер. Формат — `sfuTokenSigned` в `@relay/shared`,
 * его же разбирает медиасервер (`apps/sfu/src/token.ts`); здесь только ключ и
 * подпись.
 *
 * Выдаём его по сокету, а не отдельным HTTP-эндпоинтом: сигналинг уже знает,
 * кто ты (пропуск или гостевой токен), в какой ты комнате и какой у тебя id —
 * значит и `room`, и `peerId` берутся из состояния сокета, а не из запроса.
 * Подделать чужой peerId или напроситься в чужую комнату так нельзя в принципе.
 */

// Короткий срок: токен нужен ровно на момент подключения к /sfu.
const SFU_TOKEN_TTL_MS = 60 * 1000;

export function sfuSecret(): string {
  return process.env.SFU_SECRET ?? '';
}

/** Медиасервер настроен, если есть и адрес для клиента, и общий секрет. */
export function sfuConfigured(): boolean {
  return !!(process.env.SFU_URL ?? '').trim() && !!sfuSecret();
}

export function issueSfuToken({
  room,
  peerId,
  name,
  listen,
}: {
  room: string;
  peerId: string;
  name: string;
  /** Слушатель: пропуск на приём, но не на отдачу — медиасервер откажет в produce. */
  listen?: boolean;
}): {
  token: string;
  exp: number;
} {
  const exp = Date.now() + SFU_TOKEN_TTL_MS;
  const signed = sfuTokenSigned({ room, peerId, name, listen: !!listen, exp });
  const sig = createHmac('sha256', SFU_KEY_CONTEXT + sfuSecret())
    .update(signed)
    .digest('base64url');
  return { token: `${signed}.${sig}`, exp };
}

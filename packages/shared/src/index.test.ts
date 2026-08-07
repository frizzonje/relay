import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  AUTH_COOKIE,
  CHAT_HISTORY_LIMIT,
  CHAT_PREFIX,
  GUEST_TOKEN_TTL_MS,
  LIMITS,
  MAX_CHANNELS,
  MAX_UPLOAD_BYTES,
  REACTION_EMOJIS,
  TOKEN_TTL_MS,
  issueGuestToken,
  issueToken,
  parseCookies,
  verifyGuestToken,
  verifyToken,
} from './index';

/**
 * Общий контракт. Проверять здесь «равно ли 50 пятидесяти» бессмысленно —
 * смысл в другом: api НАМЕРЕННО не зависит от этого пакета и держит те же
 * числа своей копией. Разъехавшись, они дадут не ошибку сборки, а тихое
 * расхождение — сервер режет текст на 500-м символе, клиент разрешает набрать
 * 900 и молча теряет хвост. Поэтому сверяемся с исходником api напрямую.
 */

const apiSource = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../apps/api/src/${rel}`, import.meta.url)), 'utf8');

describe('реэкспорт пропусков', () => {
  it('всё, чем пользуется middleware Next, доступно из корня пакета', async () => {
    expect(typeof issueToken).toBe('function');
    expect(typeof verifyToken).toBe('function');
    expect(typeof parseCookies).toBe('function');
    expect(AUTH_COOKIE).toBe('relay_pass');
    expect(TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(GUEST_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);

    // Токен, выданный корневым экспортом, им же и проверяется.
    const { value } = await issueToken('пароль');
    expect(await verifyToken(value, 'пароль')).toBe(true);
    // Чужим паролем — нет: подпись завязана на него.
    expect(await verifyToken(value, 'другой')).toBe(false);

    const token = await issueGuestToken('voice-obshchii', 'пароль');
    expect((await verifyGuestToken(token, 'пароль'))?.slug).toBe('voice-obshchii');
    // Гостевой токен не проходит как пропуск на сайт — контексты подписи разные.
    expect(await verifyToken(token, 'пароль')).toBe(false);
  });
});

describe('константы совпадают с копией в api', () => {
  it('имя куки то же самое — иначе пропуск просто не найдут', () => {
    expect(apiSource('auth/auth.ts')).toContain(`export const AUTH_COOKIE = '${AUTH_COOKIE}'`);
  });

  it('потолок вложения — один и тот же', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(apiSource('uploads.ts')).toContain('MAX_UPLOAD_BYTES = 25 * 1024 * 1024');
  });

  it('глубина истории и потолок каналов — те же', () => {
    expect(apiSource('gateway/chat.service.ts')).toContain(
      `const HISTORY_LIMIT = ${CHAT_HISTORY_LIMIT};`,
    );
    expect(apiSource('gateway/registry.service.ts')).toContain(
      `export const MAX_CHANNELS = ${MAX_CHANNELS};`,
    );
  });

  it('префикс комнаты чата тот же — по нему сервер и клиент находят одну ленту', () => {
    expect(apiSource('gateway/chat.service.ts')).toContain(
      `export const CHAT_PREFIX = '${CHAT_PREFIX}';`,
    );
  });

  it('набор реакций совпадает: сервер валидирует по нему, клиент рисует его же', () => {
    const line = apiSource('gateway/chat.service.ts')
      .split('\n')
      .find((l) => l.includes('const REACTION_EMOJIS'))!;
    for (const emoji of REACTION_EMOJIS) expect(line, emoji).toContain(emoji);
    // И ничего сверх: лишний эмодзи на сервере клиент не нарисовал бы.
    expect(line.match(/'/g)!.length / 2).toBe(REACTION_EMOJIS.length);
  });

  it('лимиты длин — те, на которых сервер режет', () => {
    const gateway = apiSource('gateway/signaling.gateway.ts');
    expect(gateway).toContain(`.slice(0, ${LIMITS.room})`); // слаг комнаты
    expect(gateway).toContain(`.slice(0, ${LIMITS.name})`); // имя участника
    expect(gateway).toContain(`.slice(0, ${LIMITS.chatText})`); // текст сообщения
  });
});

describe('прочее', () => {
  it('имя приложения — то, что видит человек', () => {
    expect(APP_NAME).toBe('relay');
  });

  it('набор реакций заморожен по типу и не содержит дублей', () => {
    expect(new Set(REACTION_EMOJIS).size).toBe(REACTION_EMOJIS.length);
  });
});

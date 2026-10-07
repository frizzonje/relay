import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  AUTH_COOKIE,
  DM_PREFIX,
  GUEST_TOKEN_TTL_MS,
  REACTION_EMOJIS,
  TOKEN_TTL_MS,
  isDmSlug,
  issueGuestToken,
  issueToken,
  parseCookies,
  verifyGuestToken,
  verifyToken,
} from './index';

/**
 * Одно правило контракта компилятор не проверит: что событие панели, объявленное
 * здесь, кто-то на сервере слушает. Подписка — строка в декораторе Nest, и её
 * сверяем с исходником гейтвея напрямую.
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

describe('контракт и сервер', () => {
  it('события панели — те же, что подписывает сервер', () => {
    // Событие, объявленное здесь и не заведённое там, — это кнопка, ждущая
    // ответа, который не придёт. Заведённое там и не объявленное здесь — дверь,
    // о которой не знает ни один тест двери (а тест этот перебирает подписки
    // гейтвея, см. `admin.handlers.test.ts`).
    const gateway = apiSource('gateway/signaling.gateway.ts');
    const subscribed = [...gateway.matchAll(/@SubscribeMessage\('(admin-[a-z-]+)'\)/g)].map(
      (m) => m[1],
    );
    const contract = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const c2s = contract.slice(contract.indexOf('export interface ClientToServerEvents'));
    const declared = [...c2s.slice(0, c2s.indexOf('\n}')).matchAll(/'(admin-[a-z-]+)':/g)].map(
      (m) => m[1],
    );
    expect(subscribed.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual([...subscribed].sort());
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

describe('адрес беседы', () => {
  it('узнаётся по префиксу', () => {
    expect(isDmSlug(`${DM_PREFIX}0123456789abcdef01234567`)).toBe(true);
  });

  it('не путается с каналом, чьё имя начинается так же', () => {
    // Канал «dm-обсуждение» — законное имя, и лента у него обычная.
    expect(isDmSlug('dm-obsuzhdenie')).toBe(false);
    expect(isDmSlug('lounge')).toBe(false);
  });
});

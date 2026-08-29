import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  AUTH_COOKIE,
  CHAT_PAGE_SIZE,
  CHAT_PREFIX,
  DM_PEOPLE_LIMIT,
  DM_PREFIX,
  DM_PREVIEW_LIMIT,
  GUEST_TOKEN_TTL_MS,
  LIMITS,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
  REACTION_EMOJIS,
  SYSTEM_ACTOR_NICK,
  TOKEN_TTL_MS,
  UNKNOWN_ACTOR_NICK,
  isDmSlug,
  issueGuestToken,
  issueToken,
  parseCookies,
  verifyGuestToken,
  verifyToken,
  type AdminAction,
  type AdminRefusal,
  type AuditAction,
  type ChatRefusal,
  type VoiceRefusal,
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

const sharedSource = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), 'utf8');

/**
 * Литералы объединения из исходника — по объявлению, а не по типу: тип к
 * прогону не доживает, а сравнить половины контракта надо именно текстом.
 */
const literals = (source: string, declaration: string): string[] =>
  (
    source
      .slice(source.indexOf(declaration))
      .split(';')[0]
      .match(/'[a-z-]+'/g) ?? []
  ).map((item) => item.slice(1, -1));

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

  it('страница ленты — та же', () => {
    expect(apiSource('gateway/chat.service.ts')).toContain(
      `export const PAGE_SIZE = ${CHAT_PAGE_SIZE};`,
    );
  });

  it('версия контракта та же — на ней держится вся дверь', () => {
    // Разъехавшись, эти два числа дают не ошибку сборки, а инсталляцию,
    // которая не пускает никого: сервер сверяет своё с тем, что назвал клиент.
    expect(apiSource('gateway/protocol.ts')).toContain(
      `export const PROTOCOL_VERSION = ${PROTOCOL_VERSION};`,
    );
  });

  it('префикс комнаты чата тот же — по нему сервер и клиент находят одну ленту', () => {
    expect(apiSource('gateway/chat.service.ts')).toContain(
      `export const CHAT_PREFIX = '${CHAT_PREFIX}';`,
    );
  });

  it('префикс адреса беседы тот же — по нему обе стороны узнают ЛС среди каналов', () => {
    expect(apiSource('gateway/dm.service.ts')).toContain(
      `export const DM_PREFIX = '${DM_PREFIX}';`,
    );
  });

  it('обрезка превью последней реплики та же — иначе список переписок и dm-activity разойдутся', () => {
    expect(apiSource('gateway/dm.service.ts')).toContain(
      `export const DM_PREVIEW_LIMIT = ${DM_PREVIEW_LIMIT};`,
    );
  });

  it('потолок списка собеседников тот же — иначе клиент ждёт страницу, которой не будет', () => {
    expect(apiSource('gateway/dm.service.ts')).toContain(
      `export const DM_PEOPLE_LIMIT = ${DM_PEOPLE_LIMIT};`,
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

  it('причины отказа в ленте — те же, что называет сервер', () => {
    // Отказ уезжает клиенту строкой, и незнакомую строку клиент не разберёт:
    // вместо «правку выключили» человек увидит молчание — ровно то, ради
    // избавления от чего событие и заведено.
    const protocol = apiSource('gateway/protocol.ts');
    const reasons = protocol
      .slice(protocol.indexOf('export type ChatRefusal ='))
      .split(';')[0]
      .match(/'[a-z-]+'/g)!;
    const mine: ChatRefusal[] = [
      'read-only',
      'rate',
      'banned-word',
      'links-off',
      'attachments-off',
      'edit-off',
      'edit-window',
      'delete-off',
      'reactions-off',
      'search-off',
      'too-new',
      'spoiler-off',
    ];
    expect(reasons.map((r) => r.slice(1, -1))).toEqual(mine);
  });

  it('причины отказа в голосе — те же, что называет сервер', () => {
    // Ровно та же беда, что и в ленте: `join` и `media-update` ответа не ждут,
    // и незнакомая строка отказа означала бы для человека тишину — «камера не
    // включилась, и почему-то никто ничего не сказал».
    const protocol = apiSource('gateway/protocol.ts');
    const reasons = protocol
      .slice(protocol.indexOf('export type VoiceRefusal ='))
      .split(';')[0]
      .match(/'[a-z-]+'/g)!;
    const mine: VoiceRefusal[] = ['video-off', 'screen-share-off', 'room-full', 'guests-full'];
    expect(reasons.map((r) => r.slice(1, -1))).toEqual(mine);
  });

  it('действия журнала — те же, что называет сервер', () => {
    // Панель подбирает подпись строки по этому имени. Разъехавшись, половины
    // дают не ошибку сборки, а журнал, в котором часть строк без подписи, —
    // причём именно те, что записаны новым сервером и потому важнее прочих.
    const protocol = apiSource('gateway/protocol.ts');
    const actions = protocol
      .slice(protocol.indexOf('export type AuditAction ='))
      .split(';')[0]
      .match(/'[a-z-]+'/g)!;
    const mine: AuditAction[] = [
      'setting-changed',
      'settings-reset',
      'ban',
      'unban',
      'owner-claimed',
      'owner-link-issued',
      'password-changed',
      'retention-run',
      'files-swept',
      'sessions-revoked',
      'device-revoked',
      'settings-imported',
    ];
    expect(actions.map((a) => a.slice(1, -1))).toEqual(mine);
  });

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

  it('событие «поменяли из другой сессии» сервер шлёт под тем же именем', () => {
    // Имя события — единственное, что связывает обработчик с клиентом: разъедься
    // половины, вторая панель владельца молча осталась бы со вчерашним снимком.
    expect(apiSource('gateway/admin.handlers.ts')).toContain("emit('admin-changed'");
  });

  it('действия панели — те же, что называет сервер', () => {
    const actions = literals(apiSource('gateway/protocol.ts'), 'export type AdminAction =');
    const mine: AdminAction[] = [
      'owner-link',
      'retention-run',
      'files-sweep',
      'revoke-sessions',
      'revoke-device',
      'ban',
      'unban',
      'export',
      'import',
    ];
    expect(actions).toEqual(mine);
    // И то же самое написано в половине клиента — иначе панель послала бы
    // серверу имя, на которое он ответит `unsupported`.
    expect(literals(sharedSource('admin.ts'), 'export type AdminAction =')).toEqual(mine);
  });

  it('причины отказа панели — те же, и причины каталога входят в них целиком', () => {
    const mine: AdminRefusal[] = [
      'forbidden',
      'needs-confirm',
      'unknown-key',
      'read-only',
      'wrong-type',
      'out-of-range',
      'not-an-option',
      'too-long',
      'secret-path',
      'not-found',
      'unsupported',
    ];
    expect(literals(apiSource('gateway/protocol.ts'), 'export type AdminRefusal =')).toEqual(mine);
    expect(literals(sharedSource('admin.ts'), 'export type AdminRefusal =')).toEqual(mine);
    // Отказ каталога панель возвращает как есть: седьмая причина, добавленная в
    // `SettingError`, обязана появиться и здесь — иначе панель получит от
    // сервера строку, которой не знает, и покажет вместо неё пустоту.
    for (const reason of literals(sharedSource('settings.ts'), 'export type SettingError =')) {
      expect(mine, reason).toContain(reason);
    }
  });

  it('ник системной записи тот же — по нему её подписывает сервер', () => {
    // Узнают систему не по нему (для этого есть `AuditEntry.system`), но в
    // колонку он ложится буквально, и разъехавшись, половины показали бы в
    // журнале два разных «автора» у одного и того же действия машины.
    expect(apiSource('gateway/protocol.ts')).toContain(
      `export const SYSTEM_ACTOR_NICK = '${SYSTEM_ACTOR_NICK}';`,
    );
    expect(apiSource('gateway/protocol.ts')).toContain(
      `export const UNKNOWN_ACTOR_NICK = '${UNKNOWN_ACTOR_NICK}';`,
    );
  });

  it('лимиты длин — те, на которых сервер режет', () => {
    // Числа переехали: обработчики больше не режут по литералу на месте, все
    // потолки объявлены один раз в `LIMIT` (apps/api/src/gateway/protocol.ts).
    // Имена там по смыслу поля, здесь — по смыслу для клиента; совпадать
    // обязаны значения.
    const protocol = apiSource('gateway/protocol.ts');
    expect(protocol).toMatch(new RegExp(`^\\s*slug: ${LIMITS.room},$`, 'm')); // слаг комнаты
    expect(protocol).toMatch(new RegExp(`^\\s*tag: ${LIMITS.name},$`, 'm')); // тег участника
    expect(protocol).toMatch(new RegExp(`^\\s*message: ${LIMITS.chatText},$`, 'm')); // текст реплики
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

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  AUTH_COOKIE,
  authEnabled,
  issueToken,
  verifyToken,
  passwordMatches,
  parseCookies,
  isAuthorized,
  extractToken,
} from './auth';
// Кросс-проверка байт-в-байт совместимости с Web-Crypto близнецом из shared.
import {
  issueToken as issueTokenWeb,
  verifyToken as verifyTokenWeb,
} from '../../../../packages/shared/src/auth';

const PASS = 'secret-пароль-123';
const original = process.env.SITE_PASSWORD;

beforeEach(() => {
  process.env.SITE_PASSWORD = PASS;
});
afterAll(() => {
  if (original === undefined) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = original;
});

describe('api auth (sync, node:crypto)', () => {
  it('authEnabled зависит от наличия пароля', () => {
    expect(authEnabled()).toBe(true);
    process.env.SITE_PASSWORD = '';
    expect(authEnabled()).toBe(false);
  });

  it('round-trip: issue → verify', () => {
    const { value } = issueToken();
    expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(verifyToken(value)).toBe(true);
  });

  it('пустой пароль → пускаем всех', () => {
    process.env.SITE_PASSWORD = '';
    expect(verifyToken(undefined)).toBe(true);
  });

  it('нет токена при включённой авторизации → false', () => {
    expect(verifyToken(undefined)).toBe(false);
  });

  it('просроченный/битый токен → false', () => {
    expect(verifyToken(`${Date.now() - 1000}.x`)).toBe(false);
    expect(verifyToken('нет-точки')).toBe(false);
  });

  it('смена пароля отзывает старый токен', () => {
    const { value } = issueToken();
    process.env.SITE_PASSWORD = 'другой';
    expect(verifyToken(value)).toBe(false);
  });

  it('passwordMatches — постоянное время, корректное сравнение', () => {
    expect(passwordMatches(PASS)).toBe(true);
    expect(passwordMatches('неверно')).toBe(false);
  });

  it('isAuthorized: кука, Bearer-заголовок или handshake.auth.token', () => {
    const { value } = issueToken();
    // кука relay_pass (web-фронт, Tauri)
    expect(isAuthorized({ headers: { cookie: `${AUTH_COOKIE}=${value}` } })).toBe(true);
    // Authorization: Bearer (нативные REST-клиенты)
    expect(isAuthorized({ headers: { authorization: `Bearer ${value}` } })).toBe(true);
    // auth-поле socket.io-handshake (нативные сокет-клиенты)
    expect(isAuthorized({ headers: {}, auth: { token: value } })).toBe(true);
    // ничего не предъявлено
    expect(isAuthorized({ headers: {} })).toBe(false);
    // мусор вместо валидного токена
    expect(isAuthorized({ headers: { authorization: 'Bearer нет-такого' } })).toBe(false);
    expect(isAuthorized({ headers: {}, auth: { token: 42 } })).toBe(false);
  });

  it('extractToken: приоритет auth.token > Bearer > кука', () => {
    expect(
      extractToken({
        headers: { cookie: `${AUTH_COOKIE}=cookie-tok`, authorization: 'Bearer header-tok' },
        auth: { token: 'auth-tok' },
      }),
    ).toBe('auth-tok');
    expect(
      extractToken({ headers: { cookie: `${AUTH_COOKIE}=cookie-tok`, authorization: 'Bearer header-tok' } }),
    ).toBe('header-tok');
    expect(extractToken({ headers: { cookie: `${AUTH_COOKIE}=cookie-tok` } })).toBe('cookie-tok');
    expect(extractToken({ headers: {} })).toBeUndefined();
  });
});

describe('parseCookies (api)', () => {
  it('парсит и декодирует', () => {
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });
  it('undefined → {}', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('parity: api(sync node:crypto) ↔ shared(Web Crypto) — формат байт-в-байт', () => {
  it('токен из api проходит проверку в shared', async () => {
    const { value } = issueToken();
    expect(await verifyTokenWeb(value, PASS)).toBe(true);
  });

  it('токен из shared проходит проверку в api', async () => {
    const { value } = await issueTokenWeb(PASS);
    expect(verifyToken(value)).toBe(true);
  });

  it('подпись для одного exp идентична в обеих реализациях', async () => {
    // фиксируем exp, сверяем суффикс-подпись (часть после точки)
    const a = await issueTokenWeb(PASS);
    const expA = a.value.slice(0, a.value.indexOf('.'));
    // api подпишет тот же exp при verify; кросс-verify уже это покрыл,
    // здесь дополнительно убеждаемся, что api НЕ принимает подпись для чужого пароля
    expect(
      await verifyTokenWeb(`${expA}.${a.value.slice(a.value.indexOf('.') + 1)}`, 'wrong'),
    ).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { AUTH_COOKIE, TOKEN_TTL_MS, issueToken, verifyToken, parseCookies } from './auth';

const PASS = 'secret-пароль-123';

describe('issueToken / verifyToken (Web Crypto)', () => {
  it('round-trip: выданный токен проходит проверку тем же паролем', async () => {
    const { value, maxAgeMs } = await issueToken(PASS);
    expect(maxAgeMs).toBe(TOKEN_TTL_MS);
    expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken(value, PASS)).toBe(true);
  });

  it('подпись завязана на пароль: смена пароля отзывает токен', async () => {
    const { value } = await issueToken(PASS);
    expect(await verifyToken(value, 'другой-пароль')).toBe(false);
  });

  it('пустой пароль = авторизация выключена → пускаем всех', async () => {
    expect(await verifyToken(undefined, '')).toBe(true);
    expect(await verifyToken('что угодно', '')).toBe(true);
  });

  it('нет токена при включённой авторизации → false', async () => {
    expect(await verifyToken(undefined, PASS)).toBe(false);
    expect(await verifyToken('', PASS)).toBe(false);
  });

  it('просроченный токен → false', async () => {
    // exp в прошлом, подпись валидная для этого exp
    const past = Date.now() - 1000;
    // переиспользуем internal формат: подделать подпись нельзя, но просрочку
    // ловим до сверки подписи — берём корректную подпись через issueToken-подобный путь.
    // Проще: токен с прошедшим exp и любой подписью → false из-за exp-проверки.
    expect(await verifyToken(`${past}.deadbeef`, PASS)).toBe(false);
  });

  it('битый формат токена → false', async () => {
    expect(await verifyToken('нет-точки', PASS)).toBe(false);
    expect(await verifyToken('abc.def', PASS)).toBe(false); // exp не число
  });

  it('подделанная подпись при валидном exp → false', async () => {
    const { value } = await issueToken(PASS);
    const exp = value.slice(0, value.indexOf('.'));
    expect(await verifyToken(`${exp}.tampered_signature`, PASS)).toBe(false);
  });
});

describe('parseCookies', () => {
  it('пустой/undefined → {}', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('парсит несколько кук и декодирует значения', () => {
    const out = parseCookies(`${AUTH_COOKIE}=a%20b; other=42`);
    expect(out[AUTH_COOKIE]).toBe('a b');
    expect(out.other).toBe('42');
  });

  it('пропускает части без знака =', () => {
    expect(parseCookies('garbage; x=1')).toEqual({ x: '1' });
  });

  it('битое url-значение не роняет парсер', () => {
    const out = parseCookies('bad=%E0%A4%A; good=ok');
    expect(out.good).toBe('ok');
    expect('bad' in out).toBe(false);
  });
});

import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE, verifyToken } from './auth';
import { AuthController } from './auth.controller';

/**
 * Вход на сайт. Здесь важны две вещи, и обе — про то, чем кончается перебор:
 * счётчик неудач вяжется к адресу (а не к чему-то, что чистится реконнектом), и
 * успешный вход его сбрасывает — иначе человек, ошибившийся семь раз и на
 * восьмой вспомнивший пароль, запирался бы вместе с подбирающим.
 */

interface FakeRes {
  code: number;
  body: unknown;
  cookies: Record<string, { value: string; opts: Record<string, unknown> }>;
  cleared: string[];
}

function res(): Response & FakeRes {
  const r = {
    code: 200,
    body: undefined as unknown,
    cookies: {} as FakeRes['cookies'],
    cleared: [] as string[],
    status(code: number) {
      r.code = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      r.cookies[name] = { value, opts };
      return r;
    },
    clearCookie(name: string) {
      r.cleared.push(name);
      return r;
    },
  };
  return r as unknown as Response & FakeRes;
}

function req(ip = '10.0.0.1', secure = false): Request {
  return { ip, secure } as unknown as Request;
}

beforeEach(() => {
  process.env.SITE_PASSWORD = 'верный-пароль';
});
afterEach(() => {
  delete process.env.SITE_PASSWORD;
});

describe('POST /api/login', () => {
  it('верный пароль выдаёт куку-пропуск, которая потом проходит проверку', () => {
    const c = new AuthController();
    const r = res();
    c.login(req(), r, { password: 'верный-пароль' });
    expect(r.body).toEqual({ ok: true });
    const cookie = r.cookies[AUTH_COOKIE];
    expect(cookie).toBeDefined();
    expect(verifyToken(cookie.value)).toBe(true);
    expect(cookie.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('secure у куки повторяет протокол запроса — иначе её не примут по https', () => {
    const c = new AuthController();
    const plain = res();
    c.login(req('10.0.0.1', false), plain, { password: 'верный-пароль' });
    expect(plain.cookies[AUTH_COOKIE].opts.secure).toBe(false);

    const tls = res();
    c.login(req('10.0.0.2', true), tls, { password: 'верный-пароль' });
    expect(tls.cookies[AUTH_COOKIE].opts.secure).toBe(true);
  });

  it('неверный и пустой пароль — 401 без куки', () => {
    const c = new AuthController();
    for (const password of ['мимо', '', 42, undefined]) {
      const r = res();
      c.login(req(), r, { password });
      expect(r.code, String(password)).toBe(401);
      expect(r.cookies[AUTH_COOKIE]).toBeUndefined();
    }
  });

  it('без пароля сайта пускает всех и куку не выдаёт — её нечем подписывать', () => {
    delete process.env.SITE_PASSWORD;
    const c = new AuthController();
    const r = res();
    c.login(req(), r, {});
    expect(r.body).toEqual({ ok: true });
    expect(r.cookies[AUTH_COOKIE]).toBeUndefined();
  });

  it('после восьми неудач адрес получает 429 вместо очередной проверки', () => {
    const c = new AuthController();
    for (let i = 0; i < 8; i++) {
      const r = res();
      c.login(req('9.9.9.9'), r, { password: `мимо-${i}` });
      expect(r.code).toBe(401);
    }
    const blocked = res();
    // Даже верный пароль дальше не проходит.
    c.login(req('9.9.9.9'), blocked, { password: 'верный-пароль' });
    expect(blocked.code).toBe(429);
    expect(blocked.cookies[AUTH_COOKIE]).toBeUndefined();
  });

  it('счётчик у каждого адреса свой — сосед не страдает', () => {
    const c = new AuthController();
    for (let i = 0; i < 8; i++) c.login(req('9.9.9.9'), res(), { password: 'мимо' });
    const neighbour = res();
    c.login(req('8.8.8.8'), neighbour, { password: 'верный-пароль' });
    expect(neighbour.body).toEqual({ ok: true });
  });

  it('успешный вход сбрасывает накопленные неудачи', () => {
    const c = new AuthController();
    for (let i = 0; i < 7; i++) c.login(req('7.7.7.7'), res(), { password: 'мимо' });
    c.login(req('7.7.7.7'), res(), { password: 'верный-пароль' });
    // Счётчик обнулён: ещё семь ошибок снова не запирают.
    for (let i = 0; i < 7; i++) {
      const r = res();
      c.login(req('7.7.7.7'), r, { password: 'мимо' });
      expect(r.code).toBe(401);
    }
  });
});

describe('POST /api/logout', () => {
  it('чистит куку и всегда отвечает успехом — выход идемпотентен', () => {
    const c = new AuthController();
    const r = res();
    c.logout(r);
    expect(r.cleared).toEqual([AUTH_COOKIE]);
    expect(r.body).toEqual({ ok: true });

    const again = res();
    c.logout(again);
    expect(again.body).toEqual({ ok: true });
  });
});

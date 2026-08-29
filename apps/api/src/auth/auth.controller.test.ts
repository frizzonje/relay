import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { resetDatabase, testDatabase } from '../db/testing';
import { SettingsService } from '../settings/settings.service';
import { freshSettings, tune } from '../settings/settings.testkit';
import { AUTH_COOKIE, verifyToken } from './auth';
import { AuthController } from './auth.controller';

/**
 * Вход на сайт. Здесь важны две вещи, и обе — про то, чем кончается перебор:
 * счётчик неудач вяжется к адресу (а не к чему-то, что чистится реконнектом), и
 * успешный вход его сбрасывает — иначе человек, ошибившийся семь раз и на
 * восьмой вспомнивший пароль, запирался бы вместе с подбирающим.
 *
 * Счётчиков у двери с этапа C два, и они про разное: неудачи за десять минут
 * ловят подбор, а попытки за минуту (`access.loginRatePerMinute`) ужимают поток
 * запросов независимо от исхода. Второй по умолчанию выключен — сегодня попытки
 * не считает никто.
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

let db: DataSource;

beforeAll(async () => {
  db = await testDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

/**
 * Контроллер со своим счётчиком попыток. Настройки настоящие, но не
 * загруженные: без переопределений `get` отвечает умолчаниями каталога, то есть
 * ровно тем порогом, с которым relay жил всегда. База такому сервису не нужна —
 * он ни разу в неё не ходит.
 */
function controller(): AuthController {
  return new AuthController(new SettingsService(undefined as unknown as DataSource));
}

/**
 * Контроллер с открытой панелью. Здесь база уже нужна: правку настройки
 * записывает и перечитывает настоящий `SettingsService` — подделка ответила бы
 * заданным числом на ключ, которого в каталоге может и не быть.
 */
async function tunedController(key: string, value: unknown): Promise<AuthController> {
  const settings = await freshSettings(db);
  await tune(settings, key, value);
  return new AuthController(settings);
}

beforeEach(async () => {
  await resetDatabase(db);
  process.env.SITE_PASSWORD = 'верный-пароль';
});
afterEach(() => {
  delete process.env.SITE_PASSWORD;
});

describe('POST /api/login', () => {
  it('верный пароль выдаёт куку-пропуск, которая потом проходит проверку', async () => {
    const c = controller();
    const r = res();
    await c.login(req(), r, { password: 'верный-пароль' });
    expect(r.body).toEqual({ ok: true });
    const cookie = r.cookies[AUTH_COOKIE];
    expect(cookie).toBeDefined();
    expect(verifyToken(cookie.value)).toBe(true);
    expect(cookie.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('secure у куки повторяет протокол запроса — иначе её не примут по https', async () => {
    const c = controller();
    const plain = res();
    await c.login(req('10.0.0.1', false), plain, { password: 'верный-пароль' });
    expect(plain.cookies[AUTH_COOKIE].opts.secure).toBe(false);

    const tls = res();
    await c.login(req('10.0.0.2', true), tls, { password: 'верный-пароль' });
    expect(tls.cookies[AUTH_COOKIE].opts.secure).toBe(true);
  });

  it('неверный и пустой пароль — 401 без куки', async () => {
    const c = controller();
    for (const password of ['мимо', '', 42, undefined]) {
      const r = res();
      await c.login(req(), r, { password });
      expect(r.code, String(password)).toBe(401);
      expect(r.cookies[AUTH_COOKIE]).toBeUndefined();
    }
  });

  it('без пароля сайта пускает всех и куку не выдаёт — её нечем подписывать', async () => {
    delete process.env.SITE_PASSWORD;
    const c = controller();
    const r = res();
    await c.login(req(), r, {});
    expect(r.body).toEqual({ ok: true });
    expect(r.cookies[AUTH_COOKIE]).toBeUndefined();
  });

  it('после восьми неудач адрес получает 429 вместо очередной проверки', async () => {
    const c = controller();
    for (let i = 0; i < 8; i++) {
      const r = res();
      await c.login(req('9.9.9.9'), r, { password: `мимо-${i}` });
      expect(r.code).toBe(401);
    }
    const blocked = res();
    // Даже верный пароль дальше не проходит.
    await c.login(req('9.9.9.9'), blocked, { password: 'верный-пароль' });
    expect(blocked.code).toBe(429);
    expect(blocked.cookies[AUTH_COOKIE]).toBeUndefined();
  });

  it('счётчик у каждого адреса свой — сосед не страдает', async () => {
    const c = controller();
    for (let i = 0; i < 8; i++) await c.login(req('9.9.9.9'), res(), { password: 'мимо' });
    const neighbour = res();
    await c.login(req('8.8.8.8'), neighbour, { password: 'верный-пароль' });
    expect(neighbour.body).toEqual({ ok: true });
  });

  it('успешный вход сбрасывает накопленные неудачи', async () => {
    const c = controller();
    for (let i = 0; i < 7; i++) await c.login(req('7.7.7.7'), res(), { password: 'мимо' });
    await c.login(req('7.7.7.7'), res(), { password: 'верный-пароль' });
    // Счётчик обнулён: ещё семь ошибок снова не запирают.
    for (let i = 0; i < 7; i++) {
      const r = res();
      await c.login(req('7.7.7.7'), r, { password: 'мимо' });
      expect(r.code).toBe(401);
    }
  });
});

describe('поток запросов к двери', () => {
  it('умолчание попыток не считает — сегодняшнее поведение', async () => {
    // Ноль в каталоге значит «без предела», и это единственный честный
    // вариант: настройка, включённая сама собой, заперла бы общий выход в
    // интернет, за которым сидит десяток людей.
    const c = controller();
    for (let i = 0; i < 30; i++) {
      const r = res();
      await c.login(req('5.5.5.5'), r, { password: 'верный-пароль' });
      expect(r.body).toEqual({ ok: true });
    }
  });

  it('сверх настроенной скорости дверь отвечает 429, не проверяя пароль', async () => {
    const c = await tunedController('access.loginRatePerMinute', 2);
    for (let i = 0; i < 2; i++) {
      const r = res();
      await c.login(req('5.5.5.5'), r, { password: 'верный-пароль' });
      expect(r.body).toEqual({ ok: true });
    }
    const blocked = res();
    await c.login(req('5.5.5.5'), blocked, { password: 'верный-пароль' });
    expect(blocked.code).toBe(429);
    // Тело своё: снаружи оба отказа 429, но «подождите минуту» и «вы перебрали
    // пароль» чинятся по-разному, и различать их надо не по логам.
    expect(blocked.body).toEqual({ error: 'too fast' });
    expect(blocked.cookies[AUTH_COOKIE]).toBeUndefined();
  });

  it('считаются попытки, а не неудачи — верный пароль тоже стучит', async () => {
    // В этом вся разница с соседним счётчиком: верный пароль, повторённый
    // триста раз в минуту, — тоже не человек, и первый счётчик его не видит.
    const c = await tunedController('access.loginRatePerMinute', 3);
    for (let i = 0; i < 3; i++) await c.login(req('6.6.6.6'), res(), { password: 'верный-пароль' });
    const blocked = res();
    await c.login(req('6.6.6.6'), blocked, { password: 'мимо' });
    expect(blocked.body).toEqual({ error: 'too fast' });
  });

  it('скорость считается по адресу — сосед стучит свободно', async () => {
    const c = await tunedController('access.loginRatePerMinute', 1);
    await c.login(req('6.6.6.6'), res(), { password: 'верный-пароль' });
    const mine = res();
    await c.login(req('6.6.6.6'), mine, { password: 'верный-пароль' });
    expect(mine.code).toBe(429);

    const neighbour = res();
    await c.login(req('7.7.7.7'), neighbour, { password: 'верный-пароль' });
    expect(neighbour.body).toEqual({ ok: true });
  });
});

describe('POST /api/logout', () => {
  it('чистит куку и всегда отвечает успехом — выход идемпотентен', async () => {
    const c = controller();
    const r = res();
    c.logout(r);
    expect(r.cleared).toEqual([AUTH_COOKIE]);
    expect(r.body).toEqual({ ok: true });

    const again = res();
    c.logout(again);
    expect(again.body).toEqual({ ok: true });
  });
});

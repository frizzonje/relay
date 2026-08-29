import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGuestToken, issueToken, resetAddressDoor, useAddressDoor } from './auth/auth';
import { authGate, flatUploadsOnly, uploadStaticHeaders } from './http-gate';

/**
 * Два заслона перед всем http api. Оба стоят ровно на одном: чего НЕЛЬЗЯ
 * получить без пропуска и что нельзя вытащить по прямой ссылке на загрузки.
 * Второе особенно важно: на том же томе лежит registry.json с хэшами паролей
 * закрытых серверов, и «плоскость» витрины — единственное, что его закрывает.
 */

function reqres(path: string, headers: Record<string, string> = {}) {
  const res = {
    code: 0,
    body: undefined as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = vi.fn();
  return {
    req: { path, headers } as unknown as Request,
    res: res as unknown as Response,
    next: next as unknown as NextFunction,
    passed: () => (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length === 1,
    out: res,
  };
}

beforeEach(() => {
  delete process.env.SITE_PASSWORD;
  resetAddressDoor();
});
afterEach(() => {
  delete process.env.SITE_PASSWORD;
  // Дверь по адресу живёт на весь процесс: не вернув её открытой, мы закрыли бы
  // её всему, что запускается следом.
  resetAddressDoor();
});

describe('authGate', () => {
  it('без пароля сайта пропускает всё — открытая инсталляция', () => {
    const t = reqres('/api/metrics');
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
  });

  it('с паролем без пропуска отвечает 401 JSON, а не редиректом', () => {
    process.env.SITE_PASSWORD = 'секрет';
    const t = reqres('/api/metrics');
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(false);
    expect(t.out.code).toBe(401);
    expect(t.out.body).toEqual({ error: 'unauthorized' });
  });

  it('логин и health публичны — иначе не войти и не измерить живость', () => {
    process.env.SITE_PASSWORD = 'секрет';
    for (const path of ['/api/login', '/api/health']) {
      const t = reqres(path);
      authGate(t.req, t.res, t.next);
      expect(t.passed(), path).toBe(true);
    }
  });

  it('верный пропуск в куке проходит', () => {
    process.env.SITE_PASSWORD = 'секрет';
    const t = reqres('/api/metrics', { cookie: `relay_pass=${issueToken().value}` });
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
  });

  it('гостю по инвайту открыт только ICE-конфиг — без него звонок не соберётся', () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { token } = issueGuestToken('voice-obshchii');
    const auth = { authorization: `Bearer ${token}` };

    const config = reqres('/api/config', auth);
    authGate(config.req, config.res, config.next);
    expect(config.passed()).toBe(true);

    // Всё остальное api гостю не положено.
    for (const path of ['/api/metrics', '/uploads/файл.png']) {
      const t = reqres(path, auth);
      authGate(t.req, t.res, t.next);
      expect(t.passed(), path).toBe(false);
    }
  });

  it('протухший гостевой токен не открывает и конфиг', () => {
    process.env.SITE_PASSWORD = 'секрет';
    const { token } = issueGuestToken('voice-obshchii', { ttlMs: -1000 });
    const t = reqres('/api/config', { authorization: `Bearer ${token}` });
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(false);
  });
});

/**
 * Список закрытых адресов запирает обе двери, и эта — вторая. Только сокет
 * означал бы, что заблокированный по-прежнему тянет файлы и жжёт диск: за
 * загрузками стоит именно этот гейт, а не сигналинг.
 */
describe('authGate и закрытые адреса', () => {
  /** Дверь, которая считает, о ком её спросили. */
  function door(closed: string[], owners: string[] = []) {
    const asked: string[] = [];
    useAddressDoor({
      closed: (ip) => closed.includes(ip),
      owner: async (cookie) => {
        asked.push(cookie ?? '');
        return owners.includes(cookie ?? '');
      },
    });
    return asked;
  }

  it('с закрытого адреса отвечает 403 и словом «закрыт», а не «забанен»', async () => {
    door(['10.7.1.2']);
    const t = reqres('/uploads/кот.png');
    (t.req as unknown as { ip: string }).ip = '10.7.1.2';
    authGate(t.req, t.res, t.next);
    await Promise.resolve();
    expect(t.passed()).toBe(false);
    // Не 401: пропуск тут ни при чём, и звать войти заново — звать делать
    // бессмысленное.
    expect(t.out.code).toBe(403);
    expect(t.out.body).toEqual({ error: 'blocked' });
  });

  it('владельца с того же адреса пропускает', async () => {
    door(['10.7.1.2'], ['relay_id=босс']);
    const t = reqres('/uploads/кот.png', { cookie: 'relay_id=босс' });
    (t.req as unknown as { ip: string }).ip = '10.7.1.2';
    authGate(t.req, t.res, t.next);
    await Promise.resolve();
    expect(t.passed()).toBe(true);
  });

  it('о владении спрашивают только попавшего под маску', async () => {
    // Дорогая половина проверки (поход в базу) не должна стоить ничего
    // обычному запросу: под маску не попал — и спрашивать не о чем.
    const asked = door(['10.7.1.2']);
    const t = reqres('/api/metrics');
    (t.req as unknown as { ip: string }).ip = '10.8.0.1';
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
    expect(asked).toEqual([]);
  });

  it('адрес берут из последней записи X-Forwarded-For', async () => {
    // Первую пишет сам клиент; доверяем ровно одному хопу (`trust proxy: 1`).
    door(['10.7.1.2']);
    const t = reqres('/api/metrics', { 'x-forwarded-for': '8.8.8.8, 10.7.1.2' });
    authGate(t.req, t.res, t.next);
    await Promise.resolve();
    expect(t.out.code).toBe(403);
  });

  it('живость спрашивают мимо списка — иначе опечатка в маске крутит контейнер', async () => {
    // За /api/health стоит docker healthcheck из самого контейнера. Маска,
    // случайно накрывшая свой же адрес, превращала бы описку в бесконечный
    // перезапуск, а отдаёт этот путь только «жив ли процесс».
    door(['10.7.1.2']);
    const t = reqres('/api/health');
    (t.req as unknown as { ip: string }).ip = '10.7.1.2';
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
  });

  it('пустой список никого не закрывает — как было до панели', () => {
    const t = reqres('/api/metrics');
    (t.req as unknown as { ip: string }).ip = '10.7.1.2';
    authGate(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
  });

  it('упавший вопрос о владении закрывает дверь, а не открывает её', async () => {
    useAddressDoor({
      closed: () => true,
      owner: async () => {
        throw new Error('база молчит');
      },
    });
    const t = reqres('/api/metrics');
    authGate(t.req, t.res, t.next);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.passed()).toBe(false);
    expect(t.out.code).toBe(403);
  });
});

describe('flatUploadsOnly', () => {
  it('пропускает плоское имя файла', () => {
    const t = reqres('/a1b2c3.png');
    flatUploadsOnly(t.req, t.res, t.next);
    expect(t.passed()).toBe(true);
  });

  it('вложенный путь до реестра не отдаёт', () => {
    const t = reqres('/state/registry.json');
    flatUploadsOnly(t.req, t.res, t.next);
    expect(t.passed()).toBe(false);
    expect(t.out.code).toBe(404);
  });

  it('закодированный слэш тоже режется — express.static раскрыл бы его позже', () => {
    const t = reqres('/state%2fregistry.json');
    flatUploadsOnly(t.req, t.res, t.next);
    expect(t.passed()).toBe(false);
    expect(t.out.code).toBe(404);
  });

  it('обратный слэш и выход вверх не проходят', () => {
    for (const path of ['/..%2fregistry.json', '/state\\registry.json', '/.env']) {
      const t = reqres(path);
      flatUploadsOnly(t.req, t.res, t.next);
      expect(t.passed(), path).toBe(false);
      expect(t.out.code, path).toBe(404);
    }
  });

  it('пустое имя (корень каталога) — 404, а не листинг', () => {
    const t = reqres('/');
    flatUploadsOnly(t.req, t.res, t.next);
    expect(t.out.code).toBe(404);
  });

  it('битая процентная последовательность — 400, а не падение', () => {
    const t = reqres('/%');
    flatUploadsOnly(t.req, t.res, t.next);
    expect(t.passed()).toBe(false);
    expect(t.out.code).toBe(400);
  });
});

describe('заголовки статики загрузок', () => {
  function headers(path: string) {
    const out: Record<string, string> = {};
    uploadStaticHeaders({ setHeader: (k, v) => void (out[k] = v) }, path);
    return out;
  }

  it('картинки и mp3 показываются в чате инлайн', () => {
    for (const name of ['кот.png', 'a.JPEG', 'b.gif', 'c.webp', 'd.mp3']) {
      expect(headers(name)['Content-Disposition'], name).toBeUndefined();
      expect(headers(name)['X-Content-Type-Options'], name).toBe('nosniff');
    }
  });

  it('всё, что может выполнить скрипт в нашем origin, форсится на скачивание', () => {
    for (const name of ['x.svg', 'y.html', 'z.js', 'w.pdf', 'без-расширения']) {
      expect(headers(name)['Content-Disposition'], name).toBe('attachment');
    }
  });
});

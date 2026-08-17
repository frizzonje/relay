import { describe, expect, it } from 'vitest';
import {
  Semaphore,
  UnlockAttempts,
  clientIp,
  hashServerPassword,
  issueUnlockToken,
  verifyServerPassword,
  verifyUnlockToken,
} from './unlock';

/**
 * Разблокировка закрытых серверов. Проверяем ровно то, на чём она ломалась:
 * счётчик неудач, который переживает реконнект, адрес, который нельзя себе
 * приписать, и ограничение на одновременные scrypt.
 */

describe('Semaphore', () => {
  it('больше лимита одновременно не пускает', async () => {
    const gate = new Semaphore(2);
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const tasks = Array.from({ length: 6 }, () =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await held;
        running -= 1;
      }),
    );

    await Promise.resolve(); // дали задачам занять места
    expect(gate.stats).toEqual({ busy: 2, waiting: 4 });
    release();
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(gate.stats).toEqual({ busy: 0, waiting: 0 });
  });

  it('слот освобождается и после исключения', async () => {
    const gate = new Semaphore(1);
    await expect(
      gate.run(async () => {
        throw new Error('упало');
      }),
    ).rejects.toThrow('упало');
    expect(gate.stats.busy).toBe(0);
    await expect(gate.run(async () => 'ок')).resolves.toBe('ок');
  });

  it('очередь идёт по порядку', async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      gate.run(async () => {
        order.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('пароль сервера', () => {
  it('проверяется только сам себя', async () => {
    const stored = await hashServerPassword('тайна');
    expect(await verifyServerPassword('тайна', stored)).toBe(true);
    expect(await verifyServerPassword('тайна ', stored)).toBe(false);
    expect(await verifyServerPassword('', stored)).toBe(false);
  });

  it('соль у каждого своя: одинаковые пароли дают разные хэши', async () => {
    expect(await hashServerPassword('одно и то же')).not.toBe(
      await hashServerPassword('одно и то же'),
    );
  });

  it('испорченный хэш — отказ, а не исключение', async () => {
    expect(await verifyServerPassword('пароль', 'мусор')).toBe(false);
    expect(await verifyServerPassword('пароль', '')).toBe(false);
    expect(await verifyServerPassword('пароль', 'aa:')).toBe(false);
  });

  it('десяток одновременных проверок отвечает верно каждому', async () => {
    const stored = await hashServerPassword('пароль');
    const answers = await Promise.all([
      ...Array.from({ length: 5 }, () => verifyServerPassword('пароль', stored)),
      ...Array.from({ length: 5 }, (_, i) => verifyServerPassword('не тот ' + i, stored)),
    ]);
    expect(answers).toEqual([true, true, true, true, true, false, false, false, false, false]);
  });
});

describe('clientIp', () => {
  const at = (headers: Record<string, string | string[] | undefined>, address?: string) =>
    clientIp({ headers, address });

  it('берёт последнюю запись X-Forwarded-For — ту, что подставил наш прокси', () => {
    // Первая запись — то, что написал клиент. Довериться ей значит разрешить
    // каждому назначить себе новый адрес на каждую попытку пароля.
    expect(at({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('одна запись — она и есть адрес', () => {
    expect(at({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('заголовок пришёл массивом — берём последний', () => {
    expect(at({ 'x-forwarded-for': ['9.9.9.9', '203.0.113.7'] })).toBe('203.0.113.7');
  });

  it('без прокси — адрес сокета', () => {
    expect(at({}, '198.51.100.4')).toBe('198.51.100.4');
    expect(at({ 'x-forwarded-for': '  ' }, '198.51.100.4')).toBe('198.51.100.4');
  });

  it('неизвестно — честное "unknown", а не пустая строка на всех', () => {
    expect(at({})).toBe('unknown');
  });
});

describe('UnlockAttempts', () => {
  it('до порога не мешает', () => {
    const a = new UnlockAttempts(3, 1000, 60_000);
    for (let i = 0; i < 3; i++) a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(0);
  });

  it('после порога назначает растущий простой', () => {
    const a = new UnlockAttempts(3, 1000, 60_000);
    for (let i = 0; i < 4; i++) a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(1000);
    a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(2000);
    a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(4000);
  });

  it('простой не растёт выше потолка', () => {
    const a = new UnlockAttempts(0, 1000, 3000);
    for (let i = 0; i < 10; i++) a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(3000);
  });

  it('простой кончается сам', () => {
    const a = new UnlockAttempts(0, 1000, 60_000);
    a.fail('ip', 'srv', 0);
    expect(a.blockedUntil('ip', 'srv', 999)).toBe(1000);
    expect(a.blockedUntil('ip', 'srv', 1001)).toBe(0);
  });

  it('счёт раздельный по серверам: заперли один — остальные открыты', () => {
    const a = new UnlockAttempts(0, 1000, 60_000);
    a.fail('ip', 'srv-1', 0);
    expect(a.blockedUntil('ip', 'srv-1', 0)).toBe(1000);
    expect(a.blockedUntil('ip', 'srv-2', 0)).toBe(0);
  });

  it('счёт раздельный по адресам', () => {
    const a = new UnlockAttempts(0, 1000, 60_000);
    a.fail('ip-1', 'srv', 0);
    expect(a.blockedUntil('ip-2', 'srv', 0)).toBe(0);
  });

  it('удачная попытка обнуляет счёт', () => {
    const a = new UnlockAttempts(1, 1000, 60_000);
    a.fail('ip', 'srv', 0);
    a.succeed('ip', 'srv');
    a.fail('ip', 'srv', 0); // снова первая, а не вторая
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(0);
  });

  it('удалённый сервер уносит свои записи: id можно занять заново', () => {
    const a = new UnlockAttempts(0, 1000, 60_000);
    a.fail('ip', 'srv', 0);
    a.forgetServer('srv');
    expect(a.blockedUntil('ip', 'srv', 0)).toBe(0);
  });
});

/**
 * Пропуск в закрытый сервер. Он существует ровно затем, чтобы разблокировка
 * пережила реконнект, не заставляя браузер хранить пароль, — поэтому важны два
 * его свойства: подделать нельзя и смена пароля убивает его сама.
 */
describe('пропуск в закрытый сервер', () => {
  const HASH = 'соль:хэш';
  const hashOf = (id: string) => (id === 'srv' ? HASH : undefined);

  it('свой пропуск проверяется и называет свой сервер', () => {
    const { token } = issueUnlockToken('srv', HASH);
    expect(verifyUnlockToken(token, hashOf)).toBe('srv');
  });

  it('id сервера переживает не-ASCII', () => {
    const { token } = issueUnlockToken('сервер-1', HASH);
    expect(verifyUnlockToken(token, () => HASH)).toBe('сервер-1');
  });

  it('смена пароля отзывает пропуск: ключ подписи — сам хэш', () => {
    const { token } = issueUnlockToken('srv', HASH);
    expect(verifyUnlockToken(token, () => 'соль:другой-хэш')).toBeNull();
  });

  it('сервер без пароля (или удалённый) пропуска не признаёт', () => {
    const { token } = issueUnlockToken('srv', HASH);
    expect(verifyUnlockToken(token, () => undefined)).toBeNull();
  });

  it('пропуск на один сервер не открывает другой', () => {
    const { token } = issueUnlockToken('другой', HASH);
    expect(verifyUnlockToken(token, hashOf)).toBeNull();
  });

  it('подпись не подделать, подменив тело', () => {
    const { token } = issueUnlockToken('srv', HASH);
    const parts = token.split('.');
    const forged = [
      parts[0],
      Buffer.from('srv', 'utf8').toString('base64url'),
      String(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      parts[3],
    ].join('.');
    expect(verifyUnlockToken(forged, hashOf)).toBeNull();
  });

  it('просроченный пропуск не принимается', () => {
    const { token } = issueUnlockToken('srv', HASH);
    const parts = token.split('.');
    const expired = [parts[0], parts[1], String(Date.now() - 1), parts[3]].join('.');
    expect(verifyUnlockToken(expired, hashOf)).toBeNull();
  });

  it('мусор вместо пропуска — просто null, без исключений', () => {
    for (const bad of ['', 'мусор', 'u1.a.b', 'u2.a.1.b', 'u1...', 'u1.!!!.1.x']) {
      expect(verifyUnlockToken(bad, hashOf)).toBeNull();
    }
  });
});

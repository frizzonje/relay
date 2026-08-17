import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  connectWithRetry,
  dataSourceOptions,
  databaseUrl,
  explainDbFailure,
  retryDelay,
} from './data-source';

/**
 * Проверяется здесь не TypeORM, а два наших обещания: что схема никогда не
 * поедет сама и что человек, у которого не поднялась база, прочитает в логе
 * что делать, а не стектрейс драйвера.
 */

describe('databaseUrl', () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it('пустая строка — это отсутствие адреса, а не адрес', () => {
    process.env.DATABASE_URL = '   ';
    expect(databaseUrl()).toBeUndefined();
  });

  it('пробелы по краям срезает: .env правят руками', () => {
    process.env.DATABASE_URL = ' postgresql://relay@db:5432/relay ';
    expect(databaseUrl()).toBe('postgresql://relay@db:5432/relay');
  });
});

describe('настройки подключения', () => {
  const opts = dataSourceOptions('postgresql://relay@db:5432/relay');

  it('не правит схему сама', () => {
    expect(opts.synchronize).toBe(false);
  });

  it('не гоняет миграции при инициализации — это делает bootstrap до listen', () => {
    expect(opts.migrationsRun).toBe(false);
  });

  it('знает все сущности и миграции', () => {
    expect(opts.entities).toHaveLength(11);
    expect(opts.migrations).toHaveLength(4);
  });
});

describe('пауза между попытками', () => {
  it('растёт вдвое и упирается в потолок', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('объяснение отказа', () => {
  it('база не поднята — говорит, куда смотреть', () => {
    const text = explainDbFailure(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    expect(text).toContain('docker compose logs db');
  });

  it('пароль не подошёл — объясняет, что дело в томе, а не в опечатке', () => {
    const text = explainDbFailure(
      Object.assign(new Error('password authentication failed'), { code: '28P01' }),
    );
    expect(text).toContain('при создании тома');
    expect(text).toContain('relay restore');
  });

  it('нет базы с таким именем — отдельный случай', () => {
    const text = explainDbFailure(
      Object.assign(new Error('database "relay" does not exist'), { code: '3D000' }),
    );
    expect(text).toContain('POSTGRES_DB');
  });

  it('незнакомая ошибка не глотается', () => {
    expect(explainDbFailure(new Error('что-то новое'))).toContain('что-то новое');
  });

  it('переживает то, что вообще не Error', () => {
    expect(explainDbFailure('строка вместо ошибки')).toContain('строка вместо ошибки');
  });
});

describe('подключение с повторами', () => {
  /** DataSource, который отказывает `fails` раз подряд, а потом соглашается. */
  function flaky(fails: number) {
    let calls = 0;
    return {
      calls: () => calls,
      ds: {
        initialize: async () => {
          calls += 1;
          if (calls <= fails)
            throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      } as unknown as DataSource,
    };
  }

  const nosleep = () => Promise.resolve();

  it('переживает медленный старт базы', async () => {
    const { ds, calls } = flaky(3);
    await connectWithRetry(ds, { sleep: nosleep });
    expect(calls()).toBe(4);
  });

  it('сдаётся после последней попытки и отдаёт исходную ошибку', async () => {
    const { ds, calls } = flaky(99);
    await expect(connectWithRetry(ds, { attempts: 3, sleep: nosleep })).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(calls()).toBe(3);
  });

  it('о каждом повторе сообщает — молчаливое ожидание неотличимо от зависания', async () => {
    const onRetry = vi.fn();
    const { ds } = flaky(2);
    await connectWithRetry(ds, { sleep: nosleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toBe(1000);
    expect(onRetry.mock.calls[1][1]).toBe(2000);
  });
});

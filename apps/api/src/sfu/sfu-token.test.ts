import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSfuToken, sfuConfigured, sfuSecret } from './sfu-token';

/**
 * Пропуск в медиасервер. Проверяющий близнец живёт в apps/sfu/src/token.ts, и
 * формат обязан совпадать байт-в-байт — разъехавшись, они дадут не ошибку, а
 * молчаливое «звонок не собирается». Здесь проверяем ту половину, что выдаёт.
 */

beforeEach(() => {
  delete process.env.SFU_URL;
  delete process.env.SFU_SECRET;
});
afterEach(() => {
  delete process.env.SFU_URL;
  delete process.env.SFU_SECRET;
});

describe('sfuConfigured', () => {
  it('нужны и адрес, и секрет — по отдельности они бесполезны', () => {
    expect(sfuConfigured()).toBe(false);
    process.env.SFU_URL = 'https://relay.example/sfu';
    expect(sfuConfigured()).toBe(false);
    process.env.SFU_SECRET = 'секрет';
    expect(sfuConfigured()).toBe(true);
  });

  it('адрес из одних пробелов настройкой не считается', () => {
    process.env.SFU_URL = '   ';
    process.env.SFU_SECRET = 'секрет';
    expect(sfuConfigured()).toBe(false);
  });

  it('незаданный секрет — пустая строка, а не undefined', () => {
    expect(sfuSecret()).toBe('');
  });
});

describe('issueSfuToken', () => {
  beforeEach(() => {
    process.env.SFU_SECRET = 'секрет';
  });

  it('токен несёт комнату, peerId и имя — их и проверит медиасервер', () => {
    const { token, exp } = issueSfuToken({ room: 'эфир', peerId: 'sock-1', name: 'Хозяин' });
    const [version, body, sig] = token.split('.');
    expect(version).toBe('s1');
    expect(sig).toHaveLength(43);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({
      room: 'эфир',
      peerId: 'sock-1',
      name: 'Хозяин',
      exp,
    });
  });

  it('подпись — HMAC от префикса на ключе с контекстом relay-sfu-v1', () => {
    const { token } = issueSfuToken({ room: 'эфир', peerId: 'sock-1', name: 'Х' });
    const dot = token.lastIndexOf('.');
    const expected = createHmac('sha256', 'relay-sfu-v1:секрет')
      .update(token.slice(0, dot))
      .digest('base64url');
    expect(token.slice(dot + 1)).toBe(expected);
  });

  it('срок короткий: пропуск нужен ровно на момент подключения', () => {
    const { exp } = issueSfuToken({ room: 'э', peerId: 'p', name: 'n' });
    expect(exp - Date.now()).toBeGreaterThan(0);
    expect(exp - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it('смена секрета отзывает выданные пропуска', () => {
    const { token } = issueSfuToken({ room: 'э', peerId: 'p', name: 'n' });
    process.env.SFU_SECRET = 'другой';
    const dot = token.lastIndexOf('.');
    const nowExpected = createHmac('sha256', 'relay-sfu-v1:другой')
      .update(token.slice(0, dot))
      .digest('base64url');
    expect(token.slice(dot + 1)).not.toBe(nowExpected);
  });
});

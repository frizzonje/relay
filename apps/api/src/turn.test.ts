import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueTurnCredentials, signTurnUsername, turnSecret, turnTtlSeconds } from './turn';

/**
 * Учётки для TURN. Проверять здесь нужно ровно одно: что подпись совпадает с
 * той, которую посчитает coturn. Разойдись мы с ним хоть в кодировке — звонки
 * за строгим NAT перестанут собираться, и не с ошибкой, а тишиной: браузер
 * просто не получит relay-кандидата и будет пробовать прямой путь, которого
 * нет.
 */

const ENV = ['TURN_SECRET', 'TURN_CREDENTIAL', 'TURN_TTL_SECONDS'] as const;
beforeEach(() => {
  for (const key of ENV) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV) delete process.env[key];
});

describe('подпись', () => {
  /**
   * Ответ посчитан не этим же кодом, а двумя сторонними реализациями
   * HMAC-SHA1 (openssl и python) — в этом весь смысл проверки. Она ловит
   * подмену алгоритма (sha256), кодировки (base64url) и сообщения (логин без
   * срока): каждая из трёх оставляет тесты зелёными, а звонки — без
   * ретранслятора.
   */
  it('HMAC-SHA1 от логина целиком, base64 — байт в байт с coturn', () => {
    expect(signTurnUsername('north', '12334939:mbzrxpgjys')).toBe('Iq7YXkRon8YXJfdN1Ke9EZOw1UE=');
  });

  it('другой секрет — другая подпись: тем и отзывается прежняя выдача', () => {
    expect(signTurnUsername('north', '12334939:mbzrxpgjys')).not.toBe(
      signTurnUsername('south', '12334939:mbzrxpgjys'),
    );
  });
});

describe('выдача', () => {
  it('логин — это срок годности и метка сессии, пароль — подпись логина', () => {
    const now = 1_700_000_000_000;
    const pass = issueTurnCredentials('секрет', now);
    expect(pass.expiresAt).toBe(1_700_000_000 + 24 * 60 * 60);
    expect(pass.username).toMatch(/^1700086400:[0-9a-f]{8}$/);
    expect(pass.credential).toBe(signTurnUsername('секрет', pass.username));
  });

  it('каждому своя: две выдачи подряд не совпадают', () => {
    const now = 1_700_000_000_000;
    expect(issueTurnCredentials('секрет', now).username).not.toBe(
      issueTurnCredentials('секрет', now).username,
    );
  });
});

describe('срок', () => {
  it('по умолчанию сутки — столько живёт вкладка, открытая на ночь', () => {
    expect(turnTtlSeconds()).toBe(86400);
  });

  it('своё значение принимается', () => {
    process.env.TURN_TTL_SECONDS = '3600';
    expect(turnTtlSeconds()).toBe(3600);
  });

  it('бессмыслица не отменяет срок, а откатывает к суткам', () => {
    for (const bad of ['', 'навсегда', '0', '-5']) {
      process.env.TURN_TTL_SECONDS = bad;
      expect(turnTtlSeconds()).toBe(86400);
    }
  });

  it('края обрезаны: меньше минуты не успеет соединение, больше недели — уже «навсегда»', () => {
    process.env.TURN_TTL_SECONDS = '5';
    expect(turnTtlSeconds()).toBe(60);
    process.env.TURN_TTL_SECONDS = '99999999';
    expect(turnTtlSeconds()).toBe(7 * 24 * 60 * 60);
  });
});

describe('секрет', () => {
  it('пустой — значит режима нет вовсе: молча подписывать нечем', () => {
    expect(turnSecret()).toBe('');
  });

  /**
   * Прежний статический пароль ключом подписи НЕ становится, и это не забытая
   * строчка. Значение TURN_CREDENTIAL люди уже видели — оно раздавалось
   * клиентам открытым текстом; сделай мы его ключом, каждый, кто входил на
   * инсталляцию до 1.0, мог бы выписывать себе учётки сам, бессрочно.
   */
  it('прежний пароль ключом не служит: его слишком многие видели', () => {
    process.env.TURN_CREDENTIAL = 'старый пароль';
    expect(turnSecret()).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { IDENTITY_COOKIE, issueSession, readSession } from './session';

/**
 * Сессия личности — единственное место слоя 2, где сервер верит на слово
 * предъявленной строке, а не подписи устройства. Значит подделать эту строку
 * не должно получаться ничем.
 */

const WHO = { identityId: 'i-1', deviceId: 'd-1' };

describe('своя кука', () => {
  it('читается обратно', () => {
    expect(readSession(issueSession(WHO).value)).toEqual(WHO);
  });

  it('живёт месяц, а не вечно', () => {
    const { maxAgeMs } = issueSession(WHO);
    expect(maxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('называется отдельно от пропуска на инсталляцию', () => {
    // Разные вопросы — разные куки: «пустить ли сюда» и «кто это».
    expect(IDENTITY_COOKIE).toBe('relay_id');
  });
});

describe('чужая — никак', () => {
  it('подменённая личность не проходит', () => {
    const token = issueSession(WHO).value;
    const [, device, exp, sig] = token.split('.');
    expect(readSession(`i-2.${device}.${exp}.${sig}`)).toBeNull();
  });

  it('продлённый срок не проходит', () => {
    const [id, device, exp, sig] = issueSession(WHO).value.split('.');
    expect(readSession(`${id}.${device}.${Number(exp) + 1}.${sig}`)).toBeNull();
  });

  it('истёкшая — не проходит', () => {
    // Собираем руками: выдать просроченную нечем, и это правильно.
    const past = Date.now() - 1000;
    expect(readSession(`i-1.d-1.${past}.что-угодно`)).toBeNull();
  });

  it('обрезки и мусор — тоже', () => {
    expect(readSession(undefined)).toBeNull();
    expect(readSession('')).toBeNull();
    expect(readSession('i-1.d-1')).toBeNull();
    expect(readSession('i-1.d-1.не-число.sig')).toBeNull();
    expect(readSession('....')).toBeNull();
  });

  it('подпись сравнивается целиком, а не по префиксу', () => {
    const [id, device, exp, sig] = issueSession(WHO).value.split('.');
    expect(readSession(`${id}.${device}.${exp}.${sig.slice(0, -1)}`)).toBeNull();
    expect(readSession(`${id}.${device}.${exp}.${sig}x`)).toBeNull();
  });
});

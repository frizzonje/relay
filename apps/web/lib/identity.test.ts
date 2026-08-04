// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadClientId } from '@/lib/identity';

/**
 * Id устройства обязан быть одним и тем же на всю страницу. По нему сервер
 * решает, чьи серверы и каналы человеку разрешено менять (audit B2), и
 * выгоняет из эфира «призрака» прошлой вкладки, — а вычисляется он заново на
 * каждый connect сокета (см. lib/socket). Меняйся он от вызова к вызову,
 * человек терял бы власть над только что созданным сервером после первого же
 * реконнекта.
 */
describe('loadClientId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('одинаков при повторных вызовах и переживает перезагрузку', () => {
    const first = loadClientId();
    expect(first).not.toBe('');
    expect(loadClientId()).toBe(first);
    expect(localStorage.getItem('relay-cid')).toBe(first);
  });

  it('одинаков и когда хранилище недоступно (приватный режим)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const first = loadClientId();
    expect(first).not.toBe('');
    expect(loadClientId()).toBe(first);
  });
});

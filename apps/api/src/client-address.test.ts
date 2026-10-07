import { describe, expect, it } from 'vitest';
import { clientIp, networkOf } from './client-address';

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

describe('networkOf', () => {
  it('IPv4 — сам адрес: его выдают поштучно', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 — его /64: внутри блока абонент меняет адрес сам', () => {
    // Два адреса одного блока — одна сеть, иначе пятая неудача пароля с
    // соседнего адреса считалась бы первой.
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8:1:2:bbbb::9')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:db8:1:3::1')).not.toBe(networkOf('2001:db8:1:2::1'));
  });

  it('IPv4 в обёртке IPv6 — тот же IPv4', () => {
    // Так req.ip выглядит на сокете, слушающем обе семьи.
    expect(networkOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('не адрес — как есть', () => {
    expect(networkOf('unknown')).toBe('unknown');
  });
});

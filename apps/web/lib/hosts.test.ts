// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostLabel, isCurrentHost, loadHosts, normalizeHostUrl, saveHosts } from './hosts';

/**
 * Список чужих инсталляций в рейке. Клик по строке уводит браузер на другой
 * origin целиком, поэтому разбор адреса — не про удобство: `new URL` молча
 * percent-энкодит пробелы и проглатывает почти любой мусор, и без явной
 * проверки в рейку попала бы строка, ведущая непонятно куда.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('normalizeHostUrl', () => {
  it('голое имя хоста достраивается до https и режется до origin', () => {
    expect(normalizeHostUrl('relay.example.com')).toBe('https://relay.example.com');
    expect(normalizeHostUrl('relay.example.com/канал/1?x=2')).toBe('https://relay.example.com');
    expect(normalizeHostUrl('  relay.example.com  ')).toBe('https://relay.example.com');
  });

  it('порт сохраняется — на своём сервере relay часто не на 443', () => {
    expect(normalizeHostUrl('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
    expect(normalizeHostUrl('localhost:3000')).toBe('https://localhost:3000');
  });

  it('IPv6 в скобках проходит', () => {
    expect(normalizeHostUrl('http://[::1]:3000')).toBe('http://[::1]:3000');
  });

  it('чужая схема отвергается — это не то, что можно открыть как relay', () => {
    for (const bad of ['ftp://relay.example', 'javascript:alert(1)//x', 'file:///etc/passwd']) {
      expect(normalizeHostUrl(bad), bad).toBeNull();
    }
  });

  it('мусор с пробелами не превращается в адрес', () => {
    for (const bad of ['два слова', '', '   ', 'https://два слова', 'https://']) {
      expect(normalizeHostUrl(bad), bad).toBeNull();
    }
  });

  it('хост с недопустимыми символами не проходит', () => {
    for (const bad of ['https://_x', 'https://a_b.example', 'https://-x.example']) {
      expect(normalizeHostUrl(bad), bad).toBeNull();
    }
  });
});

describe('хранилище хостов', () => {
  it('сохранённое читается обратно', () => {
    const hosts = [{ url: 'https://a.example' }, { url: 'https://b.example', label: 'у друга' }];
    saveHosts(hosts);
    expect(loadHosts()).toEqual(hosts);
  });

  it('битое и чужое содержимое читается как пустой список, а не роняет рейку', () => {
    for (const junk of ['{не json', '42', '"строка"', '[{"нет":"url"}]', 'null']) {
      localStorage.setItem('relay-hosts', junk);
      expect(loadHosts(), junk).toEqual([]);
    }
  });

  it('годные записи выживают рядом с мусорными', () => {
    localStorage.setItem(
      'relay-hosts',
      JSON.stringify([{ url: 'https://a.example' }, 5, null, {}]),
    );
    expect(loadHosts()).toEqual([{ url: 'https://a.example' }]);
  });

  it('приватный режим — просто не запоминаем, без исключения наружу', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveHosts([{ url: 'https://a.example' }])).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('подпись хоста', () => {
  it('своя подпись важнее hostname', () => {
    expect(hostLabel({ url: 'https://relay.example', label: '  у друга ' })).toBe('у друга');
  });

  it('без подписи — hostname без www', () => {
    expect(hostLabel({ url: 'https://www.relay.example/x' })).toBe('relay.example');
    expect(hostLabel({ url: 'https://relay.example:8443' })).toBe('relay.example');
  });

  it('пустая подпись и битый url не оставляют строку без текста', () => {
    expect(hostLabel({ url: 'https://relay.example', label: '   ' })).toBe('relay.example');
    expect(hostLabel({ url: 'не адрес' })).toBe('не адрес');
  });
});

describe('текущий хост', () => {
  it('свой origin узнаётся — его иконку подсвечивают, а не уводят', () => {
    expect(isCurrentHost(window.location.origin)).toBe(true);
    expect(isCurrentHost('https://чужой.example')).toBe(false);
  });
});

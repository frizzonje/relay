// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderMarkdownMini } from './markdown';

/**
 * Мини-markdown сообщений. Разбираем в React-узлы вручную именно для того,
 * чтобы разметка из чужого сообщения не могла оказаться разметкой страницы —
 * поэтому первым делом проверяем не «работает ли жирный», а что тег, набранный
 * в чате, остаётся текстом.
 */

const html = (text: string) => renderToStaticMarkup(<>{renderMarkdownMini(text)}</>);

describe('разметка из сообщения не становится разметкой страницы', () => {
  it('теги экранируются', () => {
    const out = html('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('javascript-ссылка не превращается в ссылку', () => {
    const out = html('javascript:alert(1)');
    expect(out).not.toContain('<a');
  });
});

describe('жирный', () => {
  it('**текст** становится strong', () => {
    expect(html('это **важно** очень')).toContain('<strong');
    expect(html('это **важно** очень')).toContain('важно');
  });

  it('незакрытые звёздочки и перенос строки внутри — просто текст', () => {
    expect(html('**незакрытый')).not.toContain('<strong');
    expect(html('**через\nстроку**')).not.toContain('<strong');
  });

  it('пустая пара звёздочек не даёт пустого strong', () => {
    expect(html('****')).not.toContain('<strong');
  });
});

describe('код', () => {
  it('`код` становится code', () => {
    expect(html('вот `npm i` команда')).toContain('<code');
  });

  it('внутри кода ничего не разбирается — ни жирный, ни ссылка', () => {
    const out = html('`**не жирный** https://example.com`');
    expect(out).not.toContain('<strong');
    expect(out).not.toContain('<a');
    expect(out).toContain('**не жирный**');
  });
});

describe('ссылки', () => {
  it('адрес становится ссылкой, которая открывается безопасно', () => {
    const out = html('см. https://relay.example/x');
    expect(out).toContain('href="https://relay.example/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('хвостовая пунктуация остаётся текстом, а не частью адреса', () => {
    const out = html('открой https://relay.example.');
    expect(out).toContain('href="https://relay.example"');
    // Точка ушла обычным текстом ПОСЛЕ ссылки, а не в адрес.
    expect(out.endsWith('</a>.')).toBe(true);
  });

  it('несколько ссылок в одной строке разбираются порознь', () => {
    const out = html('https://a.example и https://b.example');
    expect(out.match(/<a /g)).toHaveLength(2);
  });

  it('ссылка внутри жирного остаётся ссылкой', () => {
    const out = html('**см. https://relay.example**');
    expect(out).toContain('<strong');
    expect(out).toContain('<a');
  });
});

describe('обычный текст', () => {
  it('проходит как есть', () => {
    expect(html('просто сообщение')).toBe('просто сообщение');
  });

  it('пустая строка ничего не рисует', () => {
    expect(html('')).toBe('');
  });

  it('повторный разбор той же строки даёт тот же результат — regex не залипает', () => {
    const text = '`код` **жирный** https://a.example';
    expect(html(text)).toBe(html(text));
  });
});

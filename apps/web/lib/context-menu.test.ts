// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { editableOf, targetEntries } from '@/lib/context-menu';
import { isSeparator, type MenuEntry } from '@/stores/context-menu';

/**
 * Набор пунктов контекстного меню под цель щелчка. Проверяем именно состав и
 * порядок: это тот контракт, из-за которого меню либо выглядит родным
 * («Вставить» в поле, «Копировать адрес» на ссылке), либо превращается в
 * бесполезную заглушку поверх меню движка.
 */

const ids = (entries: MenuEntry[]) => entries.map((e) => e.id);
const labels = (entries: MenuEntry[]) =>
  entries.filter((e) => !isSeparator(e)).map((e) => (e as { label: string }).label);

beforeEach(() => {
  document.body.replaceChildren();
});

function mount<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  return el;
}

describe('targetEntries', () => {
  it('в пустом месте не предлагает ничего — меню оболочки соберёт openContextMenu', () => {
    const div = mount(document.createElement('div'));
    expect(targetEntries(div, '')).toEqual([]);
  });

  it('на выделенном тексте — только копирование', () => {
    const div = mount(document.createElement('div'));
    expect(ids(targetEntries(div, 'кусок текста'))).toEqual(['copy-selection']);
  });

  it('в пустом поле ввода — вставка (резать и выделять нечего)', () => {
    const input = mount(document.createElement('input'));
    expect(ids(targetEntries(input, ''))).toEqual(['paste']);
  });

  it('в поле с выделением — полный набор буфера', () => {
    const input = mount(document.createElement('input'));
    input.value = 'сервер.рф';
    input.setSelectionRange(0, 6);
    expect(ids(targetEntries(input, ''))).toEqual(['cut', 'copy', 'paste', 'select-all']);
  });

  it('в поле без выделения, но с текстом — вставка и «выделить всё»', () => {
    const ta = mount(document.createElement('textarea'));
    ta.value = 'черновик';
    expect(ids(targetEntries(ta, ''))).toEqual(['paste', 'select-all']);
  });

  it('поле только для чтения не считается редактируемым', () => {
    const input = mount(document.createElement('input'));
    input.readOnly = true;
    expect(editableOf(input)).toBeNull();
    expect(targetEntries(input, '')).toEqual([]);
  });

  it('чекбокс — не текстовое поле: пунктов буфера не даём', () => {
    const input = mount(document.createElement('input'));
    input.type = 'checkbox';
    expect(editableOf(input)).toBeNull();
  });

  it('на ссылке — открыть и скопировать адрес', () => {
    const a = mount(document.createElement('a'));
    a.href = 'https://overhype.tech/';
    a.textContent = 'ссылка';
    expect(ids(targetEntries(a, ''))).toEqual(['link-open', 'link-copy']);
  });

  it('на картинке — сохранить и скопировать адрес', () => {
    const img = mount(document.createElement('img'));
    img.src = 'https://overhype.tech/uploads/cat.png';
    expect(ids(targetEntries(img, ''))).toEqual(['img-save', 'img-copy-link']);
  });

  it('картинка внутри ссылки и выделение — три группы через разделители', () => {
    const a = mount(document.createElement('a'));
    a.href = 'https://overhype.tech/uploads/cat.png';
    const img = document.createElement('img');
    img.src = 'https://overhype.tech/uploads/cat.png';
    a.appendChild(img);
    expect(ids(targetEntries(img, 'подпись'))).toEqual([
      'link-open',
      'link-copy',
      'sep-img',
      'img-save',
      'img-copy-link',
      'sep-sel',
      'copy-selection',
    ]);
  });

  it('щелчок по потомку поля ищет поле вверх по дереву', () => {
    const wrap = mount(document.createElement('div'));
    wrap.innerHTML = '<div contenteditable="true"><span>текст</span></div>';
    const span = wrap.querySelector('span')!;
    // jsdom не реализует isContentEditable — подменяем на самом узле.
    const editable = wrap.querySelector('[contenteditable]') as HTMLElement;
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(editableOf(span)).toBe(editable);
  });

  it('у каждого пункта есть значок — столбец слева не должен зиять дырами', () => {
    const input = mount(document.createElement('input'));
    input.value = 'текст';
    input.setSelectionRange(0, 5);
    const a = mount(document.createElement('a'));
    a.href = 'https://overhype.tech/uploads/cat.png';
    const img = document.createElement('img');
    img.src = 'https://overhype.tech/uploads/cat.png';
    a.appendChild(img);

    for (const entries of [targetEntries(input, ''), targetEntries(img, 'подпись')]) {
      const withoutIcon = entries
        .filter((e) => !isSeparator(e))
        .filter((e) => !(e as { icon?: string }).icon)
        .map((e) => e.id);
      expect(withoutIcon).toEqual([]);
    }
  });

  it('подписи из словаря, без многоточий у мгновенных действий', () => {
    const input = mount(document.createElement('input'));
    input.value = 'текст';
    input.setSelectionRange(0, 5);
    // Язык в тестах — базовый (en); проверяем сам набор пунктов и их вид.
    expect(labels(targetEntries(input, ''))).toEqual([
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ]);
  });
});

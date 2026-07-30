import { toast } from 'sonner';
import { useContextMenuStore, type MenuEntry } from '@/stores/context-menu';
import { useUiStore } from '@/stores/ui';

/**
 * Своё контекстное меню вместо меню движка.
 *
 * ПКМ в клиенте не должен показывать «Назад / Обновить / Просмотреть код» —
 * это чужой интерфейс, из-за которого нативная оболочка мгновенно выдаёт себя
 * как веб-страницу. Здесь живёт вся начинка меню: набор пунктов под то, чем
 * щёлкнули (поле ввода, выделенный текст, ссылка, картинка), и действия
 * буфера обмена. Рисует их components/ui/ContextMenu.tsx, он же ловит
 * `contextmenu` на документе.
 *
 * Аварийный выход к меню браузера — Shift+ПКМ (нужен на вебе: перевод
 * страницы, «сохранить как», отладка). Тач-долгое нажатие не трогаем вовсе:
 * там системное меню — часть выделения текста.
 */

// ── Горячие клавиши ─────────────────────────────────────────────────────────

/** macOS (в т.ч. WKWebView десктопа) подписываем ⌘, остальных — Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(ua);
}

/** Подпись горячей клавиши для правой колонки пункта. */
export function shortcut(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

// ── Буфер обмена ────────────────────────────────────────────────────────────

/**
 * Положить текст в буфер. Clipboard API есть не всюду (http-стенды, старые
 * движки) — на отказе падаем в execCommand через скрытое поле.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* пробуем по-старому */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Прочитать буфер. Движок может запретить чтение — тогда null, не исключение. */
async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// ── Текстовые поля ──────────────────────────────────────────────────────────

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Типы input, в которых имеет смысл резать/вставлять текст. */
const TEXTUAL_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

function asField(el: Element | null): Field | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXTUAL_INPUTS.has(el.type)) return el;
  return null;
}

/** Ближайший редактируемый предок: поле ввода или contenteditable. */
export function editableOf(node: Element | null): Field | HTMLElement | null {
  const el = node?.closest('input, textarea, [contenteditable]') ?? null;
  const field = asField(el);
  if (field) return field.readOnly || field.disabled ? null : field;
  if (el instanceof HTMLElement && el.isContentEditable) return el;
  return null;
}

/** Выделение внутри поля (для «Вырезать»/«Копировать»). */
function fieldSelection(field: Field): string {
  const { selectionStart: a, selectionEnd: b } = field;
  if (a == null || b == null || a === b) return '';
  return field.value.slice(a, b);
}

/**
 * Записать значение так, чтобы React увидел правку: голое `el.value = …` он
 * пропускает (свой value-tracker), нужен нативный сеттер плюс событие input.
 */
function setFieldValue(field: Field, value: string, caret: number) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Вставить текст в поле поверх выделения (или в каретку). */
function insertIntoField(field: Field, text: string) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const next = field.value.slice(0, start) + text + field.value.slice(end);
  setFieldValue(field, next, start + text.length);
}

/** Подсказка вместо тихого «ничего не произошло», когда движок закрыл буфер. */
function clipboardBlocked(action: 'вставить' | 'скопировать', key: string) {
  toast(`Движок не даёт ${action} через меню — сработает с клавиатуры (${shortcut(key)}).`);
}

// ── Наборы пунктов ──────────────────────────────────────────────────────────

function sep(id: string): MenuEntry {
  return { id, separator: true };
}

/** Текст, выделенный на странице (вне полей ввода). */
export function pageSelection(): string {
  if (typeof window === 'undefined') return '';
  return (window.getSelection()?.toString() ?? '').trim();
}

/** Пункты редактируемого поля: вырезать / копировать / вставить / выделить всё. */
function editableEntries(el: Field | HTMLElement, selection: string): MenuEntry[] {
  const field = asField(el);
  const selected = field ? fieldSelection(field) : selection;
  const entries: MenuEntry[] = [];

  if (selected) {
    entries.push({
      id: 'cut',
      label: 'Вырезать',
      icon: 'cut',
      hint: shortcut('X'),
      run: async () => {
        if (!(await copyText(selected))) return clipboardBlocked('скопировать', 'X');
        if (field) insertIntoField(field, '');
        else document.execCommand('delete');
      },
    });
    entries.push({
      id: 'copy',
      label: 'Копировать',
      icon: 'copy',
      hint: shortcut('C'),
      run: async () => {
        if (!(await copyText(selected))) clipboardBlocked('скопировать', 'C');
      },
    });
  }

  entries.push({
    id: 'paste',
    label: 'Вставить',
    icon: 'paste',
    hint: shortcut('V'),
    run: async () => {
      const text = await readClipboard();
      if (text == null) return clipboardBlocked('вставить', 'V');
      if (!text) return;
      if (field) insertIntoField(field, text);
      else {
        (el as HTMLElement).focus();
        document.execCommand('insertText', false, text);
      }
    },
  });

  const hasText = field ? field.value.length > 0 : (el.textContent ?? '').length > 0;
  if (hasText) {
    entries.push({
      id: 'select-all',
      label: 'Выделить всё',
      icon: 'select-all',
      hint: shortcut('A'),
      run: () => {
        if (field) {
          field.focus();
          field.select();
          return;
        }
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      },
    });
  }
  return entries;
}

/** Пункты ссылки. Открываем родным кликом по самому элементу — как рукой. */
function linkEntries(a: HTMLAnchorElement): MenuEntry[] {
  const href = a.href;
  return [
    {
      id: 'link-open',
      label: 'Открыть ссылку',
      icon: 'link-open',
      run: () => a.click(),
    },
    {
      id: 'link-copy',
      label: 'Копировать адрес',
      icon: 'link',
      run: async () => {
        if (!(await copyText(href))) clipboardBlocked('скопировать', 'C');
      },
    },
  ];
}

/** Пункты картинки: сохранить (как у вложений — <a download>) и адрес. */
function imageEntries(img: HTMLImageElement): MenuEntry[] {
  const src = img.currentSrc || img.src;
  return [
    {
      id: 'img-save',
      label: 'Сохранить картинку',
      icon: 'download',
      run: () => {
        const a = document.createElement('a');
        a.href = src;
        a.download = img.dataset.filename || decodeURIComponent(src.split('/').pop() || 'image');
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    },
    {
      id: 'img-copy-link',
      label: 'Копировать адрес картинки',
      icon: 'link',
      run: async () => {
        if (!(await copyText(src))) clipboardBlocked('скопировать', 'C');
      },
    },
  ];
}

/** Последний рубеж: щёлкнули по пустому месту интерфейса. */
function shellEntries(): MenuEntry[] {
  return [
    {
      id: 'settings',
      label: 'Настройки…',
      icon: 'settings',
      run: () => useUiStore.getState().setSettingsOpen(true),
    },
    {
      id: 'reload',
      label: 'Перезагрузить relay',
      icon: 'refresh',
      hint: shortcut('R'),
      run: () => window.location.reload(),
    },
  ];
}

/**
 * Что предложить для конкретной цели щелчка. Порядок — от частного к общему:
 * поле ввода → ссылка/картинка → выделенный текст. Ничего не подошло — пусто,
 * дальше решает `openContextMenu` (свои пункты экрана или меню оболочки).
 *
 * Отдельная чистая функция: набор пунктов проверяется тестами без рендера
 * (lib/context-menu.test.ts).
 */
export function targetEntries(target: Element | null, selection = pageSelection()): MenuEntry[] {
  const editable = editableOf(target);
  if (editable) return editableEntries(editable, selection);

  const entries: MenuEntry[] = [];
  const link = target?.closest('a[href]');
  if (link instanceof HTMLAnchorElement) entries.push(...linkEntries(link));

  const img = target?.closest('img');
  if (img instanceof HTMLImageElement && (img.currentSrc || img.src)) {
    if (entries.length) entries.push(sep('sep-img'));
    entries.push(...imageEntries(img));
  }

  if (selection) {
    if (entries.length) entries.push(sep('sep-sel'));
    entries.push({
      id: 'copy-selection',
      label: 'Копировать',
      icon: 'copy',
      hint: shortcut('C'),
      run: async () => {
        if (!(await copyText(selection))) clipboardBlocked('скопировать', 'C');
      },
    });
  }
  return entries;
}

// ── Открытие ────────────────────────────────────────────────────────────────

export interface OpenOptions {
  /** Моно-заголовок над списком («Сообщение от …»). */
  label?: string;
  /** Не добавлять пункты цели (когда экран знает лучше). */
  bare?: boolean;
}

/**
 * Открыть меню на событии `contextmenu`. Свои пункты идут первыми, за ними —
 * то, что даёт сама цель (адрес ссылки, копирование выделенного). Пустых меню
 * не показываем: щелчок по пустому месту даёт короткое меню оболочки.
 *
 * Событию ставим preventDefault — это же и метка «здесь уже разобрались» для
 * общего обработчика в ContextMenu.tsx.
 */
export function openContextMenu(
  event: {
    preventDefault: () => void;
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  },
  own: (MenuEntry | null | false | undefined)[] = [],
  opts: OpenOptions = {},
) {
  event.preventDefault();
  const target = event.target instanceof Element ? event.target : null;
  const mine = own.filter(Boolean) as MenuEntry[];
  const rest = opts.bare ? [] : targetEntries(target);

  let entries: MenuEntry[] =
    mine.length && rest.length ? [...mine, sep('sep-own'), ...rest] : [...mine, ...rest];
  if (!entries.length) entries = shellEntries();

  useContextMenuStore.getState().open({
    x: event.clientX,
    y: event.clientY,
    entries,
    label: opts.label,
  });
}

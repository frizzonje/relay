// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DmDrawer } from './DmDrawer';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';
import { useUiStore } from '@/stores/ui';

/**
 * Док ЛС на десктопе: раскрыт — колонка со списком, свёрнут — НИЧЕГО. Тест
 * держит именно это «ничего»: ни ширины, ни списка на странице. Свёрнутый док,
 * оставляющий на экране хоть полоску, — та самая жалоба, из-за которой всё это
 * и переписано: раздел, которым не пользуются, не должен занимать место.
 *
 * «Списка нет» здесь значит буквально нет в разметке, а не спрятан
 * прозрачностью: невидимый текст на странице остаётся текстом — его находит
 * поиск по странице и читает экранный диктор (см. комментарий в DmDrawer).
 *
 * Геометрию — что раскрытый док занимает СВОЮ полосу и не накрывает соседа, а
 * свёрнутый возвращает раскладку к прежней — держит e2e
 * (`e2e/tests/dm.spec.ts`): в jsdom раскладки нет, и проверить её здесь можно
 * было бы только сверкой классов, то есть пересказом разметки.
 */

const slug = 'dm-0123456789abcdef01234567';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(): void {
  act(() => root.render(<DmDrawer />));
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('док ЛС на десктопе', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDmStore.getState().reset();
    useUnreadStore.setState({ lastRead: {} });
    useUiStore.setState({ dmSection: false, view: 'lobby', dmRoom: null, pendingScene: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('свёрнутый не занимает ничего и списка на странице не оставляет', () => {
    render();
    const dock = el('dm-dock') as HTMLElement;
    expect(dock.getAttribute('data-open')).toBeNull();
    expect(dock.style.width).toBe('0px');
    expect(el('dm-drawer')).toBeNull();
  });

  it('раскрытый — список на своей ширине и кнопка «свернуть»', () => {
    useUiStore.setState({ dmSection: true });
    render();
    const dock = el('dm-dock') as HTMLElement;
    const drawer = el('dm-drawer') as HTMLElement;
    expect(dock.getAttribute('data-open')).toBe('true');
    expect(dock.style.width).toBe('232px');
    expect(drawer).toBeTruthy();
    // Список занял док целиком: пустой рамки рядом с ним не остаётся.
    expect(drawer.style.width).toBe(dock.style.width);

    const collapse = [...drawer.querySelectorAll('button')].find((b) =>
      /Свернуть|Collapse/i.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(collapse).toBeTruthy();
    act(() => collapse!.click());
    expect(useUiStore.getState().dmSection).toBe(false);
  });

  it('уезжая, список остаётся на экране, но уже недоступен', () => {
    useUiStore.setState({ dmSection: true });
    render();
    act(() => useUiStore.getState().toggleDmSection());

    // Створка едет 240 мс, и всё это время списку есть что показывать: снять
    // его сразу значило бы показать пустой проём — «моргнула», а не «уехала».
    const drawer = el('dm-drawer') as HTMLElement;
    expect(drawer).toBeTruthy();
    expect((el('dm-dock') as HTMLElement).style.width).toBe('0px');
    // Видна она на этом пути или нет — работать с ней уже нельзя: `inert`
    // убирает уезжающую панель с клавиатуры и из речи диктора сразу.
    expect(drawer.hasAttribute('inert')).toBe(true);
  });

  it('свернув с клавиатуры, фокус не теряется, а возвращается в рейку', () => {
    const entry = document.createElement('button');
    entry.id = 'dm-entry';
    document.body.appendChild(entry);

    useUiStore.setState({ dmSection: true });
    render();
    const collapse = [...el('dm-drawer')!.querySelectorAll('button')].find((b) =>
      /Свернуть|Collapse/i.test(b.getAttribute('aria-label') ?? ''),
    )!;
    collapse.focus();
    act(() => collapse.click());

    // Иначе фокус остался бы на узле, который вот-вот снимут со страницы, и
    // следующий Tab начал бы обход заново — с самого верха документа.
    expect(document.activeElement).toBe(entry);
    entry.remove();
  });

  it('свёрнутый счёт непрочитанного не прячет — он на кнопке рейки', () => {
    useDmStore.getState().setConversations([
      {
        slug,
        peer: { fingerprint: '6668-7aad-f862-bd77', nick: 'Марта' },
        lastTs: 9000,
        preview: 'привет',
        previewMine: false,
      },
    ]);
    render();
    // Здесь только договор: своих меток у свёрнутого дока нет и быть не должно,
    // а бейдж на цели «ЛС» проверяет toolbar.test.tsx — там, где он и живёт.
    expect(el('dm-dock')!.textContent).toBe('');
  });
});

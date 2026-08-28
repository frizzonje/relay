// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DmDrawer } from './DmDrawer';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';
import { useUiStore } from '@/stores/ui';

/**
 * Док ЛС на десктопе не исчезает, а сжимается до язычка: это одна колонка в
 * двух состояниях. Тест держит именно эту пару — раскрытый список ИЛИ язычок,
 * никогда оба и никогда ни одного, — и то, что язычок разворачивает, а не
 * переключает: в беседу приходят и лицом из рейки, при свёрнутом списке, и
 * тумблер на этом шаге закрывал бы список ровно тогда, когда его просили
 * открыть.
 *
 * «Списка нет» здесь значит буквально нет в разметке: невидимый текст на
 * странице остаётся текстом — его находит поиск по странице и читает экранный
 * диктор (см. комментарий в DmDrawer).
 *
 * Геометрию — что док занимает СВОЮ полосу и не накрывает соседа — держит
 * e2e (`e2e/tests/dm.spec.ts`): в jsdom раскладки нет, и проверить её здесь
 * можно было бы только сверкой классов, то есть пересказом разметки.
 */

const slug = 'dm-0123456789abcdef01234567';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(): void {
  act(() => root.render(<DmDrawer />));
}

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('панель ЛС на десктопе', () => {
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

  it('свёрнутый — на экране язычок, а списка нет вовсе', () => {
    render();
    expect(el('dm-tab')).toBeTruthy();
    expect(el('dm-dock')!.getAttribute('data-open')).toBeNull();
    expect(el('dm-drawer')).toBeNull();
  });

  it('язычок разворачивает панель, а не переключает её', () => {
    render();
    const tab = el('dm-tab') as HTMLButtonElement;
    act(() => tab.click());
    expect(useUiStore.getState().dmSection).toBe(true);
    // Второй зов того же обработчика не должен закрывать: язычок отвечает на
    // «покажи», и другого ответа у него нет.
    act(() => tab.click());
    expect(useUiStore.getState().dmSection).toBe(true);
  });

  it('раскрытая — на экране список и кнопка «свернуть», язычка нет', () => {
    useUiStore.setState({ dmSection: true });
    render();
    const drawer = el('dm-drawer')!;
    expect(drawer).toBeTruthy();
    expect(el('dm-dock')!.getAttribute('data-open')).toBe('true');
    // Язычок не «гаснет поверх» раскрытого списка, а перестаёт существовать:
    // это то же самое место разметки, и двух состояний разом у него нет.
    expect(el('dm-tab')).toBeNull();
    const collapse = [...drawer.querySelectorAll('button')].find((b) =>
      /Свернуть|Collapse/i.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(collapse).toBeTruthy();
    act(() => collapse!.click());
    expect(useUiStore.getState().dmSection).toBe(false);
  });

  it('на язычке видно непрочитанное — иначе оно спрятано вместе с панелью', () => {
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
    expect(el('dm-tab')!.querySelector('span[aria-hidden]')).toBeTruthy();

    useUnreadStore.setState({ lastRead: { [slug]: 9000 } });
    render();
    expect(el('dm-tab')!.querySelector('span[aria-hidden]')).toBeNull();
  });
});

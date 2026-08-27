// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DmConversation } from '@relay/shared';
import { Toolbar } from './Toolbar';
import { useDmStore } from '@/stores/dm';
import { useUnreadStore } from '@/stores/unread';
import { useUiStore } from '@/stores/ui';

/**
 * Полоса тулбара на телефоне. Проверяем то, ради чего лица вообще появились в
 * рейке (задача 11) и чего до этой задачи на телефоне не было вовсе: перейти к
 * тому, с кем и так переписываешься, — один тап, не открывая раздела.
 *
 * Компонент лица общий с рейкой; тест сторожит именно мобильную половину, где
 * решения другие (метка непрочитанного ВНУТРИ цели, а не на внешнем крае —
 * внешнего края у горизонтальной полосы нет).
 */

const conversations: DmConversation[] = [
  {
    slug: 'dm-0123456789abcdef01234567',
    peer: { nick: 'Марта', fingerprint: '6668-7aad-f862-bd77' },
    lastTs: 2000,
    preview: 'о деле',
    previewMine: false,
  },
  {
    slug: 'dm-89abcdef0123456789abcdef',
    peer: { nick: 'Игорь', fingerprint: '1111-2222-3333-4444' },
    lastTs: 1000,
    preview: 'ага',
    previewMine: true,
  },
];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Узкий экран: `useIsMobile` спрашивает про него `matchMedia`, а jsdom
 *  отвечает «не совпало» на любой запрос. Без подмены рисовалась бы рейка. */
function narrowScreen(): void {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function render(): void {
  act(() => root.render(<Toolbar />));
}

function faces(): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')].filter((b) =>
    conversations.some((c) => c.peer.nick === b.getAttribute('aria-label')),
  );
}

describe('полоса тулбара на телефоне', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    narrowScreen();
    useUiStore.setState({
      view: 'lobby',
      textRoom: null,
      dmRoom: null,
      dmPeer: null,
      dmSection: false,
      pendingScene: null,
      stageLive: false,
    });
    useDmStore.getState().reset();
    useUnreadStore.setState({ lastRead: {} });
    useDmStore.getState().setConversations(conversations);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('под тремя целями стоят лица, и каждое — цель не меньше 44px', () => {
    render();
    expect(faces().map((b) => b.getAttribute('aria-label'))).toEqual(['Марта', 'Игорь']);
    for (const face of faces()) expect(face.className).toContain('h-11');
  });

  it('тап по лицу открывает беседу', () => {
    render();
    act(() => faces()[0].click());
    expect(useUiStore.getState().dmRoom).toBe(conversations[0].slug);
    expect(useUiStore.getState().dmPeer).toBe(conversations[0].peer.fingerprint);
  });

  it('непрочитанное помечено точкой внутри цели, а не за её краем', () => {
    // Первую беседу дочитали, вторую нет — так проверка отличает «метка есть»
    // от «метка нарисована всем подряд».
    useUnreadStore.setState({ lastRead: { [conversations[0].slug]: 5000 } });
    render();
    const [read, unread] = faces();
    // `:scope >` обязателен: само лицо — тоже `span[aria-hidden]` (Identicon
    // прячет рисунок от скринридера), и без него проверка нашла бы его.
    const mark = (face: HTMLButtonElement) =>
      face.parentElement?.querySelector(':scope > span[aria-hidden]') ?? null;
    expect(mark(read)).toBeNull();
    const dot = mark(unread);
    expect(dot).toBeTruthy();
    // Внутри цели: у отрицательных отступов рейки на полосе соседнее лицо
    // стоит вплотную, и метка легла бы на него.
    expect(dot!.className).not.toMatch(/-right-/);
  });
});

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

  it('под целями стоят лица, и каждое — цель не меньше 44px', () => {
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

describe('цели тулбара', () => {
  /** Широкий экран: без подмены `matchMedia` jsdom и так отвечает «нет». */
  function wide(): void {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  const target = (label: RegExp) =>
    [...host.querySelectorAll('button')].find((b) =>
      label.test(b.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    wide();
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
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('выключенные цели остаются доступны мышью и с клавиатуры', () => {
    // Это конвенция проекта, а не вкус: HTML `disabled` выбрасывает кнопку из
    // обхода табом и глушит наведение, а тултип и `aria-label` со «скоро» —
    // единственное, что объясняет нарисованную, но мёртвую кнопку. Регрессия
    // такого рода в ветке уже случалась (карточка собеседника, f0e4711), и
    // ревью ветки показало, что здесь, в самом компоненте, где конвенция и
    // заведена, её не стерёг никто: `disabled` возвращался — 555 тестов
    // оставались зелёными.
    render();
    const button = target(/Админ|Admin/);
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toMatch(/скоро|soon/i);
  });

  it('звонка среди целей нет', () => {
    // Звонят человеку, а не «вообще»: кнопка стоит в шапке беседы и в карточке
    // собеседника, где он назван. Цель в рейке вела бы к тому же выбору
    // собеседника, то есть в те же ЛС, — лишний шаг, притворяющийся разделом.
    render();
    expect(target(/Звонок|Call/)).toBeUndefined();
  });

  it('бейдж на «ЛС» считает беседы с непрочитанным', () => {
    useDmStore.getState().setConversations(conversations);
    useUnreadStore.setState({ lastRead: { [conversations[0].slug]: 5000 } });
    render();

    const direct = host.querySelector('[data-testid="toolbar-direct"]') as HTMLButtonElement;
    const badge = direct.querySelector('span[aria-hidden]');
    // Прочитана одна из двух — на бейдже единица, а не «две беседы вообще».
    expect(badge?.textContent).toBe('1');
    // Цифра спрятана от диктора: без названия «1» ему ничего не говорит.
    expect(direct.getAttribute('aria-label')).toMatch(/1 .*(переписк|conversation)/i);
  });

  it('всё прочитано — бейджа нет вовсе', () => {
    useDmStore.getState().setConversations(conversations);
    useUnreadStore.setState({
      lastRead: { [conversations[0].slug]: 5000, [conversations[1].slug]: 5000 },
    });
    render();

    const direct = host.querySelector('[data-testid="toolbar-direct"]') as HTMLButtonElement;
    expect(direct.querySelector('span[aria-hidden]')).toBeNull();
    expect(direct.getAttribute('aria-label')).not.toMatch(/\d/);
  });
});

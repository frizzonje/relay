// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchHit } from '@relay/shared';
import { SearchPanel } from './SearchPanel';
import { useDmStore } from '@/stores/dm';
import { useSearchStore } from '@/stores/search';
import { useUiStore } from '@/stores/ui';

/**
 * Панель поиска в БЕСЕДЕ. В канале она работает давно и проверена e2e; здесь
 * стережётся то, чего до ревью ветки не было: находка из переписки не должна
 * подписываться сырым адресом (`#dm-0123456789abcdef…` — это адрес, показанный
 * человеку вместо имени), а выбор охвата не должен предлагать «весь сервер»,
 * которого в беседе не бывает — сервер там `scope` игнорирует.
 *
 * Рендерим по-настоящему в DOM тем же приёмом, что dm-list.test.tsx.
 */

// Запрос уходит по таймеру набора; сеть в тесте не нужна — важна разметка.
vi.mock('@/lib/channels', () => ({ ask: vi.fn(async () => null) }));

const slug = 'dm-0123456789abcdef01234567';
const nick = 'Марта';

function hit(): SearchHit {
  return { slug, message: { id: '1', name: 'Марта', text: 'дача', ts: 1 } };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<SearchPanel />));
  return host.innerHTML;
}

describe('поиск в беседе', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDmStore.getState().reset();
    useDmStore.setState({
      conversations: [
        {
          slug,
          peer: { fingerprint: '6668-7aad-f862-bd77', nick },
          lastTs: 1,
          preview: 'дача',
          previewMine: false,
        },
      ],
    });
    useUiStore.setState({
      view: 'dm',
      dmRoom: slug,
      dmPeer: '6668-7aad-f862-bd77',
      textRoom: null,
    });
    useSearchStore.setState({
      open: true,
      query: 'дача',
      scope: 'channel',
      terms: ['дача'],
      hits: [hit()],
      more: false,
      loading: false,
      asked: true,
      failed: false,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUiStore.setState({ view: 'lobby', dmRoom: null, dmPeer: null });
  });

  it('находка подписана ником собеседника, а не адресом беседы', () => {
    const html = markup();
    expect(html).toContain(nick);
    expect(html).not.toContain(slug);
  });

  it('в беседе не предлагают искать «по всему серверу»', () => {
    markup();
    const scopes = [...host.querySelectorAll('button[aria-pressed]')];
    expect(scopes).toHaveLength(0);
  });

  it('в канале переключатель охвата на месте', () => {
    useUiStore.setState({ view: 'text', dmRoom: null, textRoom: 'obshchii', textLabel: 'общий' });
    markup();
    const scopes = [...host.querySelectorAll('button[aria-pressed]')];
    expect(scopes).toHaveLength(2);
  });
});

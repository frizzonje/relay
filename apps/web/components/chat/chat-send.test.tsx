// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '@relay/shared';
import { useChatStore } from '@/stores/chat';
import { useConfigStore } from '@/stores/config';
import { useUiStore } from '@/stores/ui';

const emit = vi.fn();
vi.mock('@/lib/socket', () => ({
  getSocket: () => ({ emit, on: () => {}, off: () => {}, connected: true }),
}));
vi.mock('@/lib/use-sfu', () => ({ useRetention: () => ({ days: 0, mode: 'forever' as const }) }));
vi.mock('@/lib/notify', async (load) => ({
  ...(await load<typeof import('@/lib/notify')>()),
  notifySent: () => {},
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatPanel } from './ChatPanel';

/**
 * Реплика уходит без адреса: сервер кладёт её в комнату, где сокет сейчас.
 * Пока грузится вложение, человек может уйти в другой канал или беседу — и
 * файл с набранным текстом не должны уехать туда, другим людям.
 */
describe('send while switching feeds', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let upload: (r: Response) => void;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (upload = resolve))),
    );
    emit.mockClear();
    useConfigStore.setState({ settings: defaults() });
    useChatStore.getState().reset();
    useUiStore.setState({ view: 'text', textRoom: 'alpha', textLabel: 'alpha', dmRoom: null });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ChatPanel />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('a file and text sent from one channel do not land in the next', async () => {
    const file = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(file, 'files', {
      value: [new File(['x'], 'a.txt', { type: 'text/plain' })],
      configurable: true,
    });
    act(() => {
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const input = host.querySelector('form input:not([type="file"])') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'секрет для alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    emit.mockClear();
    act(() => useUiStore.setState({ textRoom: 'beta', textLabel: 'beta' }));
    emit.mockClear();
    await act(async () => {
      upload(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(emit.mock.calls.filter(([event]) => event === 'chat-message')).toEqual([]);
  });
});

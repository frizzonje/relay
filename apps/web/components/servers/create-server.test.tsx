// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults, type ServerCreateResult } from '@relay/shared';
import { useConfigStore } from '@/stores/config';
import { useServersStore } from '@/stores/servers';
import { useUiStore } from '@/stores/ui';

let answer!: (res: ServerCreateResult) => void;
vi.mock('@/lib/servers', async (orig) => ({
  ...(await orig<typeof import('@/lib/servers')>()),
  createServer: vi.fn(() => new Promise<ServerCreateResult>((resolve) => (answer = resolve))),
}));

import { CreateServerDialog } from './CreateServerDialog';

/**
 * «Отмену» и Esc ожидание ответа не держит. Человек передумал, пока сервер
 * заводился, — поздний «готово» раньше всё равно переводил его на новый сервер
 * и открывал окно «создайте первый канал», которое он уже отменил.
 */
describe('CreateServerDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useConfigStore.setState({ settings: defaults() });
    useServersStore.getState().setActiveServer('srv-old');
    useUiStore.setState({ createChannelOpen: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('a server created after Cancel does not take the person there', async () => {
    act(() => root.render(<CreateServerDialog open onOpenChange={() => {}} />));
    const input = document.querySelector('form input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'Новый');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    act(() => root.render(<CreateServerDialog open={false} onOpenChange={() => {}} />));
    await act(async () => {
      answer({ ok: true } as ServerCreateResult);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(useServersStore.getState().activeServerId).toBe('srv-old');
    expect(useUiStore.getState().createChannelOpen).toBe(false);
  });
});

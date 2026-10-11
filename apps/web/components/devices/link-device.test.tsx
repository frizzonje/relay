// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tx } from '@/lib/i18n';
import { useIdentityStore } from '@/stores/identity';

vi.mock('@/lib/devices', async (orig) => ({
  ...(await orig<typeof import('@/lib/devices')>()),
  askPairing: vi.fn(async () => ({ code: '428913', expiresIn: 180_000 })),
}));
vi.mock('@/lib/identity-login', () => ({ whoAmI: vi.fn() }));
vi.mock('@/lib/qr', () => ({ qrPath: () => '' }));

import { whoAmI } from '@/lib/identity-login';
import { LinkDeviceDialog } from './LinkDevicePanel';

/**
 * Новое устройство ждёт, пока его впустят, опрашивая «кто я». Сигнал — сервер
 * ответил «никто» (сессия ушла в чужую личность) или другой личностью. Обрыв
 * сети или 5xx — не ответ: на нём экран объявлял «связано» и перезагружался,
 * хотя никто никого не впускал.
 */
describe('LinkDevicePanel polling', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    useIdentityStore.setState({ me: { id: 'me-1' } as never });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('a failed poll is not a link', async () => {
    vi.mocked(whoAmI).mockRejectedValue(new Error('offline'));
    await act(async () => {
      root.render(<LinkDeviceDialog open onOpenChange={() => {}} />);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(document.body.textContent).not.toContain(tx('pair.link.done'));
  });

  it('“nobody” from the server is the link', async () => {
    vi.mocked(whoAmI).mockResolvedValue(null);
    await act(async () => {
      root.render(<LinkDeviceDialog open onOpenChange={() => {}} />);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(document.body.textContent).toContain(tx('pair.link.done'));
  });
});

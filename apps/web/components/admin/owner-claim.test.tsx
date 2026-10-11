// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/lib/i18n/messages/en.json';
import { useIdentityStore } from '@/stores/identity';
import { useOwnerStore } from '@/stores/owner';

const claims = new Map<string, () => void>();
vi.mock('@/lib/owner', async (orig) => ({
  ...(await orig<typeof import('@/lib/owner')>()),
  claimOwner: vi.fn((token: string) => new Promise<void>((resolve) => claims.set(token, resolve))),
}));

import { OwnerClaimDialog } from './OwnerClaimDialog';

/**
 * Окно со ссылкой A закрыли, пока шла заявка, и открыли новую ссылку B.
 * Ответ про A не должен объявить «установка ваша» на экране B — по ссылке,
 * которую ещё никто не предъявлял.
 */
describe('OwnerClaimDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    claims.clear();
    vi.spyOn(useOwnerStore.getState(), 'refresh').mockResolvedValue(undefined as never);
    useIdentityStore.setState({
      me: { id: 'me', fingerprint: '6668-7aad-f862-bd77', nick: 'я' } as never,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<OwnerClaimDialog />));
  });

  afterEach(() => {
    act(() => useOwnerStore.getState().close());
    act(() => root.unmount());
    host.remove();
  });

  it('the answer for a closed link does not mark the next one as claimed', async () => {
    act(() => useOwnerStore.getState().claim('token-a'));
    const take = [...document.querySelectorAll('button')].at(-1)!;
    act(() => take.click());
    act(() => useOwnerStore.getState().close());
    act(() => useOwnerStore.getState().claim('token-b'));

    await act(async () => {
      claims.get('token-a')!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(en['owner.done']);
  });
});

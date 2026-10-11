// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useTargetAction } from './use-target-action';

type Target = { id: string };

function harness() {
  let api!: ReturnType<typeof useTargetAction<Target>>;
  function Probe({ target }: { target: Target | null }) {
    api = useTargetAction(target);
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  return {
    show: (target: Target | null) => act(() => root.render(<Probe target={target} />)),
    api: () => api,
  };
}

/**
 * Удаление канала A ушло на сервер, окно закрыли Esc и открыли удаление B.
 * Ответ «удалено» про A раньше закрывал окно B — человек не успевал ни
 * подтвердить, ни передумать.
 */
describe('useTargetAction', () => {
  it('an answer about the previous target does not close the dialog for the next one', async () => {
    const h = harness();
    const a = { id: 'a' };
    const b = { id: 'b' };
    h.show(a);
    let answer!: (ok: boolean) => void;
    const done = vi.fn();
    let pending!: Promise<void>;
    act(() => {
      pending = h.api().run(() => new Promise<boolean>((r) => (answer = r)), done);
    });
    h.show(null);
    h.show(b);
    await act(async () => {
      answer(true);
      await pending;
    });
    expect(done).not.toHaveBeenCalled();
    expect(h.api().busy).toBe(false);
  });

  it('an answer about the same target closes it', async () => {
    const h = harness();
    const a = { id: 'a' };
    h.show(a);
    const done = vi.fn();
    await act(async () => {
      await h.api().run(async () => true, done);
    });
    expect(done).toHaveBeenCalledOnce();
  });
});

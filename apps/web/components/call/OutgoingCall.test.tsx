// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallPerson, DmOpenResult } from '@relay/shared';

/**
 * Экран исходящего вызова (задача 6 плана B). `lib/call.ts` и `lib/channels.ts`
 * подделаны тем же приёмом, что в `DmPeerCard.test.tsx`: экрану важно, что
 * кнопки доходят до правильных действий, а не как устроен сам протокол —
 * машину дозвона проверяют `stores/ring.test.ts` и `lib/call.test.ts`.
 */
vi.mock('@/lib/call', () => ({ dialCall: vi.fn(), hangUp: vi.fn() }));
vi.mock('@/lib/channels', () => ({ ask: vi.fn() }));
const openDm = vi.fn();
vi.mock('@/stores/ui', () => ({ useUiStore: { getState: () => ({ openDm }) } }));

const { dialCall, hangUp } = await import('@/lib/call');
const { ask } = await import('@/lib/channels');
const { useRingStore } = await import('@/stores/ring');
const { OutgoingCall } = await import('./OutgoingCall');

const PEER: CallPerson = { fingerprint: 'ff', nick: 'Боря' };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<OutgoingCall />));
  return host.innerHTML;
}

describe('экран исходящего вызова', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useRingStore.getState().reset();
    vi.mocked(dialCall).mockReset().mockResolvedValue({ ok: true, ringId: 'r1' });
    vi.mocked(hangUp).mockReset();
    vi.mocked(ask).mockReset();
    openDm.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('ничего не рисует, пока вызова нет', () => {
    expect(markup()).toBe('');
  });

  it('104px лицо с расходящимися кольцами, «дозваниваемся» и строка о доставке — на экране, а не в документации', async () => {
    await act(() => useRingStore.getState().start(PEER));
    const out = markup();
    expect(host.querySelector('svg')).toBeTruthy();
    expect(out).toContain('Боря');
    expect(out).toMatch(/calling/i);
    expect(host.querySelectorAll('.animate-ping')).toHaveLength(2);
    // Честное ограничение — прямо на этом экране (глобальное ограничение
    // плана 2.0), а не только в docs/plans/relay-2.0.md.
    expect(out).toMatch(/relay is open|web app/i);
  });

  it.each([
    ['declined', /declined/i],
    ['no-answer', /no answer/i],
    ['busy', /busy/i],
    ['failed', /not online/i],
  ] as const)('состояние %s переключает подпись, и кольца гаснут', async (state, pattern) => {
    await act(() => useRingStore.getState().start(PEER));
    act(() =>
      useRingStore
        .getState()
        .applyEnded({ ringId: 'r1', state, peer: PEER, at: Date.now(), missed: true }),
    );
    const out = markup();
    expect(out).toMatch(pattern);
    expect(host.querySelectorAll('.animate-ping')).toHaveLength(0);
  });

  it('отказ ДО дозвона («offline» на ack call-start) рисует ту же подпись, что и «failed» посреди дозвона', async () => {
    vi.mocked(dialCall).mockResolvedValueOnce({ ok: false, error: 'offline' });
    await act(() => useRingStore.getState().start(PEER));
    const out = markup();
    expect(out).toMatch(/not online/i);
  });

  it('«Отбой» шлёт call-cancel через lib/call.ts и закрывает экран', async () => {
    await act(() => useRingStore.getState().start(PEER));
    markup();
    const hangUpButton = host.querySelectorAll('button')[1] as HTMLButtonElement;
    act(() => hangUpButton.click());
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(markup()).toBe('');
  });

  it('Escape делает ровно то же, что и кнопка «Отбой»', async () => {
    await act(() => useRingStore.getState().start(PEER));
    markup();
    const dialog = host.querySelector('[role="dialog"]') as HTMLDivElement;
    act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(markup()).toBe('');
  });

  it('«Write instead» уводит в переписку, не роняя вызов дважды', async () => {
    await act(() => useRingStore.getState().start(PEER));
    const conversation: DmOpenResult = {
      ok: true,
      conversation: {
        slug: 'dm-0123456789abcdef01234567',
        peer: PEER,
        lastTs: 0,
        preview: '',
        previewMine: false,
      },
    };
    vi.mocked(ask).mockResolvedValue(conversation);

    markup();
    const writeButton = host.querySelectorAll('button')[0] as HTMLButtonElement;
    act(() => writeButton.click());

    // Экран закрывается сразу, отбой уходит РОВНО один раз.
    expect(markup()).toBe('');
    expect(hangUp).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(openDm).toHaveBeenCalledWith('dm-0123456789abcdef01234567', 'ff', 'Боря'),
    );

    // Экран уже закрыт — второй нажатия попросту неоткуда взять (кнопки нет
    // на экране), но и «эхо» отбоя с сервера (`call-ended{cancelled}`) не
    // должно провоцировать второй `hangUp()`.
    act(() =>
      useRingStore.getState().applyEnded({
        ringId: 'r1',
        state: 'cancelled',
        peer: PEER,
        at: Date.now(),
        missed: false,
      }),
    );
    expect(hangUp).toHaveBeenCalledTimes(1);
  });
});

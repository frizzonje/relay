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
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(),
  hangUp: vi.fn(),
  cancelCall: vi.fn(),
  ownedCall: vi.fn(() => null),
}));
vi.mock('@/lib/channels', () => ({ ask: vi.fn() }));
const openDm = vi.fn();
vi.mock('@/stores/ui', () => ({ useUiStore: { getState: () => ({ openDm }) } }));

const { dialCall, hangUp, ownedCall } = await import('@/lib/call');
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
    // Настоящий `dialCall` объявляет вызов своим (`mine` в lib/call.ts) —
    // подделка обязана повторять это, иначе «Отбой» на СВОЁМ наборе пошёл бы
    // веткой соседнего устройства (см. `endRing` в stores/ring.ts).
    vi.mocked(dialCall)
      .mockReset()
      .mockImplementation(async () => {
        vi.mocked(ownedCall).mockReturnValue('r1');
        return { ok: true, ringId: 'r1' };
      });
    vi.mocked(hangUp).mockReset();
    vi.mocked(ownedCall).mockReset().mockReturnValue(null);
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

  it('Escape делает ровно то же, что и кнопка «Отбой» — с того места, где фокус на самом деле', async () => {
    // Кнопка, с которой звонили, стоит ПОД экраном и до открытия держит фокус.
    const caller = document.createElement('button');
    document.body.appendChild(caller);
    caller.focus();

    await act(() => useRingStore.getState().start(PEER));
    markup();

    // Экран забирает фокус себе. Без этого Escape не дошёл бы до диалога
    // никогда: React разносит события по дереву компонентов от того, на ком
    // они случились, а случаются они на том, что в фокусе, — то есть на
    // кнопке снаружи оверлея. Прежний тест этого не ловил, потому что слал
    // событие прямо в диалог — условие, которого настоящая страница не даёт.
    const hangUpButton = host.querySelectorAll('button')[1] as HTMLButtonElement;
    expect(document.activeElement).toBe(hangUpButton);

    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(markup()).toBe('');

    // Экран погас — фокус возвращается туда, откуда его взяли, а не в `body`.
    expect(document.activeElement).toBe(caller);
    caller.remove();
  });

  it('«Написать вместо звонка» — цель не меньше 44px', async () => {
    // reference/direct-messages/README.md: «Все цели ≥44px». Отступы давали
    // ~40px: 68px отбой и 104px лицо в норме, а эта кнопка — нет.
    // jsdom не считает раскладку, поэтому проверяем ровно то, что задаёт
    // высоту, — класс минимальной высоты.
    await act(() => useRingStore.getState().start(PEER));
    markup();
    const writeButton = host.querySelectorAll('button')[0] as HTMLButtonElement;
    expect(writeButton.className).toContain('min-h-[44px]');
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

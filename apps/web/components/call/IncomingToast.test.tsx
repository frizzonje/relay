// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallIncomingRelay, CallPerson } from '@relay/shared';

/**
 * Тост входящего (задача 7 плана B). `lib/call.ts` подделан тем же приёмом,
 * что в `OutgoingCall.test.tsx`: экрану важно, что кнопки доходят до нужных
 * действий, а не как устроен сам протокол (это машина `stores/ring.test.ts`
 * и обработчики `lib/call.test.ts`). `lib/sfx.ts` и `lib/notify.ts` подделаны
 * тоже — тосту важно, что звук СТАРТУЕТ и ГАСНЕТ вместе с ним, а не как
 * устроен сам звуковой пул.
 */
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(),
  hangUp: vi.fn(),
  cancelCall: vi.fn(),
  answerCall: vi.fn(),
  declineCall: vi.fn(),
  ownedCall: vi.fn(() => null),
}));
const play = vi.fn();
const stop = vi.fn();
vi.mock('@/lib/sfx', () => ({ getSfx: () => ({ play, stop }) }));
const notifyClose = vi.fn();
const notifyCall = vi.fn(() => ({ close: notifyClose }));
vi.mock('@/lib/notify', () => ({ notifyCall }));

const { answerCall, declineCall } = await import('@/lib/call');
const { useRingStore } = await import('@/stores/ring');
const { IncomingToast } = await import('./IncomingToast');

const PEER: CallPerson = { fingerprint: 'ff', nick: 'Боря' };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<IncomingToast />));
  return host.innerHTML;
}

function ring(overrides: Partial<CallIncomingRelay> = {}) {
  act(() =>
    useRingStore.getState().applyIncoming({
      ringId: 'r1',
      from: PEER,
      at: Date.now(),
      video: false,
      ...overrides,
    }),
  );
}

describe('тост входящего', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useRingStore.getState().reset();
    vi.mocked(answerCall).mockReset();
    vi.mocked(declineCall).mockReset();
    play.mockClear();
    stop.mockClear();
    notifyClose.mockClear();
    notifyCall.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('ничего не рисует, пока входящего нет', () => {
    expect(markup()).toBe('');
  });

  it('лицо, ник, «звонит вам» — и НИКАКОГО role=dialog/aria-modal: тост не модалка', () => {
    ring();
    const out = markup();
    expect(out).toContain('Боря');
    expect(host.querySelector('svg')).toBeTruthy();
    // Бриф формулирует ограничение буквально: «не модалка». Экран исходящего
    // (`OutgoingCall`) — законная модалка со своими `role="dialog"`/
    // `aria-modal`; тост обязан НЕ иметь ни того, ни другого ни на одном узле.
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-modal]')).toBeNull();
  });

  it('видеозвонок называет себя видео ДО того, как на него ответили', () => {
    ring({ video: true });
    expect(markup()).toMatch(/video call/i);
  });

  it('голосовой звонок бейджа видео не рисует', () => {
    ring({ video: false });
    expect(markup()).not.toMatch(/video call/i);
  });

  it('не растягивается на весь экран — это карточка в углу, а не оверлей', () => {
    // Не единственная проверка «не модалка» (см. тест выше про role/aria-modal
    // и тест ниже про клик по интерфейсу под тостом) — но структурный признак
    // полноэкранного оверлея (`OutgoingCall` использует именно `inset-0`)
    // здесь обязан отсутствовать на любом узле.
    ring();
    markup();
    const root = host.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/\binset-0\b/);
    expect(root.className).not.toMatch(/\bh-screen\b|\bw-screen\b/);
  });

  it('«принять» и «отклонить» — обе цели 48px, что не меньше требуемых 44px', () => {
    // jsdom не считает раскладку — проверяем класс, который и задаёт высоту/
    // ширину (тот же приём, что в OutgoingCall.test.tsx для 44px-кнопки).
    ring();
    markup();
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.className).toMatch(/\bh-12\b/);
      expect(button.className).toMatch(/\bw-12\b/);
    }
  });

  it('«Принять» зовёт answerCall(ringId) и тост гаснет немедленно', () => {
    ring();
    markup();
    const acceptButton = host.querySelectorAll('button')[1] as HTMLButtonElement;
    act(() => acceptButton.click());
    expect(answerCall).toHaveBeenCalledWith('r1');
    expect(declineCall).not.toHaveBeenCalled();
    expect(markup()).toBe('');
  });

  it('«Отклонить» зовёт declineCall(ringId) и тост гаснет немедленно', () => {
    ring();
    markup();
    const declineButton = host.querySelectorAll('button')[0] as HTMLButtonElement;
    act(() => declineButton.click());
    expect(declineCall).toHaveBeenCalledWith('r1');
    expect(answerCall).not.toHaveBeenCalled();
    expect(markup()).toBe('');
  });

  it('интерфейс под тостом остаётся кликабельным — тост его не блокирует ничем в DOM', () => {
    // Буквальная проверка из брифа задачи 7: не отсутствие класса оверлея (его
    // и так проверяет отдельный тест выше), а то, что клик по элементу
    // ИНТЕРФЕЙСА, лежащему рядом с тостом на той же странице, реально
    // доходит до своего обработчика. Показывает ту категорию регрессии,
    // которую жёсткий фокус-трап или блокировка на уровне document ловят: и
    // то, и другое (в отличие от чистой CSS-заливки) действует и в jsdom.
    const background = document.createElement('button');
    background.textContent = 'Открытая переписка';
    document.body.appendChild(background);
    const onBackgroundClick = vi.fn();
    background.addEventListener('click', onBackgroundClick);

    ring();
    markup();
    act(() => background.click());

    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    background.remove();
  });

  it('не забирает фокус — в отличие от OutgoingCall, который это делает намеренно', () => {
    const background = document.createElement('button');
    document.body.appendChild(background);
    background.focus();
    expect(document.activeElement).toBe(background);

    ring();
    markup();

    // Открывшийся тост не должен сдвинуть фокус НИКУДА — ни на кнопку внутри
    // себя, ни на себя целиком. План требует «можно проигнорировать»: человек,
    // печатающий в поле, обязан продолжать печатать в него же.
    expect(document.activeElement).toBe(background);
    background.remove();
  });

  it('звук стартует, пока тост на экране, и гаснет вместе с ним — на любом исходе', () => {
    ring();
    markup();
    expect(play).toHaveBeenCalledWith('ring');
    expect(stop).not.toHaveBeenCalled();

    // Сам путь закрытия неважен — стор гасит `incoming` одинаково на приёме,
    // отказе, отбое, таймауте и обрыве сокета (см. stores/ring.test.ts); здесь
    // проверяется РЕАКЦИЯ компонента на факт закрытия, а не причина.
    act(() => useRingStore.getState().reset());
    markup();

    expect(stop).toHaveBeenCalledWith('ring');
  });

  it('системное уведомление запрашивается лицом и видео-флагом звонящего и закрывается вместе с тостом', () => {
    ring({ video: true });
    markup();
    expect(notifyCall).toHaveBeenCalledWith(PEER, true);
    expect(notifyClose).not.toHaveBeenCalled();

    act(() => useRingStore.getState().reset());
    markup();

    expect(notifyClose).toHaveBeenCalledTimes(1);
  });
});

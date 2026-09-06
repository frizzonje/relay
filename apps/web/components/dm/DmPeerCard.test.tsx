// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '@relay/shared';
import { dialCall } from '@/lib/call';
import { DmPeerCard } from './DmPeerCard';
import { shortFingerprint } from '@/lib/format';
import { useUiStore } from '@/stores/ui';
import { usePresenceStore } from '@/stores/presence';
import { useConfigStore } from '@/stores/config';
import { useRingStore } from '@/stores/ring';

/**
 * `lib/call.ts` (не `stores/ring.ts`) — вот что здесь подделано, тем же
 * приёмом, что `people-picker.test.tsx` подделывает `ask` из `lib/channels`:
 * карточке важно, что клик действительно доходит до набора номера, а
 * дублировать протокол дозвона второй подделкой незачем (настоящее поведение
 * машины дозвона проверяют `lib/call.test.ts` и `stores/ring.test.ts`).
 */
vi.mock('@/lib/call', () => ({
  dialCall: vi.fn(async () => ({ ok: true, ringId: 'r1' })),
  hangUp: vi.fn(),
}));

/**
 * Карточка собеседника (232px, задача 11 плана A). Присутствие — из
 * глобального стора (`stores/presence.ts`, задача 2 плана B), тот же, что и
 * точка в шапке беседы (DmThread) и в списке переписок (DmList).
 *
 * Кнопка звонка (задача 6 плана B) теперь живая — раньше была нарисована, но
 * выключена насовсем («скоро»). Инсталляция всё ещё может её погасить
 * (`calls.enabled: false` или `calls.whoCanCall: 'nobody'`, см. `useCallGate`
 * в `stores/ring.ts`), и тем же способом, что раньше был здесь постоянно: БЕЗ
 * HTML `disabled` — иначе кнопка выпала бы из обхода табом вместе с
 * единственным объяснением, почему она мертва. Тест сторожит именно это: в
 * выключенном состоянии `aria-disabled` есть, `disabled` нет, кнопка достижима
 * с клавиатуры, а тултип на месте; во включённом — кнопка живая, `aria-disabled`
 * не ставится вовсе, и клик действительно набирает номер.
 */
const fingerprint = '6668-7aad-f862-bd77';
const nick = 'Марта';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function markup(): string {
  act(() => root.render(<DmPeerCard />));
  return host.innerHTML;
}

describe('карточка собеседника', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useUiStore.setState({ dmPeer: fingerprint, textLabel: nick });
    usePresenceStore.getState().reset();
    useConfigStore.setState({ settings: defaults() });
    useRingStore.getState().reset();
    vi.mocked(dialCall).mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('показывает лицо, ник и отпечаток', () => {
    const out = markup();
    expect(host.querySelector('svg')).toBeTruthy();
    expect(out).toContain(nick);
    expect(out).toContain(shortFingerprint(fingerprint));
  });

  it('без записи в сторе присутствия карточка честно говорит «не в сети»', () => {
    const out = markup();
    expect(/не в сети|offline/i.test(out)).toBe(true);
  });

  it('живая запись в сторе присутствия меняет статус и точку', () => {
    usePresenceStore.getState().applySnapshot([{ fingerprint, state: 'online', since: 1000 }]);
    const out = markup();
    expect(/в сети|online/i.test(out)).toBe(true);
    expect(/не в сети/i.test(out)).toBe(false);
  });

  it('без выбранного собеседника ничего не рисует', () => {
    useUiStore.setState({ dmPeer: null, textLabel: '' });
    const out = markup();
    expect(out).toBe('');
  });

  it('дозвон разрешён по умолчанию: кнопка живая и набирает номер', () => {
    markup();
    const button = host.querySelector('button') as HTMLButtonElement;
    // Ровно то, чего нельзя делать даже у живой кнопки: `aria-disabled` не
    // ставится вовсе, а не в `"false"`.
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(dialCall).toHaveBeenCalledWith(fingerprint, false);
  });

  it('`calls.enabled: false` гасит кнопку, но не роняет её из обхода табом', () => {
    useConfigStore.setState({ settings: { ...defaults(), 'calls.enabled': false } });
    const out = markup();
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    expect(out).toMatch(/выключен|turned off/i);
    act(() => button.click());
    expect(dialCall).not.toHaveBeenCalled();
  });

  it('`calls.whoCanCall: nobody` гасит кнопку той же честной причиной', () => {
    useConfigStore.setState({ settings: { ...defaults(), 'calls.whoCanCall': 'nobody' } });
    const out = markup();
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(out).toMatch(/нельзя позвонить|can't call/i);
  });

  it('видеозвонок не предлагается, когда его не пускает инсталляция', () => {
    useConfigStore.setState({ settings: { ...defaults(), 'calls.videoAllowed': false } });
    const out = markup();
    expect(out).not.toMatch(/видеозвонок|video call/i);
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });

  it('видеозвонок набирает номер с камерой', () => {
    useConfigStore.setState({ settings: { ...defaults(), 'calls.videoAllowed': true } });
    markup();
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(dialCall).toHaveBeenCalledWith(fingerprint, true);
  });
});

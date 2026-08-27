// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DmPeerCard } from './DmPeerCard';
import { shortFingerprint } from '@/lib/format';
import { useUiStore } from '@/stores/ui';

/**
 * Карточка собеседника (232px, задача 11). Присутствия в этапе A нет —
 * оно приедет вместе со звонком 1:1 (план B, docs/plans/relay-2.0-calls.md),
 * а до тех пор карточка обязана честно говорить «неизвестно», а не рисовать
 * зелёную точку из голосового присутствия по ошибке. Кнопка звонка выключена
 * тем же способом, что Call/Admin в Toolbar (задача 8): БЕЗ HTML `disabled`,
 * иначе она выпала бы из обхода табом вместе с единственным объяснением, почему
 * она мертва. Поэтому тест сторожит обратное: `aria-disabled` есть, `disabled`
 * нет, кнопка достижима с клавиатуры, а тултип на месте.
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

  it('присутствие честно «неизвестно», звонок выключен с тултипом «скоро»', () => {
    const out = markup();
    expect(/неизвестно|unknown/i.test(out)).toBe(true);
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Ровно то, чего нельзя делать: HTML `disabled` унёс бы кнопку из обхода
    // табом, и человек с клавиатурой не услышал бы «скоро» вовсе.
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    expect(button.title).toMatch(/скоро|soon/i);
    expect(button.getAttribute('aria-label')).toMatch(/скоро|soon/i);
  });

  it('без выбранного собеседника ничего не рисует', () => {
    useUiStore.setState({ dmPeer: null, textLabel: '' });
    const out = markup();
    expect(out).toBe('');
  });
});

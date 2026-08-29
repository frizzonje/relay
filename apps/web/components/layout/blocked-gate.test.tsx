// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockedGate } from './BlockedGate';
import en from '@/lib/i18n/messages/en.json';
import { useContractStore } from '@/stores/contract';

/**
 * Экран для того, кого не пустили по адресу.
 *
 * Проверяется здесь не разметка, а то, ради чего экран заведён: отвергнутому
 * ГОВОРЯТ, что случилось, и говорят не банными словами. За одним адресом сидит
 * подъезд, институт, оператор — попавший под маску мог не делать ничего, и
 * «вас забанили» обвинило бы его в чужом.
 */

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useContractStore.setState({ blocked: false });
});

/** Диалог рисуется порталом — искать надо по всему документу, а не в host. */
const said = () => document.querySelector('[data-testid="blocked-message"]');

describe('закрытый адрес объясняет себя', () => {
  it('пока адрес открыт, экрана нет', () => {
    act(() => root.render(<BlockedGate />));
    expect(said()).toBeNull();
  });

  it('отвергнутому говорят про адрес, а не про бан', () => {
    act(() => useContractStore.getState().setBlocked(true));
    act(() => root.render(<BlockedGate />));
    expect(said()?.textContent).toBe(en['blocked.body']);
    // Слово «забанен» здесь не должно встретиться ни в каком виде: это другая
    // новость и по ней надо делать другое.
    expect(document.body.textContent).not.toContain(en['moderation.banned.title']);
  });

  it('кнопки «повторить» нет: клиент стучится сам', () => {
    // Экран пропадёт в тот миг, когда владелец снимет маску, — нажимать для
    // этого нечего и не надо.
    act(() => useContractStore.getState().setBlocked(true));
    act(() => root.render(<BlockedGate />));
    expect(document.querySelectorAll('[data-testid="blocked-message"] button')).toHaveLength(0);
  });
});

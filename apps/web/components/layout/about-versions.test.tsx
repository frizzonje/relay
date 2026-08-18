// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getServerVersion = vi.hoisted(() => vi.fn(async () => ''));
vi.mock('@/lib/config', () => ({ getServerVersion, isSfuAvailable: async () => false }));
const clientVersion = vi.hoisted(() => vi.fn(() => ''));
vi.mock('@/lib/version', () => ({ clientVersion }));

import { AboutPanel } from './AboutPanel';
import { useDesktopStore } from '@/stores/desktop';

/**
 * About существует ради одного вопроса: почему тут всё странно себя ведёт.
 *
 * Самый частый ответ — вкладка пережила обновление сервера и работает на
 * старом коде. Никакой другой подсказки об этом человек не получит, поэтому
 * проверяется именно граница «жаловаться / молчать»: обвинить исправную
 * инсталляцию в рассинхроне так же плохо, как промолчать о настоящем.
 */
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(): Promise<string> {
  await act(async () => {
    root.render(<AboutPanel />);
  });
  return host.innerText || host.textContent || '';
}

describe('About: версии клиента и сервера', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useDesktopStore.setState({ isDesktop: false, shell: null });
    clientVersion.mockReturnValue('');
    getServerVersion.mockResolvedValue('');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('версии сходятся — жаловаться не на что', async () => {
    clientVersion.mockReturnValue('1.0.0');
    getServerVersion.mockResolvedValue('1.0.0');
    const out = await render();
    expect(out).toContain('1.0.0');
    expect(out).not.toContain('Reload the page');
  });

  it('вкладка старее сервера — это и есть тот случай, ради которого экран', async () => {
    clientVersion.mockReturnValue('1.0.0');
    getServerVersion.mockResolvedValue('1.0.1');
    expect(await render()).toContain('Reload the page');
  });

  /**
   * Сборка из исходников номера не имеет вовсе, и это не «другая версия».
   * Иначе каждый, кто поднял relay через `docker compose build`, видел бы
   * жалобу на пустом месте — и перестал бы ей верить к тому дню, когда она
   * окажется настоящей.
   */
  it('номера нет — это не расхождение', async () => {
    clientVersion.mockReturnValue('');
    getServerVersion.mockResolvedValue('1.0.0');
    expect(await render()).not.toContain('Reload the page');

    clientVersion.mockReturnValue('1.0.0');
    getServerVersion.mockResolvedValue('');
    expect(await render()).not.toContain('Reload the page');
  });

  it('пока сервер не ответил, обвинять его не в чем', async () => {
    clientVersion.mockReturnValue('1.0.0');
    let settle: (v: string) => void = () => {};
    getServerVersion.mockReturnValue(
      new Promise<string>((res) => {
        settle = res;
      }),
    );
    const out = await render();
    expect(out).not.toContain('Reload the page');
    // Досматриваем до конца: брошенный на полпути промис доедет уже после
    // размонтирования и пожалуется на обновление вне act — шум в выводе
    // теста стоит дорого, к нему быстро привыкают.
    await act(async () => {
      settle('1.0.0');
    });
  });

  it('на десктопе рядом стоит и версия самой оболочки', async () => {
    clientVersion.mockReturnValue('1.0.0');
    getServerVersion.mockResolvedValue('1.0.0');
    useDesktopStore.setState({
      isDesktop: true,
      shell: {
        version: '1.0.0',
        ptt: null,
        pttDefault: 'Alt+A',
        pttError: null,
        autostart: false,
        autostartError: null,
      },
    });
    expect(await render()).toContain('App');
  });
});

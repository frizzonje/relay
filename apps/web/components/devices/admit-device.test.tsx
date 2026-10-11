// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairOffer } from '@relay/shared';
import { usePairingStore } from '@/stores/pairing';
import { tx } from '@/lib/i18n';

const peeks = new Map<string, { resolve: (o: PairOffer) => void }>();
vi.mock('@/lib/devices', async (orig) => ({
  ...(await orig<typeof import('@/lib/devices')>()),
  peekPairing: vi.fn(
    (code: string) => new Promise<PairOffer>((resolve) => peeks.set(code, { resolve })),
  ),
}));

import { AdmitDeviceDialog } from './AdmitDeviceDialog';

const offer = (deviceName: string): PairOffer => ({
  publicKey: 'A'.repeat(43),
  fingerprint: '6668-7aad-f862-bd77',
  deviceName,
  expiresIn: 60_000,
});

describe('AdmitDeviceDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    peeks.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<AdmitDeviceDialog />));
  });

  afterEach(() => {
    act(() => usePairingStore.getState().close());
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /**
   * Вопрос «разрешить камеру?» длится сколько угодно. Окно закрыли, пока он
   * висел, — уборка сканера уже прошла, и поток, выданный следом, некому было
   * остановить: лампочка камеры горела до перезагрузки.
   */
  it('a camera granted after the dialog closed is stopped', async () => {
    const stop = vi.fn();
    let grant!: (s: MediaStream) => void;
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)),
      },
    });
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      detect = async () => [];
    };

    act(() => usePairingStore.getState().admit(''));
    const scan = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === tx('pair.admit.scan'),
    )!;
    act(() => scan.click());
    act(() => usePairingStore.getState().close());

    await act(async () => {
      grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalled();
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  });

  /**
   * Код из ссылки проверяется сразу. Окно с кодом A закрыли и открыли ссылкой
   * с кодом B — ответ про A, доехав последним, не должен встать под B: человек
   * подтвердил бы чужое устройство, глядя на экран, открытый ради своего.
   */
  it('a late answer for a previous code does not show under the new one', async () => {
    act(() => usePairingStore.getState().admit('111111'));
    act(() => usePairingStore.getState().close());
    act(() => usePairingStore.getState().admit('222222'));

    await act(async () => {
      peeks.get('111111')!.resolve(offer('Чужой ноутбук'));
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain('Чужой ноутбук');

    await act(async () => {
      peeks.get('222222')!.resolve(offer('Мой телефон'));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Мой телефон');
  });
});

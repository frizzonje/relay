// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/voice', () => ({ setScreenMode: vi.fn(), setScreenSetup: vi.fn() }));
vi.mock('@/stores/config', () => ({
  useSetting: (key: string) => (key === 'voice.screenMaxHeight' ? '1440' : 15000),
}));
const isWebKit = vi.hoisted(() => vi.fn(() => false));
vi.mock('@/lib/voice/engine', () => ({ isWebKit, WEBKIT_SCREEN_MAX_FPS: 30 }));

import { StreamSettings } from './StreamSettings';
import { useVoiceStore } from '@/stores/voice';

/**
 * «Ставлю 2K — у зрителя 620p» (2026-10-04): Safari снимает экран не выше
 * размера в точках и 30 к/с, что бы ни выбрал человек. Вкладка, где он
 * выбирает 2K, обязана сказать это прямо — и только там, где это правда.
 */
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(): Promise<string> {
  await act(async () => {
    root.render(<StreamSettings />);
  });
  return host.textContent || '';
}

describe('вкладка «Трансляция»: предел движка', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window.screen, 'width', { value: 1280, configurable: true });
    Object.defineProperty(window.screen, 'height', { value: 800, configurable: true });
    useVoiceStore.setState({
      screenMode: 'quality',
      screenSetups: { quality: { height: 1440, fps: 30 }, fps: { height: 720, fps: 30 } },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('WebKit: пояснение с размером экрана и пометка у режима, который выше предела', async () => {
    isWebKit.mockReturnValue(true);
    const out = await render();
    expect(out).toContain('1280×800 here');
    expect(out).toContain('browser: up to 800p30');
    // «Плавность» 720p30 в предел влезает — пометки у неё нет.
    expect(out.match(/browser: up to/g)).toHaveLength(1);
  });

  it('остальные движки — ни пояснения, ни пометок', async () => {
    isWebKit.mockReturnValue(false);
    const out = await render();
    expect(out).not.toContain('looks like');
    expect(out).not.toContain('browser: up to');
  });
});

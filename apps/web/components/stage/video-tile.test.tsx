// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceTile } from '@/stores/voice';
import { VideoTile } from './VideoTile';

/** Дорожка, которая помнит, кто на неё подписан. */
class FakeTrack extends EventTarget {
  kind = 'video';
  enabled = true;
  muted = false;
  readyState = 'live';
  listeners = 0;
  getSettings() {
    return { height: 720 };
  }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.listeners += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
}

class FakeStream extends EventTarget {
  constructor(private tracks: FakeTrack[]) {
    super();
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return [];
  }
}

function tile(stream: FakeStream): VoiceTile {
  return {
    id: 'peer',
    name: 'Марта',
    stream: stream as unknown as MediaStream,
    state: '',
    isLocal: false,
    screen: false,
  };
}

/**
 * Дорожки живут дольше плитки: поток держит стор голоса, и плитка его только
 * показывает. Подписки плитки на дорожку уходят вместе с ней — иначе каждая
 * перерисовка с новым потоком и каждый уход плитки оставляли на живой дорожке
 * обработчик, который зовёт setState у размонтированного компонента.
 */
describe('VideoTile track listeners', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => host.remove());

  it('unmounting the tile removes its listeners from a still-live track', () => {
    const track = new FakeTrack();
    act(() => root.render(<VideoTile tile={tile(new FakeStream([track]))} focused={false} />));
    expect(track.listeners).toBeGreaterThan(0);
    act(() => root.unmount());
    expect(track.listeners).toBe(0);
  });

  it('switching the stream releases the previous stream’s tracks', () => {
    const first = new FakeTrack();
    const second = new FakeTrack();
    act(() => root.render(<VideoTile tile={tile(new FakeStream([first]))} focused={false} />));
    act(() => root.render(<VideoTile tile={tile(new FakeStream([second]))} focused={false} />));
    expect(first.listeners).toBe(0);
    act(() => root.unmount());
  });
});

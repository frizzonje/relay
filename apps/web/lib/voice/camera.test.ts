// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Камера между нажатием и разрешением. Запрос `getUserMedia` висит, пока
 * человек читает системный вопрос «разрешить камеру?», — секунды, за которые он
 * успевает нажать ещё раз или выйти из звонка. Проверяется то, что ломается
 * молча: вторая дорожка, которую никто не остановит (лампочка камеры горит до
 * перезагрузки), и дорожка, легшая в звонок, из которого уже вышли.
 */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('@/lib/voice/desktop-screen-audio', () => ({
  isDesktopWindows: () => false,
  notifyScreenPicker: () => {},
  startNativeScreenAudio: async () => null,
  stopNativeScreenAudio: async () => {},
}));
vi.mock('@/lib/voice/tiles', () => ({ setTileScreen: () => {} }));

class FakeTrack {
  kind = 'video';
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  label = 'cam';
  onended: (() => void) | null = null;
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: 'cam-1' };
  }
}

class FakeStream {
  tracks: FakeTrack[] = [];
  getVideoTracks() {
    return this.tracks;
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

/** Ответы на `getUserMedia`, которые тест отпускает сам. */
const asked: { resolve: (s: unknown) => void; track: FakeTrack }[] = [];

function grant(n: number) {
  const { resolve, track } = asked[n];
  resolve({ getVideoTracks: () => [track], getTracks: () => [track] });
}

let call: FakeStream | null;

async function boot() {
  vi.resetModules();
  asked.length = 0;
  call = new FakeStream();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            asked.push({ resolve, track: new FakeTrack() });
          }),
      ),
      getDisplayMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            asked.push({ resolve, track: new FakeTrack() });
          }),
      ),
      enumerateDevices: async () => [],
    },
  });
  const camera = await import('./camera');
  camera.initCamera({
    stream: () => call as unknown as MediaStream,
    maySend: () => true,
    publish: () => {},
    unpublish: () => {},
    retune: () => {},
    transport: () => 'mesh',
    syncStore: () => {},
    announce: () => {},
  });
  return camera;
}

beforeEach(() => {
  call = null;
});

describe('камера, пока висит вопрос о разрешении', () => {
  it('второе нажатие не открывает вторую камеру', async () => {
    const camera = await boot();
    const first = camera.toggleCamera();
    const second = camera.toggleCamera();
    await second;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

    grant(0);
    await first;
    expect(call!.tracks).toHaveLength(1);
    expect(camera.isCamOn()).toBe(true);
  });

  it('вышли из звонка до ответа — дорожка остановлена, а не легла в чужой поток', async () => {
    const camera = await boot();
    const pending = camera.toggleCamera();
    // Выход: дирижёр гасит поток и отпускает видео-слот.
    camera.teardownVideo();
    call = null;

    grant(0);
    await expect(pending).resolves.toBeUndefined();
    expect(asked[0].track.readyState).toBe('ended');
    expect(camera.isCamOn()).toBe(false);
  });

  it('вышли и сразу вошли снова — старая дорожка в новый звонок не попадает', async () => {
    const camera = await boot();
    const pending = camera.toggleCamera();
    camera.teardownVideo();
    call = new FakeStream();

    grant(0);
    await pending;
    expect(call.tracks).toHaveLength(0);
    expect(asked[0].track.readyState).toBe('ended');
  });
});

describe('экран, пока открыт выбор источника', () => {
  it('вышли из звонка до выбора — захват остановлен, а не лёг в чужой поток', async () => {
    const camera = await boot();
    const pending = camera.toggleScreen();
    // Пока выбор открыт, второе нажатие второго выбора не открывает.
    await camera.toggleScreen();
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);

    camera.teardownVideo();
    call = null;
    grant(0);
    await expect(pending).resolves.toBeUndefined();
    expect(asked[0].track.readyState).toBe('ended');
    expect(camera.isScreenOn()).toBe(false);
  });
});

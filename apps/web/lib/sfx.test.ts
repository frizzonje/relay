// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Единственное, что отличает `ring` от всех остальных девяти сигналов пула
 * (задача 7 плана B): он зациклен. Остальные звучат один раз и гаснут сами —
 * этот обязан звонить, пока вызов жив, и не мгновением дольше.
 *
 * Проверяется реальный `HTMLAudioElement.loop`, а не косвенный признак:
 * `FakeAudio` — не заглушка вслепую, а подделка, которая КОПИТ созданные
 * себя, чтобы тест мог достать именно ТОТ элемент, что завёл `play()`, и
 * прочитать его `loop` напрямую — то самое свойство, которое `sfx.ts`
 * действительно выставляет и от которого зависит браузер.
 */

class FakeAudio {
  static instances: FakeAudio[] = [];
  loop = false;
  volume = 1;
  currentTime = 0;
  src: string;
  constructor(src?: string) {
    this.src = src ?? '';
    FakeAudio.instances.push(this);
  }
  addEventListener() {}
  play() {
    return Promise.resolve();
  }
  pause() {}
}

async function fresh() {
  vi.resetModules();
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  const { getSfx } = await import('./sfx');
  return getSfx();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ring — единственный зацикленный сигнал пула', () => {
  it('play("ring") ставит loop=true на настоящем элементе', async () => {
    const sfx = await fresh();
    sfx.play('ring');
    const el = FakeAudio.instances.at(-1)!;
    expect(el.src).toBe('/sfx/ring.mp3');
    expect(el.loop).toBe(true);
  });

  it.each([
    'join',
    'leave',
    'peerJoin',
    'peerLeave',
    'error',
    'connLost',
    'reconnect',
    'message',
    'send',
    'receive',
  ] as const)('play("%s") НЕ зациклен — иначе он звучал бы вечно', async (name) => {
    const sfx = await fresh();
    sfx.play(name);
    const el = FakeAudio.instances.at(-1)!;
    expect(el.loop).toBe(false);
  });

  it('stop("ring") останавливает зацикленный элемент и обнуляет его позицию', async () => {
    const sfx = await fresh();
    sfx.play('ring');
    const el = FakeAudio.instances.at(-1)!;
    el.currentTime = 5;

    sfx.stop('ring');

    expect(el.currentTime).toBe(0);
  });
});

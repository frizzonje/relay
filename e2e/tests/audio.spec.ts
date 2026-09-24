import { expect, type Page } from '@playwright/test';
import { connected, joinVoice, person, test, unique } from '../fixtures/stand';

/**
 * Что уходит в сеть со звуком — то, чего не видно глазами и не слышно в CI.
 *
 * Три обещания из docs/plans/voice-quality.md, каждое из которых ломается
 * молча: голос договорён с RED (порядок кодеков в голосовой m-линии — по нему
 * и выбирают, чем слать; getStats RED не показывает), голос моно (stereo=0),
 * а при пороге в сеть уходит дорожка устройства, которую затвор выключает, —
 * а не выход Web Audio (у того нет deviceId).
 *
 * Канал — «P2P общий»: RED и стерео живут только в прямых звонках.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** Все соединения страницы — в window.__pcs, раньше, чем приложение создаст первое. */
function trackPeerConnections() {
  const Native = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      pcs.push(this);
    }
  } as typeof RTCPeerConnection;
}

/** Первый кодек и stereo голосовой (первой аудио) m-линии — своей и собеседника. */
function voiceLine(page: Page) {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs.filter((p) => p.connectionState === 'connected').at(-1)!;
    const read = (sdp: string) => {
      const audio = sdp.split(/\r\n(?=m=)/).find((s) => s.startsWith('m=audio'))!;
      const lines = audio.split('\r\n');
      const pts = lines[0].split(' ').slice(3);
      const codec = (pt: string) =>
        (lines.find((l) => l.startsWith(`a=rtpmap:${pt} `)) ?? '')
          .split(' ')[1]
          ?.split('/')[0]
          .toLowerCase();
      const opus = pts.find((pt) => codec(pt) === 'opus');
      const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${opus} `)) ?? '';
      return { first: codec(pts[0]), stereo: /[; ]stereo=(\d)/.exec(fmtp)?.[1] };
    };
    return { local: read(pc.localDescription!.sdp), remote: read(pc.remoteDescription!.sdp) };
  });
}

/** Дорожка, которую реально отдаёт отправитель голоса. */
function sentVoice(page: Page) {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs.filter((p) => p.connectionState === 'connected').at(-1)!;
    const track = pc.getSenders().find((s) => s.track?.kind === 'audio')?.track;
    return { deviceId: track?.getSettings().deviceId ?? '', enabled: track?.enabled };
  });
}

test('голос уходит моно и с RED, а порог глушит дорожку устройства', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const opts = { permissions: ['microphone'], initScript: trackPeerConnections };
  const anya = await person(browser, her, opts);
  const boris = await person(browser, him, opts);

  await joinVoice(anya, 'P2P общий', her);
  await joinVoice(boris, 'P2P общий', him);
  await connected(anya);
  await connected(boris);

  // Каждая сторона ставит RED первым у себя — значит, RED шлют обе.
  for (const page of [anya, boris]) {
    expect(await voiceLine(page)).toEqual({
      local: { first: 'red', stereo: '0' },
      remote: { first: 'red', stereo: '0' },
    });
  }

  // Порог на максимум: в сеть по-прежнему уходит дорожка устройства, и затвор
  // её выключает. Фейковый микрофон Chromium пищит раз в секунду — затвор может
  // приоткрыться на писке, поэтому ждём закрытого состояния опросом.
  await anya.getByRole('button', { name: 'Pick a microphone' }).click();
  const threshold = anya.getByLabel('Microphone activation threshold');
  await threshold.fill('100');
  await expect
    .poll(() => sentVoice(anya), { timeout: 15_000 })
    .toEqual({ deviceId: expect.stringMatching(/.+/), enabled: false });

  // Порог выключили — затвор открывается сразу.
  await threshold.fill('0');
  await expect.poll(() => sentVoice(anya), { timeout: 5_000 }).toMatchObject({ enabled: true });

  // Закрытый затвор не рвёт связь: пакеты тишины шли, сторож тишины молчал.
  await connected(boris);
});

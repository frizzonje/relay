import { expect, type Page } from '@playwright/test';
import {
  connected,
  createServer,
  createVoiceChannel,
  joinVoice,
  openServer,
  person,
  test,
  tile,
  unique,
} from '../fixtures/stand';

/**
 * Трансляция экрана через медиасервер — docs/plans/screen-share.md.
 *
 * Что здесь проверяется по-настоящему, а не на словах: стример отдаёт два слоя
 * simulcast (запасной 720p и полный кадр); к зрителю поток не идёт, пока он
 * не нажал «Смотреть»; нажал — получает полный кадр, что в плитке, что
 * развёрнутым (выбрал стример 2K — зритель видит 2K); «Перестать смотреть»
 * снимает поток. Экрана в контейнере нет, поэтому
 * `getDisplayMedia` подменён анимированным canvas 2560×1440@60 — путь от
 * дорожки до кодировщика и сервера при этом тот же.
 *
 * Аппаратного кодировщика в контейнере нет: стример кодирует VP8 программно,
 * и движок вправе урезать верхний слой под процессор. Поэтому проверяем
 * отношения («верхний крупнее нижнего»), а не точные 1440.
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

/**
 * До кода приложения: соединения страницы — в window.__pcs, а экран —
 * анимированный canvas. Функция уезжает в браузер целиком, поэтому всё внутри.
 */
function fakeScreenAndSpy() {
  const Native = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      pcs.push(this);
    }
  } as typeof RTCPeerConnection;

  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2560;
    canvas.height = 1440;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    // Мелкий текст по всему кадру и бегущая плашка: кодировщику есть что
    // кодировать, и каждый кадр отличается от прошлого.
    setInterval(() => {
      n += 1;
      ctx.fillStyle = '#1b1d22';
      ctx.fillRect(0, 0, 2560, 1440);
      ctx.fillStyle = '#d8dce4';
      ctx.font = '22px monospace';
      for (let row = 0; row < 52; row++) {
        ctx.fillText(`${row} relay screen share 1440p ${n} `.repeat(6), 8, 28 + row * 27);
      }
      ctx.fillStyle = '#ff5a5f';
      ctx.fillRect((n * 17) % 2400, 600, 160, 160);
    }, 1000 / 60);
    return canvas.captureStream(60);
  };
}

/** Своё исходящее видео: высоты кадров по слоям simulcast. */
function sentLayers(page: Page) {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const heights: Record<string, number> = {};
    for (const pc of pcs) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video' && r.frameHeight) {
          heights[r.rid ?? '-'] = r.frameHeight;
        }
      });
    }
    return heights;
  });
}

/** Входящее видео: высота кадра и сколько кадров принято (всё вместе). */
function received(page: Page) {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    let height = 0;
    let frames = 0;
    for (const pc of pcs) {
      if (pc.connectionState !== 'connected') continue;
      (await pc.getStats()).forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        frames += r.framesDecoded ?? 0;
        if (r.frameHeight && r.framesDecoded) height = Math.max(height, r.frameHeight);
      });
    }
    return { height, frames };
  });
}

/** Байты, принятые всеми соединениями страницы, — то, что реально идёт по сети. */
function bytesIn(page: Page) {
  return page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    let bytes = 0;
    for (const pc of pcs) {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'transport') bytes += r.bytesReceived ?? 0;
      });
    }
    return bytes;
  });
}

/** Сколько байт пришло за `ms`. */
async function flow(page: Page, ms: number) {
  const before = await bytesIn(page);
  await page.waitForTimeout(ms);
  return (await bytesIn(page)) - before;
}

test('трансляция: два слоя, поток только по «Смотреть», зрителю — полный кадр', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const home = unique('Студия');
  const room = unique('эфир');
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, {
    permissions: ['microphone'],
    initScript: fakeScreenAndSpy,
  });
  // Обычный монитор, без ретины: плитка в сетке заметно ниже кадра стримера —
  // и всё равно зритель получает полный кадр.
  const boris = await person(browser, him, {
    permissions: ['microphone'],
    initScript: fakeScreenAndSpy,
  });

  await createServer(anya, home, unique('текстовый'));
  await createVoiceChannel(anya, room, 'sfu');
  await openServer(boris, home);
  await joinVoice(anya, room, her);
  await joinVoice(boris, room, him);
  await connected(anya);
  await connected(boris);

  await anya.getByRole('button', { name: 'Share the screen' }).click();

  // Стример: два слоя, нижний ~720p, верхний крупнее, плашка с фактом.
  await expect
    .poll(async () => Object.keys(await sentLayers(anya)).length, { timeout: 30_000 })
    .toBe(2);
  await expect(anya.getByText(/\d+p · \d+ fps · [\d.]+ Mbit\/s · VP8/)).toBeVisible({
    timeout: 20_000,
  });
  // Имена слоям раздаёт mediasoup-client (r0, r1), так что — по высоте.
  const sent = await sentLayers(anya);
  console.log('слои стримера:', sent);
  const [low, high] = Object.values(sent).sort((a, b) => a - b);
  expect(low).toBeLessThanOrEqual(720);
  expect(high).toBeGreaterThan(low);

  // Зритель: предложение посмотреть, а потока нет.
  const watch = boris.getByRole('button', { name: 'Watch', exact: true });
  await expect(watch).toBeVisible({ timeout: 20_000 });
  await boris.waitForTimeout(3_000);
  expect((await received(boris)).frames).toBe(0);

  // «Смотреть» — сразу полный кадр, прямо в плитке. Медиасервер начинает с
  // осторожной оценки канала и может первые секунды отдать запасной слой.
  await watch.click();
  await expect.poll(async () => (await received(boris)).height, { timeout: 30_000 }).toBe(high);

  // Развернул на сцену и свернул обратно — кадр тот же. Ждём, а не смотрим
  // мгновенно: программный VP8 в контейнере временами душит верхний слой до
  // пары кадров, и медиасервер на это время честно переводит зрителя на
  // запасной — но обязан вернуть, как только верхний ожил.
  await tile(boris, her).click();
  await expect
    .poll(async () => (await received(boris)).height, { timeout: 30_000 })
    .toBe(high);
  await boris.getByRole('button', { name: `${her}: collapse` }).click();
  await expect
    .poll(async () => (await received(boris)).height, { timeout: 30_000 })
    .toBe(high);
  console.log('у зрителя:', await received(boris));

  // «Перестать смотреть» — кадры больше не идут, кнопка «Смотреть» вернулась.
  // И не только кадры: поток не должен идти и по сети — подписку закрыл
  // сервер, а не одна лишь вкладка зрителя. Сравниваем с тем, что шло во время
  // просмотра: после остаётся только голос.
  const watchingFlow = await flow(boris, 3_000);
  await tile(boris, her).hover();
  await boris.getByRole('button', { name: 'Stop watching' }).click();
  await expect(watch).toBeVisible({ timeout: 10_000 });
  const stopped = (await received(boris)).frames;
  await boris.waitForTimeout(1_000);
  const idleFlow = await flow(boris, 3_000);
  console.log('байт за 3 с: смотрит', watchingFlow, '— перестал', idleFlow);
  expect((await received(boris)).frames).toBeLessThanOrEqual(stopped);
  expect(idleFlow).toBeLessThan(watchingFlow / 4);
});

/**
 * Прямой канал: трансляция идёт с аплинка стримера каждому зрителю отдельно,
 * поэтому и здесь — только тем, кто нажал «Смотреть». Пока никто не смотрит,
 * плашка стримера честно говорит, что ничего не уходит.
 */
test('прямой канал: трансляция закрыта, пока зритель не нажал «Смотреть»', async ({ browser }) => {
  test.setTimeout(240_000);
  const home = unique('Студия');
  const room = unique('эфир');
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, {
    permissions: ['microphone'],
    initScript: fakeScreenAndSpy,
  });
  const boris = await person(browser, him, {
    permissions: ['microphone'],
    initScript: fakeScreenAndSpy,
  });

  await createServer(anya, home, unique('текстовый'));
  await createVoiceChannel(anya, room, 'p2p');
  await openServer(boris, home);
  await joinVoice(anya, room, her);
  await joinVoice(boris, room, him);
  await connected(anya);
  await connected(boris);

  await anya.getByRole('button', { name: 'Share the screen' }).click();
  await expect(anya.getByText(/nobody watching/)).toBeVisible({ timeout: 20_000 });

  const watch = boris.getByRole('button', { name: 'Watch', exact: true });
  await expect(watch).toBeVisible({ timeout: 20_000 });
  await boris.waitForTimeout(3_000);
  expect((await received(boris)).frames).toBe(0);

  await watch.click();
  await expect
    .poll(async () => (await received(boris)).frames, { timeout: 30_000 })
    .toBeGreaterThan(0);
  // Захват 2560×1440, потолок прямого канала — 720 строк.
  await expect.poll(async () => (await received(boris)).height, { timeout: 30_000 }).toBe(720);
  await expect(anya.getByText(/720p · \d+ fps · [\d.]+ Mbit\/s/)).toBeVisible({ timeout: 20_000 });

  await tile(boris, her).hover();
  await boris.getByRole('button', { name: 'Stop watching' }).click();
  await expect(watch).toBeVisible({ timeout: 10_000 });
  await expect(anya.getByText(/nobody watching/)).toBeVisible({ timeout: 20_000 });
});

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
import { CADDY_CONTAINER, dockerReachable, restartContainer } from '../fixtures/docker';

/**
 * Моргание сети посреди звонка через медиасервер.
 *
 * Сокет сигналинга рвётся от любой смены сетевого пути, а медиа по UDP такое
 * переживает. Раньше сессия на медиасервере умирала вместе с сокетом: сервер в
 * ту же секунду закрывал транспорты, собеседнику уходил `peer-left`, а клиент
 * через восемь секунд сдавался и входил заново — 13–50 секунд тишины в живом
 * звонке и тост «медиасервер недоступен» при исправном сервере (overhype,
 * 29.09, четыре раза за вечер у одного человека).
 *
 * Обрыв делаем перезапуском Caddy: он рвёт все веб-сокеты разом, а до самого
 * медиасервера RTP идёт мимо него. `setOffline` для этого не годится — уже
 * открытый веб-сокет он не закрывает.
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
 * Записать, если на странице хоть раз появится одна из фраз. Проверять
 * состояние после обрыва мало: тост «медиасервер недоступен» живёт четыре
 * секунды, а полный перезаход успевает закончиться — и тест, глядящий только
 * на итог, зеленел на том самом баге, который должен ловить.
 */
async function watch(page: Page, phrases: string[]) {
  await page.evaluate((list) => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    const check = () => {
      const text = document.body.innerText;
      for (const p of list) if (text.includes(p) && !seen.includes(p)) seen.push(p);
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, phrases);
}

const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

test('моргание сети под звонком через медиасервер: звонок продолжается, никто никуда не уходит', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  test.skip(!process.env.E2E_DISRUPTIVE, 'рвёт сокеты всей инсталляции — гоняется отдельным шагом');
  test.skip(!dockerReachable(), 'нужен проброшенный сокет docker: -v /var/run/docker.sock:...');

  const home = unique('Студия');
  const room = unique('переговорка');
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await createServer(anya, home, unique('текстовый'));
  await createVoiceChannel(anya, room, 'sfu');
  await openServer(boris, home);

  await joinVoice(anya, room, her);
  await joinVoice(boris, room, him);
  await expect(anya.getByText('via the server', { exact: true }).first()).toBeVisible({
    timeout: 45_000,
  });
  await connected(anya);
  await connected(boris);

  // Сдавшийся вход говорит тостом, разобранные транспорты — надписью на плитке.
  const alarms = ['media server is unavailable', 'Lost the server', 'reconnecting…'];
  await watch(anya, alarms);
  await watch(boris, alarms);

  expect(await restartContainer(CADDY_CONTAINER)).toBeLessThan(400);

  // Прежний путь сдавался через 8 с и входил заново к 13-й; ждём дольше.
  await anya.waitForTimeout(25_000);
  expect(await seen(anya)).toEqual([]);
  expect(await seen(boris)).toEqual([]);

  // Собеседники на месте, ровно по одному, и связь та же — через сервер.
  await expect(tile(anya, him)).toHaveCount(1);
  await expect(tile(boris, her)).toHaveCount(1);
  await expect(anya.getByText('direct', { exact: true })).toHaveCount(0);
  await connected(anya);
  await connected(boris);
});

import { expect, type Page } from '@playwright/test';
import {
  createServer,
  openChannel,
  openServer,
  person,
  say,
  secondDevice,
  test,
  unique,
} from '../fixtures/stand';

/**
 * Непрочитанное и настройки на личности — то, ради чего они на неё и переехали:
 * прочитал на одном устройстве, и на другом прочитано.
 *
 * «Второе устройство» здесь — новый контекст с той же сессионной кукой
 * личности (см. `secondDevice`). Настоящую связку по QR тут не гоняем — она
 * проверяется отдельно и к синхронизации отношения не имеет.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Чистить стенд между
 * прогонами не нужно: имена берутся через `unique` (см. fixtures/stand).
 */

/**
 * Горит ли точка «непрочитано» у канала. Спрашиваем так же, как её видит
 * человек: первая точка в строке канала, непрозрачная.
 */
function unreadDot(page: Page, channel: string): Promise<boolean> {
  return page.evaluate((name) => {
    const rows = [...document.querySelectorAll('[role="button"]')].filter((b) =>
      (b.textContent || '').includes(name),
    );
    rows.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const dot = rows[0]?.querySelector('span[aria-hidden="true"]');
    return !!dot && getComputedStyle(dot).opacity === '1';
  }, channel);
}

/** Дождаться нужного состояния точки — синхронизация приходит по сокету. */
async function waitDot(page: Page, channel: string, want: boolean) {
  await expect.poll(() => unreadDot(page, channel), { timeout: 20_000 }).toBe(want);
}

/**
 * Подпись колокольчика в строке канала: он и есть видимое состояние настройки
 * «звук на новые сообщения». Значок не кнопка (щелчок по строке открывает
 * канал), поэтому спрашиваем title, а не роль.
 */
function channelSoundTitle(page: Page, channel: string): Promise<string | null> {
  return page.evaluate((name) => {
    // Именем «общий» зовутся и текстовый канал, и голосовой; колокольчик есть
    // только у текстового, по нему строку и узнаём.
    for (const row of document.querySelectorAll('[role="button"]')) {
      if (!(row.textContent || '').includes(name)) continue;
      // Подсказку у svg даёт вложенный <title>, а не атрибут (см. Icon.tsx).
      for (const marked of row.querySelectorAll('svg > title')) {
        const title = marked.textContent || '';
        if (title.startsWith('New messages here')) return title;
      }
    }
    return null;
  }, channel);
}

test('прочитанное на одном устройстве прочитано и на другом', async ({ browser }) => {
  test.setTimeout(180_000);
  const kitchen = unique('Кухня');
  const room = unique('болталка');

  const anya = await person(browser, unique('Аня'));
  const boris = await person(browser, unique('Борис'));

  // Свой сервер с каналом: в открытом «общем» первое устройство прочитало бы
  // сказанное само собой, и проверять было бы нечего.
  await createServer(anya, kitchen, room);

  // Борис заходит на этот сервер и что-то говорит.
  await openServer(boris, kitchen);
  await openChannel(boris, room);
  await say(boris, 'первое слово');
  await expect(boris.getByText('первое слово').first()).toBeVisible({ timeout: 10_000 });

  // Второе устройство Ани: пустое хранилище, всё непрочитанное — с сервера.
  const laptop = await secondDevice(browser, anya);
  await openServer(laptop, kitchen);
  await waitDot(laptop, room, true);

  // Аня читает канал на первом устройстве.
  await openServer(anya, kitchen);
  await openChannel(anya, room);
  await expect(anya.getByText('первое слово').first()).toBeVisible({ timeout: 15_000 });

  // И на втором точка гаснет сама — без перезагрузки.
  await waitDot(laptop, room, false);
});

test('звук канала, включённый здесь, включён и на другом устройстве', async ({ browser }) => {
  test.setTimeout(180_000);
  const anya = await person(browser, unique('Аня'));

  // Включаем звук каналу через его меню.
  await anya.getByText('общий', { exact: true }).click({ button: 'right' });
  const sound = anya.getByText('Sound on new messages', { exact: true });
  await sound.waitFor({ state: 'visible', timeout: 10_000 });
  await sound.click();

  // На втором устройстве спрашиваем ровно там, где человек это и видит, — у
  // колокольчика в строке канала. Списка «что ездит с личностью» в настройках
  // больше нет (он выкинут намеренно), а сама настройка ездить не перестала.
  const laptop = await secondDevice(browser, anya);
  await expect
    .poll(() => channelSoundTitle(laptop, 'общий'), { timeout: 20_000 })
    .toBe('New messages here ping');
});

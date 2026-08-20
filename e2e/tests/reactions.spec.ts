import { expect, type Page } from '@playwright/test';
import {
  createServer,
  openChannel,
  openServer,
  person,
  say,
  test,
  unique,
} from '../fixtures/stand';

/**
 * Реакция принадлежит ключу, а не имени.
 *
 * Ники в relay свободные и не уникальные, и до 1.0 реакция подписывалась
 * именно ником (audit S1): двое под одним именем делили одну реакцию на
 * двоих — второй, нажав тот же эмодзи, снимал реакцию первого вместо того,
 * чтобы поставить свою. Поэтому здесь два человека НАРОЧНО названы одинаково:
 * на разных именах этот спек проходил бы и до починки.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены.
 */

/**
 * Чип реакции под репликой: эмодзи и число тех, кто его поставил. Ищем по
 * доступному имени целиком («🔥 1»), а не по одному эмодзи: тот же символ есть
 * и в пикере, который в этот момент может быть открыт.
 */
function chip(page: Page, text: string, emoji: string) {
  return page
    .locator('[data-feed] [data-mid]', { hasText: text })
    .first()
    .getByRole('button', { name: new RegExp(`^${emoji} \\d+$`) });
}

/** Поставить реакцию из пикера в тулбаре реплики. */
async function react(page: Page, text: string, emoji: string) {
  const row = page.locator('[data-feed] [data-mid]', { hasText: text }).first();
  await row.hover();
  await row.getByRole('button', { name: 'Add a reaction' }).click();
  await page.getByRole('button', { name: emoji, exact: true }).click();
  // Увести мышь с реплики: пикер закрывается по уходу, а пока он открыт, тот
  // же эмодзи виден на экране дважды.
  await page.mouse.move(0, 0);
}

test('тёзка не снимает чужую реакцию, а ставит свою', async ({ browser }) => {
  test.setTimeout(240_000);
  const home = unique('Дом');
  const room = unique('болталка');
  const word = 'чайник закипел';
  // Одно имя на двоих — это и есть условие проверки.
  const name = unique('Тёзка');

  const first = await person(browser, name);
  const second = await person(browser, name);

  await createServer(first, home, room);
  await openChannel(first, room);
  await say(first, word);

  await openServer(second, home);
  await openChannel(second, room);
  await expect(second.getByText(word)).toBeVisible({ timeout: 15_000 });

  // Первая ставит реакцию — вторая видит её у себя.
  await react(first, word, '🔥');
  await expect(chip(first, word, '🔥')).toHaveText(/1/, { timeout: 15_000 });
  await expect(chip(second, word, '🔥')).toHaveText(/1/, { timeout: 15_000 });

  // Тот же эмодзи от тёзки. До 1.0 счётчик обнулялся: сервер сверял имя и
  // считал чужую реакцию её собственной.
  await chip(second, word, '🔥').click();
  await expect(chip(second, word, '🔥')).toHaveText(/2/, { timeout: 15_000 });
  await expect(chip(first, word, '🔥')).toHaveText(/2/, { timeout: 15_000 });

  // А свою она снимает тем же нажатием — по отпечатку, а не по имени.
  await chip(second, word, '🔥').click();
  await expect(chip(second, word, '🔥')).toHaveText(/1/, { timeout: 15_000 });
  await expect(chip(first, word, '🔥')).toHaveText(/1/, { timeout: 15_000 });
});

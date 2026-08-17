import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Упоминания — и то, ради чего они существуют: не подсветка слова, а то, что
 * названный человек об этом узнаёт. Проверяем всю дорогу целиком: выбрать
 * человека из подсказки, увидеть имя выделенным, получить счётчик в чужом
 * канале — и погасить его, войдя туда.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Стенд должен быть чистым:
 * тест заводит свой сервер с каналами, и оставшиеся от прошлого прогона
 * одноимённые спутают и людей, и проверки.
 */

const PASSWORD = process.env.SITE_PASSWORD || '';
const BASE = process.env.BASE_URL || 'https://localhost';

async function person(browser: Browser, nick: string): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }]);
  const page = await ctx.newPage();
  await page.goto('/');

  const pass = page.getByPlaceholder('Password');
  if (PASSWORD && (await pass.isVisible().catch(() => false))) {
    await pass.fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  const cont = page.getByRole('button', { name: 'Continue' });
  await cont.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {});
  if (await cont.isVisible().catch(() => false)) {
    await page.locator('form input').first().fill(nick);
    await cont.click();
    await cont.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  }
  await expect(page.getByText('общий', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((n) => n.remove()));
  return page;
}

async function say(page: Page, text: string) {
  const composer = page.getByPlaceholder(/^message #/);
  await composer.fill(text);
  await composer.press('Enter');
}

/** Свой сервер с текстовым каналом — чтобы звать в своём разговоре, а не в чужом. */
async function ownChannel(page: Page, server: string, channel: string) {
  await page.locator('button[aria-label="Create a server"]').click();
  await page.getByPlaceholder('My server').fill(server);
  await page.getByRole('button', { name: 'Create server' }).click();
  const name = page.getByPlaceholder('new-channel');
  await name.waitFor({ state: 'visible', timeout: 15_000 });
  await name.fill(channel);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForTimeout(1500);
}

async function openChannel(page: Page, channel: string) {
  await page.getByText(channel, { exact: true }).click();
  await expect(page.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });
}

test('позвать по имени: подсказка, выделение и счётчик у названного', async ({ browser }) => {
  test.setTimeout(240_000);
  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  await ownChannel(anya, 'Дом', 'болталка');
  // Второй канал того же сервера: в нём Аня и будет сидеть, пока её зовут в
  // первом, — иначе «счётчик у названного» проверять негде.
  await anya.locator('button[aria-label="Create a text channel"]:visible').first().click();
  const second = anya.getByPlaceholder('new-channel');
  await second.waitFor({ state: 'visible', timeout: 15_000 });
  await second.fill('кухня');
  await anya.getByRole('button', { name: 'Create channel' }).click();
  await anya.waitForTimeout(1200);

  await boris.reload();
  await boris.waitForTimeout(2000);
  await boris.locator('button[aria-label*="Дом"], button[title*="Дом"]').first().click();
  await boris.waitForTimeout(800);
  await openChannel(boris, 'болталка');
  // Подсказка предлагает тех, кто здесь; чтобы Аня попала в список, ей надо
  // быть на связи — она и есть, вторым браузером.
  await openChannel(anya, 'болталка');
  await say(anya, 'я тут');
  await expect(boris.getByText('я тут')).toBeVisible({ timeout: 15_000 });
  // Уходит в соседний канал — там её и застанет вызов.
  await openChannel(anya, 'кухня');

  // Борис набирает «@ан» — подсказка предлагает Аню, Enter подставляет имя.
  const composer = boris.getByPlaceholder(/^message #/);
  await composer.fill('@ан');
  const suggestion = boris.locator('[role="option"]', { hasText: 'Аня' });
  await expect(suggestion.first()).toBeVisible({ timeout: 15_000 });
  await composer.press('Enter');
  await expect(composer).toHaveValue('@Аня ');
  // Курсор возвращается за подставленное имя следующим кадром — дописываем
  // фразу после него, как это делает рука.
  await boris.waitForTimeout(300);
  await composer.pressSequentially('зайди в болталку');
  await expect(composer).toHaveValue('@Аня зайди в болталку');
  await composer.press('Enter');

  // Имя в готовой реплике — выделенное, а не просто текст.
  const said = boris.locator('[data-feed] >> text=зайди в болталку');
  await expect(said).toBeVisible({ timeout: 15_000 });
  await expect(boris.locator('[data-feed] span', { hasText: /^@Аня$/ }).first()).toBeVisible();

  // У Ани, сидящей в соседнем канале, — счётчик на строке «болталка».
  const badge = anya.locator('[title*="mention"]').first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveText('1');

  // Зашла — счётчик погас, а сама реплика подсвечена как обращённая к ней.
  await openChannel(anya, 'болталка');
  await expect(anya.getByText('зайди в болталку')).toBeVisible({ timeout: 15_000 });
  await expect(anya.locator('[title*="mention"]')).toHaveCount(0);
});

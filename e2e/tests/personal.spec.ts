import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

/**
 * Непрочитанное и настройки на личности — то, ради чего они на неё и переехали:
 * прочитал на одном устройстве, и на другом прочитано.
 *
 * «Второе устройство» здесь — новый контекст с той же сессионной кукой
 * личности. Пустые localStorage и IndexedDB и есть то единственное, чем второй
 * компьютер отличается от первого: всё, что он знает про непрочитанное и
 * настройки, он получает от сервера. Настоящую связку по QR тут не гоняем —
 * она проверяется отдельно и к синхронизации отношения не имеет.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * , если ворота инсталляции включены.
 *
 * Стенд должен быть чистым: тест заводит свой сервер с каналом, и оставшийся
 * от прошлого прогона канал с тем же именем спутает и людей, и проверки.
 */

const PASSWORD = process.env.SITE_PASSWORD || '';
const BASE = process.env.BASE_URL || 'https://localhost';

async function person(browser: Browser, nick: string): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }]);
  const page = await ctx.newPage();
  await page.goto('/');

  // Ворота инсталляции, если они есть.
  const pass = page.getByPlaceholder('Password');
  if (PASSWORD && (await pass.isVisible().catch(() => false))) {
    await pass.fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    await page.waitForTimeout(1500);
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

/** Второе устройство того же человека: та же личность, пустое хранилище. */
async function secondDevice(browser: Browser, from: Page): Promise<Page> {
  const cookies = (await from.context().cookies()).filter((c) => c.name !== 'relay-lang');
  const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }, ...cookies]);
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByText('общий', { exact: true })).toBeVisible({ timeout: 25_000 });
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((n) => n.remove()));
  return page;
}

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

test('прочитанное на одном устройстве прочитано и на другом', async ({ browser }) => {
  test.setTimeout(180_000);
  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  // Свой сервер с каналом: в открытом «общем» первое устройство прочитало бы
  // сказанное само собой, и проверять было бы нечего.
  await anya.locator('button[aria-label="Create a server"]').click();
  await anya.getByPlaceholder('My server').fill('Кухня');
  await anya.getByRole('button', { name: 'Create server' }).click();
  const chName = anya.getByPlaceholder('new-channel');
  await chName.waitFor({ state: 'visible', timeout: 15_000 });
  await chName.fill('болталка');
  await anya.getByRole('button', { name: 'Create channel' }).click();
  await anya.waitForTimeout(1500);

  // Борис заходит на этот сервер и что-то говорит.
  await boris.reload();
  await boris.waitForTimeout(2000);
  await boris.locator('button[aria-label*="Кухня"], button[title*="Кухня"]').first().click();
  await boris.waitForTimeout(1000);
  await boris.getByText('болталка', { exact: true }).click();
  const composer = boris.getByPlaceholder(/^message #/);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill('первое слово');
  await composer.press('Enter');
  await expect(boris.getByText('первое слово').first()).toBeVisible({ timeout: 10_000 });

  // Второе устройство Ани: пустое хранилище, всё непрочитанное — с сервера.
  const laptop = await secondDevice(browser, anya);
  await laptop.locator('button[aria-label*="Кухня"], button[title*="Кухня"]').first().click();
  await waitDot(laptop, 'болталка', true);

  // Аня читает канал на первом устройстве.
  await anya.locator('button[aria-label*="Кухня"], button[title*="Кухня"]').first().click();
  await anya.waitForTimeout(800);
  await anya.getByText('болталка', { exact: true }).click();
  await expect(anya.getByText('первое слово').first()).toBeVisible({ timeout: 15_000 });

  // И на втором точка гаснет сама — без перезагрузки.
  await waitDot(laptop, 'болталка', false);
});

test('звук канала, включённый здесь, включён и на другом устройстве', async ({ browser }) => {
  test.setTimeout(180_000);
  const anya = await person(browser, 'Аня');

  // Включаем звук каналу через его меню.
  await anya.getByText('общий', { exact: true }).click({ button: 'right' });
  const sound = anya.getByText('Sound on new messages', { exact: true });
  await sound.waitFor({ state: 'visible', timeout: 10_000 });
  await sound.click();

  const laptop = await secondDevice(browser, anya);
  await laptop.locator('button[aria-label="Settings"]').click();
  await laptop.getByRole('button', { name: 'Across devices' }).click();
  await expect(laptop.getByText('#общий')).toBeVisible({ timeout: 15_000 });
});

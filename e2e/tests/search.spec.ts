import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Поиск по истории — и то, ради чего он существует: не список строк, а дорога
 * обратно в разговор. Проверяем всю дорогу целиком: найти по половине слова,
 * попасть в найденное посреди истории и вернуться к последним.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены.
 *
 * Стенд должен быть чистым: тест заводит свой сервер с каналом, и оставшийся от
 * прошлого прогона канал с тем же именем спутает и людей, и проверки.
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

async function say(page: Page, text: string) {
  const composer = page.getByPlaceholder(/^message #/);
  await composer.fill(text);
  await composer.press('Enter');
}

/** Свой сервер с текстовым каналом — чтобы искать в своём разговоре, а не в чужом. */
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

/** Кнопка поиска есть и в шапке десктопа, и в мобильной — берём видимую. */
function openSearch(page: Page) {
  return page.locator('button[aria-label="Search history"]:visible').click();
}

test('находит сказанное, открывает его в ленте и возвращает к последним', async ({ browser }) => {
  test.setTimeout(240_000);
  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  await ownChannel(anya, 'Кухня', 'болталка');

  await boris.reload();
  await boris.waitForTimeout(2000);
  await boris.locator('button[aria-label*="Кухня"], button[title*="Кухня"]').first().click();
  await boris.waitForTimeout(800);
  await boris.getByText('болталка', { exact: true }).click();
  await expect(boris.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });

  // Одна приметная реплика и гора сказанного после неё: без этой горы лента не
  // окажется в прошлом, и возвращаться будет неоткуда.
  await say(boris, 'иголка лежит в стоге сена');
  for (let i = 0; i < 30; i += 1) await say(boris, `сено номер ${i}`);
  await expect(boris.getByText('сено номер 29')).toBeVisible({ timeout: 20_000 });

  await anya.locator('button[aria-label*="Кухня"], button[title*="Кухня"]').first().click();
  await anya.waitForTimeout(800);
  await anya.getByText('болталка', { exact: true }).click();
  await expect(anya.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });

  await openSearch(anya);
  const field = anya.getByPlaceholder('Search messages');
  await expect(field).toBeVisible();
  // Половина слова: сервер ищет по началу, и окончание набирать не надо.
  await field.fill('игол');

  const results = anya.locator('[role="dialog"] button', { hasText: 'иголка' });
  await expect(results.first()).toBeVisible({ timeout: 15_000 });
  // Подсвечено слово, из-за которого нашлось, а не весь текст.
  expect(await anya.locator('[role="dialog"] mark').first().textContent()).toBe('иголка');

  await results.first().click();

  // Лента встала на найденное — хотя после него сказали ещё тридцать реплик.
  await expect(anya.locator('[data-feed] >> text=иголка лежит в стоге сена')).toBeInViewport({
    timeout: 15_000,
  });

  // И обратная дорога: лента стоит в прошлом, о чём кнопка и говорит.
  const back = anya.getByRole('button', { name: 'Back to the latest' });
  await expect(back).toBeVisible({ timeout: 10_000 });
  await back.click();
  await expect(anya.getByText('сено номер 29')).toBeInViewport({ timeout: 15_000 });
});

test('поиск по серверу достаёт сказанное в соседнем канале', async ({ browser }) => {
  test.setTimeout(240_000);
  const anya = await person(browser, 'Аня');
  await ownChannel(anya, 'Дом', 'кухня');

  await anya.getByText('кухня', { exact: true }).click();
  await expect(anya.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });
  await say(anya, 'чайник закипел');
  await expect(anya.getByText('чайник закипел')).toBeVisible({ timeout: 10_000 });

  // Второй канал того же сервера — из него и ищем.
  await anya.locator('button[aria-label="Create a text channel"]:visible').first().click();
  const name = anya.getByPlaceholder('new-channel');
  await name.waitFor({ state: 'visible', timeout: 15_000 });
  await name.fill('гостиная');
  await anya.getByRole('button', { name: 'Create channel' }).click();
  await anya.waitForTimeout(1200);
  await anya.getByText('гостиная', { exact: true }).click();
  await expect(anya.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });

  await openSearch(anya);
  await anya.getByPlaceholder('Search messages').fill('чайник');

  // В этом канале — ничего, и так и написано.
  await expect(anya.locator('[role="dialog"]').getByText(/Nothing about/)).toBeVisible({
    timeout: 15_000,
  });

  // По серверу — нашлось, и сказано, в каком канале.
  await anya.getByRole('button', { name: 'This server' }).click();
  const hit = anya.locator('[role="dialog"] button', { hasText: 'чайник закипел' });
  await expect(hit.first()).toBeVisible({ timeout: 15_000 });
  await expect(hit.first()).toContainText('#кухня');
});

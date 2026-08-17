import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Закреплённые — и то, ради чего они существуют: не пометка для себя, а то, что
 * канал показывает всем. Проверяем дорогу целиком: хозяйка канала закрепляет
 * чужую реплику, число загорается в шапке у обоих, пометка появляется в самой
 * ленте, список за числом ведёт обратно к реплике, а гостю закреплять нечем —
 * пункта в меню у него нет вовсе.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Стенд должен быть чистым:
 * тест заводит свой сервер, и оставшийся от прошлого прогона одноимённый
 * спутает и людей, и проверки.
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

async function openChannel(page: Page, channel: string) {
  await page.getByText(channel, { exact: true }).click();
  await expect(page.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });
}

/** Меню реплики в ленте — та самая капсула, что выезжает при наведении. */
async function messageMenu(page: Page, text: string) {
  const row = page.locator('[data-feed] [data-mid]', { hasText: text }).first();
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
}

test('закрепить чужое: пометка, число в шапке и список за ним', async ({ browser }) => {
  test.setTimeout(240_000);
  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  // Свой сервер: модерирует его создатель, у главного создателя нет вовсе.
  await anya.locator('button[aria-label="Create a server"]').click();
  await anya.getByPlaceholder('My server').fill('Дом');
  await anya.getByRole('button', { name: 'Create server' }).click();
  const name = anya.getByPlaceholder('new-channel');
  await name.waitFor({ state: 'visible', timeout: 15_000 });
  await name.fill('болталка');
  await anya.getByRole('button', { name: 'Create channel' }).click();
  await anya.waitForTimeout(1500);
  await openChannel(anya, 'болталка');

  await boris.reload();
  await boris.waitForTimeout(2000);
  await boris.locator('button[aria-label*="Дом"], button[title*="Дом"]').first().click();
  await boris.waitForTimeout(800);
  await openChannel(boris, 'болталка');
  await say(boris, 'ключ под ковриком');
  await expect(anya.getByText('ключ под ковриком')).toBeVisible({ timeout: 15_000 });

  // У гостя пункта «закрепить» нет вовсе — даже в меню собственной реплики:
  // закрепление меняет канал для всех, и это право хозяина канала.
  await messageMenu(boris, 'ключ под ковриком');
  await expect(boris.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 10_000 });
  await expect(boris.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
  await boris.keyboard.press('Escape');

  // Хозяйка закрепляет чужую реплику из её же меню.
  await messageMenu(anya, 'ключ под ковриком');
  await anya.getByRole('button', { name: 'Pin', exact: true }).click();

  // Пометка появляется в ленте у обоих — закрепление видно всем, а не автору.
  await expect(anya.locator('[data-feed]').getByText('pinned', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(boris.locator('[data-feed]').getByText('pinned', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Число — в шапке канала, тоже у обоих.
  const count = boris.getByRole('button', { name: 'Pinned messages' });
  await expect(count).toBeVisible({ timeout: 15_000 });
  await expect(count).toContainText('1');

  // За числом — список, и он ведёт обратно к самой реплике.
  await count.click();
  const panel = boris.getByRole('dialog', { name: 'Pinned' });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('ключ под ковриком')).toBeVisible();
  // Обещание закрепления написано словами, а не подразумевается.
  await expect(panel.getByText(/Pinned messages stay/)).toBeVisible();

  // Открепление возвращает канал в прежний вид — и у второго тоже.
  await messageMenu(anya, 'ключ под ковриком');
  await anya.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(boris.locator('[data-feed]').getByText('pinned', { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(boris.getByRole('button', { name: 'Pinned messages' })).toHaveCount(0);
});

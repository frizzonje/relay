import { test, expect } from '@playwright/test';

/**
 * Обещание, ради которого в 1.0 появилась база: рестарт стека не теряет
 * переписку.
 *
 * Одним прогоном это не проверяется — между «написали» и «проверили» кто-то
 * должен перезапустить api. Поэтому спека двухфазная: сначала `write`, потом
 * снаружи рестарт, потом `read` тем же маркером. Без маркера тест доказывал бы
 * только то, что в канале вообще что-то есть.
 */

const PASSWORD = process.env.SITE_PASSWORD || 'testpass123';
const PHASE = process.env.E2E_PHASE ?? '';
const MARK = process.env.E2E_MARK || 'переживи-рестарт';

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: 'relay-lang',
      value: 'en',
      url: process.env.BASE_URL || 'https://localhost',
    },
  ]);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('relay-tag', 'e2e-user');
    } catch {
      /* до первого origin недоступно — addInitScript выставит позже */
    }
  });
});

/** Вход и открытый текстовый канал — общая часть обеих фаз. */
async function openChannel(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const channel = page.getByText('общий', { exact: true });
  await expect(channel).toBeVisible({ timeout: 15_000 });
  await channel.click();
  await expect(page.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 10_000 });
}

test('фаза 1: пишем то, что должно пережить рестарт', async ({ page }) => {
  test.skip(PHASE !== 'write', 'фаза write запускается отдельно');
  await openChannel(page);
  const composer = page.getByPlaceholder(/^message #/);
  await composer.fill(MARK);
  await composer.press('Enter');
  await expect(page.getByText(MARK)).toBeVisible({ timeout: 15_000 });
});

test('фаза 2: после рестарта стека сообщение на месте', async ({ page }) => {
  test.skip(PHASE !== 'read', 'фаза read запускается после рестарта api');
  await openChannel(page);
  // История приезжает страницей при входе в канал — если она снова живёт в
  // памяти процесса, здесь будет пусто.
  await expect(page.getByText(MARK)).toBeVisible({ timeout: 15_000 });
});

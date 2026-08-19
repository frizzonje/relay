import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Живой разговор двумя браузерами — то единственное, чего до сих пор не
 * проверял ни один спек, хотя дороже него в relay нет ничего.
 *
 * Проверяем не «нажалось», а что соединение и правда встало: метка задержки в
 * панели голоса рисуется по статистике живого `RTCPeerConnection` (см.
 * `voice/mesh.ts`, `pollStats`). Пока пиры не договорились, там `waiting` и
 * никаких миллисекунд — то есть «N ms» у обоих и есть доказательство, что
 * медиаканал открыт, а не что кнопка покрасилась.
 *
 * Микрофон настоящий, но фальшивый: Chromium отдаёт синтетическую дорожку по
 * `--use-fake-device-for-media-stream`, и права выдаёт сам. Без этого браузер
 * встал бы на системном окне доступа, которого в CI некому нажать.
 *
 * Канал берём «P2P общий»: он всегда прямой и работает без поднятого
 * медиасервера, значит спек не зависит от того, есть ли на стенде SFU.
 */

const PASSWORD = process.env.SITE_PASSWORD || '';
const BASE = process.env.BASE_URL || 'https://localhost';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

async function person(browser: Browser, nick: string): Promise<Page> {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  await ctx.addCookies([{ name: 'relay-lang', value: 'en', url: BASE }]);
  const page = await ctx.newPage();
  await page.goto('/');

  const pass = page.getByPlaceholder('Password');
  if (PASSWORD && (await pass.isVisible().catch(() => false))) {
    await pass.fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  const cont = page.getByRole('button', { name: 'Continue' });
  await cont.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  if (await cont.isVisible().catch(() => false)) {
    await page.locator('form input').first().fill(nick);
    await cont.click();
    await cont.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  }
  await expect(page.getByText('P2P общий', { exact: true })).toBeVisible({ timeout: 25_000 });
  // Оверлей дев-режима Next перехватывает клики по нижней части экрана.
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((n) => n.remove()));
  return page;
}

/** Зайти в голосовой канал и дождаться своей плитки. */
async function joinVoice(page: Page, nick: string) {
  await page.getByText('P2P общий', { exact: true }).click();
  await expect(page.getByText(`${nick} (you)`).first()).toBeVisible({ timeout: 25_000 });
}

test('двое в канале: соединение встаёт, мут доезжает, уход виден', async ({ browser }) => {
  test.setTimeout(180_000);

  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  await joinVoice(anya, 'Аня');
  await joinVoice(boris, 'Борис');

  // Друг друга видно — плитку заводит транспорт по составу комнаты.
  await expect(anya.getByText('Борис', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(boris.getByText('Аня', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // …и соединение реально установлено: миллисекунды приезжают из getStats
  // живого соединения, метрики снимаются раз в три секунды.
  await expect(anya.getByText(/latency:\s*\d+ ms/)).toBeVisible({ timeout: 40_000 });
  await expect(boris.getByText(/latency:\s*\d+ ms/)).toBeVisible({ timeout: 40_000 });

  // Мут едет через presence на сервере, а не по медиаканалу: его видно и тем,
  // кто сам не в эфире.
  await anya.getByRole('button', { name: 'Mute the microphone' }).click();
  await expect(boris.getByRole('img', { name: 'Microphone off' }).first()).toBeVisible({
    timeout: 20_000,
  });

  // Уход снимает плитку сразу, не дожидаясь грейса: тот только для обрывов.
  await anya.getByRole('button', { name: 'Disconnect' }).click();
  await expect(boris.getByText('Аня', { exact: true })).toHaveCount(0, { timeout: 20_000 });
});

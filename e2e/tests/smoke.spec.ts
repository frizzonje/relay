import { test, expect } from '@playwright/test';
import path from 'node:path';

const PASSWORD = process.env.SITE_PASSWORD || 'testpass123';
// Тесты бегут из каталога e2e/ (cwd) — путь к фикстуре относительно него.
const UPLOAD = path.join(process.cwd(), 'fixtures', 'sample.txt');

test.beforeEach(async ({ context }) => {
  // Язык интерфейса фиксируем кукой (её читает сервер, см. apps/web/lib/i18n):
  // подписи в тесте английские, и они не должны зависеть ни от Accept-Language
  // раннера, ни от того, какой язык добавят в словари следующим.
  await context.addCookies([
    {
      name: 'relay-lang',
      value: 'en',
      url: process.env.BASE_URL || 'https://localhost',
    },
  ]);
  await context.addInitScript(() => {
    try {
      // Тег выбран заранее — выбор личности (IdentityGate) не перехватывает клики.
      localStorage.setItem('relay-tag', 'e2e-user');
    } catch {
      /* недоступно до первого origin — addInitScript всё равно выставит позже */
    }
  });
});

test('логин → канал → сообщение → upload', async ({ page }) => {
  // ── Гейт входа: без куки нас редиректит на /login ──
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'relay' })).toBeVisible();

  // ── Логин ──
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // После успеха фронт делает location.replace('/') — ждём список каналов.
  // «общий» точным совпадением — это текстовый канал главного сервера;
  // голосовые рядом называются «P2P общий» и «SFU общий».
  const channel = page.getByText('общий', { exact: true });
  await expect(channel).toBeVisible({ timeout: 15_000 });

  // ── Вход в текстовый канал ──
  await channel.click();
  const composer = page.getByPlaceholder(/^message #/);
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // ── Отправка сообщения (эхо приходит обратно через socket) ──
  const msg = `сообщение ${Date.now()}`;
  await composer.fill(msg);
  await composer.press('Enter');
  await expect(page.getByText(msg)).toBeVisible({ timeout: 15_000 });

  // ── Загрузка файла → карточка вложения с именем ──
  // Сервер хранит историю канала между прогонами → берём первую карточку.
  await page.locator('input[type="file"]').setInputFiles(UPLOAD);
  await expect(page.getByText('sample.txt').first()).toBeVisible({ timeout: 15_000 });
});

test('лента отдаётся страницей и подгружается вверх', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const channel = page.getByText('общий', { exact: true });
  await expect(channel).toBeVisible({ timeout: 15_000 });
  await channel.click();
  const composer = page.getByPlaceholder(/^message #/);
  await expect(composer).toBeVisible({ timeout: 10_000 });

  // Больше страницы (50), чтобы первые реплики заведомо в неё не попали.
  const mark = `p${Date.now().toString().slice(-6)}`;
  for (let i = 0; i < 55; i += 1) {
    await composer.fill(`${mark}-${i}`);
    await composer.press('Enter');
  }
  await expect(page.getByText(`${mark}-54`)).toBeVisible({ timeout: 20_000 });

  // Заходим заново — сервер отдаёт последнюю страницу, а не всю историю.
  // Канал после перезагрузки открывается кликом, как и в первый раз: выбор
  // канала клиент не запоминает.
  await page.reload();
  const again = page.getByText('общий', { exact: true });
  await expect(again).toBeVisible({ timeout: 15_000 });
  await again.click();
  await expect(page.getByPlaceholder(/^message #/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${mark}-54`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${mark}-0`, { exact: true })).toHaveCount(0);

  // Листаем вверх — страница выше приезжает и встаёт на своё место.
  await page.locator('[data-feed]').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByText(`${mark}-0`, { exact: true })).toBeVisible({ timeout: 15_000 });
});

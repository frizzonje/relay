import { test, expect } from '@playwright/test';
import path from 'node:path';

const PASSWORD = process.env.SITE_PASSWORD || 'testpass123';
// Тесты бегут из каталога e2e/ (cwd) — путь к фикстуре относительно него.
const UPLOAD = path.join(process.cwd(), 'fixtures', 'sample.txt');

test.beforeEach(async ({ context }) => {
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
  await page.getByPlaceholder('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();

  // После успеха фронт делает location.replace('/') — ждём список каналов.
  const channel = page.getByText('general', { exact: true });
  await expect(channel).toBeVisible({ timeout: 15_000 });

  // ── Вход в текстовый канал ──
  await channel.click();
  const composer = page.getByPlaceholder(/Сообщение/);
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

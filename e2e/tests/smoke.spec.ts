import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import { openChannel, person, say, test, unique } from '../fixtures/stand';

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
});

/**
 * Первый экран новичка: устройство завело ключ, и до выбора имени интерфейс
 * закрыт. Пропустить его нечем — имя принадлежит личности, а личность в 1.0
 * заводится на устройстве, а не в localStorage. Поэтому смоук проходит его
 * так же, как человек: вводит имя и жмёт «Continue».
 */
async function pickName(page: Page, nick: string) {
  // Сначала дожидаемся самого приложения: пока браузер на /login, «Continue» —
  // это не окно личности, а кнопка входа, и поле рядом с ней тоже чужое.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  const gate = page.getByRole('dialog').filter({ hasText: 'Pick a name' });
  await gate.waitFor({ state: 'visible', timeout: 30_000 });
  await gate.locator('form input').first().fill(nick);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await gate.waitFor({ state: 'detached', timeout: 20_000 });
}

test('логин → канал → сообщение → upload', async ({ page }) => {
  // Тридцати секунд из конфига этому пути мало с 1.0: до первого канала успевают
  // случиться ворота пароля, заведение ключа на устройстве и выбор имени.
  test.setTimeout(120_000);
  // ── Гейт входа: без куки нас редиректит на /login ──
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'relay' })).toBeVisible();

  // ── Логин ──
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await pickName(page, 'Смоук');

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

test('лента отдаётся страницей и подгружается вверх', async ({ browser }) => {
  // Тут вдобавок отправляются пятьдесят пять реплик по одной.
  test.setTimeout(180_000);
  const page = await person(browser, unique('Страничник'));
  await openChannel(page, 'общий');

  // Больше страницы (50), чтобы первые реплики заведомо в неё не попали.
  const mark = unique('р');
  for (let i = 0; i < 55; i += 1) await say(page, `${mark}-${i}`);
  await expect(page.getByText(`${mark}-54`)).toBeVisible({ timeout: 20_000 });

  // Заходим заново — сервер отдаёт последнюю страницу, а не всю историю.
  // Канал после перезагрузки открывается кликом, как и в первый раз: выбор
  // канала клиент не запоминает.
  await page.reload();
  await openChannel(page, 'общий');
  await expect(page.getByText(`${mark}-54`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${mark}-0`, { exact: true })).toHaveCount(0);

  // Листаем вверх — страница выше приезжает и встаёт на своё место.
  await page.locator('[data-feed]').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByText(`${mark}-0`, { exact: true })).toBeVisible({ timeout: 15_000 });
});

import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * Модерация целиком, двумя людьми сразу — иначе её и не проверить: у бана две
 * стороны, и вся суть в том, что видит вторая.
 *
 * Что нужно стенду:
 *
 *   - поднятый dev- или прод-стек (см. заголовок playwright.config);
 *   - `SITE_PASSWORD`, если ворота инсталляции включены; без него шаг входа
 *     пропускается сам;
 *   - `OWNER_TOKEN` для второго теста — свежий ключ владельца, тот самый, что
 *     печатает `relay owner-link`. Выдать его может только машина, на которой
 *     стоит relay (в этом весь смысл ссылки), поэтому тест без него пропускается,
 *     а не падает:
 *
 *       docker compose exec api node dist/owner-link.js
 *
 * Личности здесь настоящие: ключ рождается в браузере на первом заходе, и
 * каждый контекст — отдельный человек. Chromium нужен свежий: Ed25519 в
 * WebCrypto появился недавно, и на старом браузере relay честно скажет, что
 * ключ ему держать негде.
 */

const PASSWORD = process.env.SITE_PASSWORD || '';
const BASE = process.env.BASE_URL || 'https://localhost';

/** Человек с собственным ключом: свой контекст, своя личность, своё имя. */
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

  // Стенд иногда встречает первым кадром «сервер не ответил» — api ещё
  // поднимался. Это не то, что мы проверяем.
  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
    await page.waitForTimeout(1500);
  }

  // Первый заход спрашивает имя — ключ к этому моменту уже родился.
  const cont = page.getByRole('button', { name: 'Continue' });
  await cont.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {});
  if (await cont.isVisible().catch(() => false)) {
    await page.locator('form input').first().fill(nick);
    await cont.click();
    await cont.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
  }

  await expect(page.getByText('общий', { exact: true })).toBeVisible({ timeout: 20_000 });
  // Оверлей Next dev-tools перехватывает клики в левом нижнем углу — там же
  // живут кнопки рейки.
  await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach((n) => n.remove()));
  return page;
}

const server = (page: Page, name: string) =>
  page.locator(`button[aria-label*="${name}"], button[title*="${name}"]`);

test('бан с сервера: сервер пропадает у забаненного, список и разбан у модератора', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const anya = await person(browser, 'Аня');
  const boris = await person(browser, 'Борис');

  // Свой сервер и канал в нём: модерирует его создатель, и только его.
  await anya.locator('button[aria-label="Create a server"]').click();
  await anya.getByPlaceholder('My server').fill('Кухня');
  await anya.getByRole('button', { name: 'Create server' }).click();
  // Создание сервера само зовёт завести первый канал.
  const chName = anya.getByPlaceholder('new-channel');
  await chName.waitFor({ state: 'visible', timeout: 15_000 });
  await chName.fill('болталка');
  await anya.getByRole('button', { name: 'Create channel' }).click();
  await anya.waitForTimeout(1500);

  // Борис заходит на этот сервер и что-то говорит.
  await boris.reload();
  await boris.waitForTimeout(2000);
  await server(boris, 'Кухня').first().click();
  await boris.waitForTimeout(1000);
  await boris.getByText('болталка', { exact: true }).click();
  const composer = boris.getByPlaceholder(/^message #/);
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill('дурное слово');
  await composer.press('Enter');
  await expect(boris.getByText('дурное слово')).toBeVisible({ timeout: 10_000 });

  // У создателя в меню чужой реплики появляются удаление и бан.
  await anya.getByText('болталка', { exact: true }).click();
  await expect(anya.getByText('дурное слово')).toBeVisible({ timeout: 10_000 });
  await anya.getByText('дурное слово').click({ button: 'right' });
  await expect(anya.getByText('Ban the author', { exact: true })).toBeVisible();
  // Бан на всю инсталляцию создателю сервера недоступен — власти ровно на своё.
  await expect(anya.getByText('Ban across the installation', { exact: true })).toHaveCount(0);
  await anya.getByText('Ban the author', { exact: true }).click();
  await anya.getByRole('button', { name: 'Ban', exact: true }).click();
  await anya.waitForTimeout(2000);

  // У Бориса сервер пропал, остальная инсталляция осталась.
  await expect(server(boris, 'Кухня')).toHaveCount(0);
  await expect(boris.getByText('общий', { exact: true })).toBeVisible();

  // Список забаненных — единственное место, где бан снимается.
  await anya.locator('button[aria-label="Who is banned"]').click();
  await expect(anya.getByText('Борис').first()).toBeVisible({ timeout: 15_000 });
  await anya.locator('button[aria-label="Lift the ban"]').first().click();

  // Разбан возвращает сервер на место без перезагрузки страницы.
  await expect(server(boris, 'Кухня').first()).toBeVisible({ timeout: 15_000 });
});

test('бан на всю инсталляцию: экран вместо молчащего приложения', async ({ browser }) => {
  test.setTimeout(180_000);
  const token = process.env.OWNER_TOKEN;
  test.skip(!token, 'нужен свежий ключ владельца: docker compose exec api node dist/owner-link.js');

  const owner = await person(browser, 'Хозяйка');
  const stranger = await person(browser, 'Прохожий');

  // Власть берётся тем же путём, что и у живого человека: ссылкой из терминала.
  await owner.goto(`/?owner=1#owner=${token}`);
  await owner.getByRole('button', { name: 'Make this identity the owner' }).click();
  await owner.waitForTimeout(2500);
  await owner.keyboard.press('Escape');

  // Главный сервер — тот, у которого создателя нет и быть не может: модерирует
  // его только владелец инсталляции.
  await stranger.getByText('общий', { exact: true }).click();
  const composer = stranger.getByPlaceholder(/^message #/);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill('пришёл ломать');
  await composer.press('Enter');
  await expect(stranger.getByText('пришёл ломать')).toBeVisible({ timeout: 10_000 });

  await owner.getByText('общий', { exact: true }).click();
  await expect(owner.getByText('пришёл ломать')).toBeVisible({ timeout: 15_000 });
  await owner.getByText('пришёл ломать').click({ button: 'right' });
  await owner.getByText('Ban across the installation', { exact: true }).click();
  await owner.getByRole('button', { name: 'Ban', exact: true }).click();

  // Экран, а не тост: сокета больше нет, и приложение вокруг — декорация.
  await expect(stranger.getByText('You are banned here')).toBeVisible({ timeout: 20_000 });

  // И на перезаходе то же самое: дверь не пускает — это не «сеть моргнула».
  await stranger.reload();
  await expect(stranger.getByText('You are banned here')).toBeVisible({ timeout: 25_000 });
});

import { expect, type Page } from '@playwright/test';
import {
  createChannel,
  createServer,
  openChannel,
  openServer,
  person,
  say,
  test,
  unique,
} from '../fixtures/stand';

/**
 * Поиск по истории — и то, ради чего он существует: не список строк, а дорога
 * обратно в разговор. Проверяем всю дорогу целиком: найти по половине слова,
 * попасть в найденное посреди истории и вернуться к последним.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Чистить стенд между
 * прогонами не нужно: имена берутся через `unique` (см. fixtures/stand).
 */

/** Кнопка поиска есть и в шапке десктопа, и в мобильной — берём видимую. */
function openSearch(page: Page) {
  return page.locator('button[aria-label="Search history"]:visible').click();
}

test('находит сказанное, открывает его в ленте и возвращает к последним', async ({ browser }) => {
  test.setTimeout(240_000);
  const kitchen = unique('Кухня');
  const room = unique('болталка');

  const anya = await person(browser, unique('Аня'));
  const boris = await person(browser, unique('Борис'));

  await createServer(anya, kitchen, room);

  await openServer(boris, kitchen);
  await openChannel(boris, room);

  // Одна приметная реплика и гора сказанного после неё: без этой горы лента не
  // окажется в прошлом, и возвращаться будет неоткуда.
  await say(boris, 'иголка лежит в стоге сена');
  for (let i = 0; i < 30; i += 1) await say(boris, `сено номер ${i}`);
  await expect(boris.getByText('сено номер 29')).toBeVisible({ timeout: 20_000 });

  await openChannel(anya, room);

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
  const home = unique('Дом');
  const kitchen = unique('кухня');
  const parlour = unique('гостиная');

  const anya = await person(browser, unique('Аня'));
  await createServer(anya, home, kitchen);

  await openChannel(anya, kitchen);
  await say(anya, 'чайник закипел');
  await expect(anya.getByText('чайник закипел')).toBeVisible({ timeout: 10_000 });

  // Второй канал того же сервера — из него и ищем.
  await createChannel(anya, parlour);
  await openChannel(anya, parlour);

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
  await expect(hit.first()).toContainText(`#${kitchen}`);
});

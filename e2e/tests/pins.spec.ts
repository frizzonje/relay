import { test, expect, type Page } from '@playwright/test';
import { createServer, openChannel, openServer, person, say, unique } from '../fixtures/stand';

/**
 * Закреплённые — и то, ради чего они существуют: не пометка для себя, а то, что
 * канал показывает всем. Проверяем дорогу целиком: хозяйка канала закрепляет
 * чужую реплику, число загорается в шапке у обоих, пометка появляется в самой
 * ленте, список за числом ведёт обратно к реплике, а гостю закреплять нечем —
 * пункта в меню у него нет вовсе.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Чистить стенд между
 * прогонами не нужно: имена берутся через `unique` (см. fixtures/stand).
 */

/** Меню реплики в ленте — та самая капсула, что выезжает при наведении. */
async function messageMenu(page: Page, text: string) {
  const row = page.locator('[data-feed] [data-mid]', { hasText: text }).first();
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
}

test('закрепить чужое: пометка, число в шапке и список за ним', async ({ browser }) => {
  test.setTimeout(240_000);
  const home = unique('Дом');
  const room = unique('болталка');
  const word = 'ключ под ковриком';

  const anya = await person(browser, unique('Аня'));
  const boris = await person(browser, unique('Борис'));

  // Свой сервер: модерирует его создатель, у главного создателя нет вовсе.
  await createServer(anya, home, room);
  await openChannel(anya, room);

  await openServer(boris, home);
  await openChannel(boris, room);
  await say(boris, word);
  await expect(anya.getByText(word)).toBeVisible({ timeout: 15_000 });

  // У гостя пункта «закрепить» нет вовсе — даже в меню собственной реплики:
  // закрепление меняет канал для всех, и это право хозяина канала.
  await messageMenu(boris, word);
  await expect(boris.getByRole('button', { name: 'Delete' })).toBeVisible({ timeout: 10_000 });
  await expect(boris.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
  await boris.keyboard.press('Escape');

  // Хозяйка закрепляет чужую реплику из её же меню.
  await messageMenu(anya, word);
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
  await expect(panel.getByText(word)).toBeVisible();
  // Обещание закрепления написано словами, а не подразумевается.
  await expect(panel.getByText(/Pinned messages stay/)).toBeVisible();

  // Открепление возвращает канал в прежний вид — и у второго тоже.
  await messageMenu(anya, word);
  await anya.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(boris.locator('[data-feed]').getByText('pinned', { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(boris.getByRole('button', { name: 'Pinned messages' })).toHaveCount(0);
});

import { expect } from '@playwright/test';
import {
  createChannel,
  createServer,
  openChannel,
  person,
  say,
  test,
  unique,
} from '../fixtures/stand';

/**
 * Переход между сценами отложен на время, пока прежняя гаснет (см. pendingScene
 * в stores/ui): до конца анимации на экране остаётся то, из чего человек
 * уходит. Проверяем то, что от этого зависит и не зависит от таймингов:
 *
 *  • соседний канал доезжает целиком — лента новая, прежних реплик нет;
 *  • композер при этом не пересоздаётся, и недописанное переезжает с человеком;
 *  • клик по открытому каналу возвращает на сцену лобби.
 */
test('соседний канал приезжает целиком, недописанное переезжает с человеком', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const page = await person(browser, unique('anna'));
  const server = unique('dom');
  const first = unique('pervyi');
  const second = unique('vtoroi');
  await createServer(page, server, first);
  await createChannel(page, second);

  await openChannel(page, first);
  await say(page, 'marker-one');
  await expect(page.getByText('marker-one')).toBeVisible();

  const composer = page.getByPlaceholder(/^message #/);
  await composer.fill('draft-survives');

  await page.getByText(second, { exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByPlaceholder(`message #${second}`)).toBeVisible();
  await expect(page.getByText('marker-one')).toHaveCount(0);
  await expect(composer).toHaveValue('draft-survives');

  // Клик по открытому каналу закрывает его — сцена меняется на лобби.
  await page.getByText(second, { exact: true }).filter({ visible: true }).first().click();
  await expect(page.locator('[data-scene="lobby"]')).toBeVisible();
});

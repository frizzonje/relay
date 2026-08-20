import { expect } from '@playwright/test';
import { openChannel, person, say, test, unique } from '../fixtures/stand';

/**
 * Обещание, ради которого в 1.0 появилась база: рестарт стека не теряет
 * переписку.
 *
 * Одним прогоном это не проверяется — между «написали» и «проверили» кто-то
 * должен перезапустить api. Поэтому спека двухфазная: сначала `write`, потом
 * снаружи рестарт, потом `read` тем же маркером. Без маркера тест доказывал бы
 * только то, что в канале вообще что-то есть.
 *
 * Пишут и читают РАЗНЫЕ люди, и это не небрежность: сообщение должно пережить
 * рестарт как запись сервера, а не как эхо той вкладки, которая его отправила.
 */

const MARK = process.env.E2E_MARK || 'переживи-рестарт';
const PHASE = process.env.E2E_PHASE ?? '';

/**
 * Первое слово метки: поиск на сервере ищет по началу слова, а метка — из
 * нескольких, разделённых дефисом.
 */
const WORD = MARK.split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0] ?? MARK;

test('фаза 1: пишем то, что должно пережить рестарт', async ({ browser }) => {
  test.skip(PHASE !== 'write', 'фаза write запускается отдельно');
  const page = await person(browser, unique('Писарь'));
  await openChannel(page, 'общий');
  await say(page, MARK);
  await expect(page.getByText(MARK)).toBeVisible({ timeout: 15_000 });
});

test('фаза 2: после рестарта стека сообщение на месте', async ({ browser }) => {
  test.skip(PHASE !== 'read', 'фаза read запускается после рестарта api');
  const page = await person(browser, unique('Читарь'));
  await openChannel(page, 'общий');

  // Ищем, а не листаем ленту. В «общий» пишет и остальной прогон — спека про
  // страничную выдачу кладёт туда полсотни реплик, — и метка честно уезжает за
  // первую страницу. Тогда «не вижу» значило бы «надо доскроллить», а не «база
  // забыла». Поиск же спрашивает ровно то, о чём спека: осталась ли запись.
  await page.locator('button[aria-label="Search history"]:visible').click();
  const field = page.getByPlaceholder('Search messages');
  await expect(field).toBeVisible();
  await field.fill(WORD);

  const found = page.locator('[role="dialog"] button', { hasText: MARK });
  await expect(found.first()).toBeVisible({ timeout: 20_000 });

  // И дорога обратно в разговор: найденное встаёт в ленту на своё место.
  await found.first().click();
  await expect(page.locator(`[data-feed] >> text=${MARK}`)).toBeInViewport({ timeout: 15_000 });
});

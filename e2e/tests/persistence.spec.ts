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
  // История приезжает страницей при входе в канал — если она снова живёт в
  // памяти процесса, здесь будет пусто.
  await openChannel(page, 'общий');
  await expect(page.getByText(MARK)).toBeVisible({ timeout: 15_000 });
});

import { test, expect } from '@playwright/test';
import {
  createChannel,
  createServer,
  openChannel,
  openServer,
  person,
  say,
  unique,
} from '../fixtures/stand';

/**
 * Упоминания — и то, ради чего они существуют: не подсветка слова, а то, что
 * названный человек об этом узнаёт. Проверяем всю дорогу целиком: выбрать
 * человека из подсказки, увидеть имя выделенным, получить счётчик в чужом
 * канале — и погасить его, войдя туда.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Чистить стенд между
 * прогонами не нужно: имена берутся через `unique` (см. fixtures/stand).
 */

test('позвать по имени: подсказка, выделение и счётчик у названного', async ({ browser }) => {
  test.setTimeout(240_000);
  const home = unique('Дом');
  const room = unique('болталка');
  const kitchen = unique('кухня');
  const nick = unique('Аня');

  const anya = await person(browser, nick);
  const boris = await person(browser, unique('Борис'));

  await createServer(anya, home, room);
  // Второй канал того же сервера: в нём Аня и будет сидеть, пока её зовут в
  // первом, — иначе «счётчик у названного» проверять негде.
  await createChannel(anya, kitchen);

  await openServer(boris, home);
  await openChannel(boris, room);
  // Подсказка предлагает тех, кто здесь; чтобы Аня попала в список, ей надо
  // быть на связи — она и есть, вторым браузером.
  await openChannel(anya, room);
  await say(anya, 'я тут');
  await expect(boris.getByText('я тут')).toBeVisible({ timeout: 15_000 });
  // Уходит в соседний канал — там её и застанет вызов.
  await openChannel(anya, kitchen);

  // Борис набирает начало имени — подсказка предлагает тех, кто на связи и
  // кому этот канал виден (см. `mentionSuggest`), то есть не только соседей по
  // серверу. Поэтому выбираем нужного щелчком, а не Enter'ом: Enter берёт
  // первого в списке, а на общем стенде под «@ан» их несколько.
  const composer = boris.getByPlaceholder(/^message #/);
  await composer.fill('@ан');
  const suggestion = boris.locator('[role="option"]', { hasText: nick });
  await expect(suggestion.first()).toBeVisible({ timeout: 15_000 });
  await suggestion.first().click();
  await expect(composer).toHaveValue(`@${nick} `);
  // Курсор возвращается за подставленное имя следующим кадром — дописываем
  // фразу после него, как это делает рука.
  await boris.waitForTimeout(300);
  await composer.pressSequentially('зайди в болталку');
  await expect(composer).toHaveValue(`@${nick} зайди в болталку`);
  await composer.press('Enter');

  // Имя в готовой реплике — выделенное, а не просто текст.
  const said = boris.locator('[data-feed] >> text=зайди в болталку');
  await expect(said).toBeVisible({ timeout: 15_000 });
  await expect(
    boris.locator('[data-feed] span', { hasText: new RegExp(`^@${nick}$`) }).first(),
  ).toBeVisible();

  // У Ани, сидящей в соседнем канале, — счётчик на строке того канала.
  const badge = anya.locator('[title*="mention"]').first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveText('1');

  // Зашла — счётчик погас, а сама реплика подсвечена как обращённая к ней.
  await openChannel(anya, room);
  await expect(anya.getByText('зайди в болталку')).toBeVisible({ timeout: 15_000 });
  await expect(anya.locator('[title*="mention"]')).toHaveCount(0);
});

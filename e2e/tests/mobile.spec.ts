import { expect, type Locator, type Page } from '@playwright/test';
import { createServer, person, test, unique } from '../fixtures/stand';

/**
 * Телефон. Узкий экран здесь не главное — главное тач: на мобильной раскладке
 * ховера не бывает вовсе, а половина действий в сайдбаре живёт именно на нём.
 * Настольный браузер в узком окне этого не ловит: мышь в нём есть, и кнопка,
 * невидимая на телефоне, проявляется под курсором.
 *
 * Отсюда и две проверки: войти в закрытый сервер (ввод пароля — единственный
 * путь внутрь) и завести канал (кнопка «+» у заголовка секции — единственный
 * путь к окну создания). Обе — про достижимость, поэтому кнопки проверяются на
 * непрозрачность: `opacity: 0` для Playwright всё ещё «видимый» элемент, и
 * клик по нему проходит, а палец по пустому месту — нет.
 */

const PASSWORD = 'очень-тайный-пароль';

/**
 * Долистать рейку до плашки пальцем, а не программно. `scrollIntoViewIfNeeded`
 * здесь не годится: он двигает даже то, что прокруткой не является (`body` с
 * `overflow: hidden` всё равно слушается `scrollTop`), и «доехал» у него значит
 * «в разметке», а не «под пальцем».
 */
async function wheelTo(page: Page, target: Locator): Promise<void> {
  const inView = () =>
    target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
  await page.mouse.move(32, 200);
  for (let i = 0; i < 20 && !(await inView()); i += 1) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
  }
}

test('с телефона: пароль закрытого сервера и заведение канала', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Боря');
  const secret = unique('Тайный');
  const secretChannel = unique('шёпот');
  const own = unique('Свой');
  const ownChannel = unique('порог');
  const second = unique('второй');

  // Закрытый сервер заводит кто-то другой — с обычного компьютера.
  const anya = await person(browser, her);
  await createServer(anya, secret, secretChannel, { password: PASSWORD });

  const boris = await person(browser, him, { mobile: true });

  // Замок в рейке: до пароля это единственное, что Боря про сервер видит.
  const locked = boris.getByRole('button', {
    name: `${secret} — password protected`,
    exact: true,
  });
  await expect(locked).toBeVisible({ timeout: 25_000 });
  // Серверов на инсталляции может быть полсотни, и нужный — где угодно в
  // списке: до него листают рейку.
  await wheelTo(boris, locked);
  await expect(locked).toBeInViewport();
  await locked.tap();

  const field = boris.getByPlaceholder('Server password');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill(PASSWORD);
  await boris.getByRole('button', { name: 'Enter' }).tap();
  await expect(boris.getByText(secretChannel, { exact: true })).toBeVisible({ timeout: 20_000 });

  // Свой сервер с телефона — и первый канал в мастере создания.
  const create = boris.getByRole('button', { name: 'Create a server' });
  await wheelTo(boris, create);
  await create.tap();
  await boris.getByPlaceholder('My server').fill(own);
  await boris.getByRole('button', { name: 'Create server' }).tap();
  const firstField = boris.getByPlaceholder('new-channel');
  await firstField.waitFor({ state: 'visible', timeout: 20_000 });
  await firstField.fill(ownChannel);
  await boris.getByRole('button', { name: 'Create channel' }).tap();
  await expect(boris.getByText(ownChannel, { exact: true })).toBeVisible({ timeout: 20_000 });

  // А теперь второй канал — тем путём, каким его заводят каждый день: «+» у
  // заголовка секции. Пальцу нужен видимый значок, а не только узел в разметке.
  const plus = boris.locator('button[aria-label="Create a text channel"]:visible').first();
  await expect(plus).toBeVisible();
  await expect(plus).toHaveCSS('opacity', '1');
  await plus.tap();
  const field2 = boris.getByPlaceholder('new-channel');
  await field2.waitFor({ state: 'visible', timeout: 20_000 });
  await field2.fill(second);
  await boris.getByRole('button', { name: 'Create channel' }).tap();
  await expect(boris.getByText(second, { exact: true })).toBeVisible({ timeout: 20_000 });
});

/**
 * Рейка серверов должна листаться на телефоне. Плашек в ней бывает полсотни
 * (MAX_SERVERS), а высоты у телефона — на десяток, и всё, что не поместилось,
 * раньше просто уезжало за нижний край: ни закрытого сервера внизу списка, ни
 * «создать сервер», ни шестерёнки настроек. Пальцу неоткуда было их достать —
 * прокрутки у рейки не было вовсе.
 *
 * Телефон здесь лежит набок: в альбомной ориентации высоты меньше четырёхсот
 * точек, и пяти своих серверов (потолок на человека) хватает, чтобы список не
 * поместился, — то же самое, что стоймя на полном стенде, только без двадцати
 * заведённых серверов.
 *
 * Проверка идёт колесом и `toBeInViewport`, а не `scrollIntoViewIfNeeded`:
 * последний листает программно и доезжает даже туда, куда прокрутки нет вовсе
 * (`body` с `overflow: hidden` всё ещё слушается `scrollTop`). Палец так не
 * умеет — и именно палец здесь проверяется.
 */
test('с телефона: рейка серверов листается, шестерёнка достижима', async ({ browser }) => {
  test.setTimeout(180_000);
  const boris = await person(browser, unique('Боря'), { mobile: true });
  await boris.setViewportSize({ width: 667, height: 375 });

  // Пять своих серверов — потолок на человека (MAX_SERVERS_PER_PERSON).
  for (let i = 0; i < 5; i += 1) {
    await createServer(boris, unique(`С${i}`), unique(`к${i}`));
  }

  const settings = boris.getByRole('button', { name: 'Settings' });
  await expect(settings).toBeVisible({ timeout: 20_000 });
  await wheelTo(boris, settings);
  await expect(settings).toBeInViewport();
  await settings.tap();
  await expect(boris.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
});

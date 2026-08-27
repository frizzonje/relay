import { expect, type Page } from '@playwright/test';
import { person, test, unique } from '../fixtures/stand';

/**
 * Личные сообщения: то самое «готово» первого этапа плана 2.0 — двое
 * переписываются, и написанное переживает перезагрузку страницы.
 *
 * Почему это нельзя проверить ни юнитом, ни серверным тестом. Реплика идёт
 * длинной дорогой: палитра людей (`dm-people`) → открытие беседы (`dm-open`)
 * → та же лента, что у канала (`chat`/`chat-history`), но с адресом беседы
 * вместо слага канала. Каждый кусок этой дороги накрыт своим тестом; чего
 * никакой из них не видит — что куски сходятся в один разговор двух живых
 * браузеров с разными ключами.
 *
 * Интерфейс в прогоне АНГЛИЙСКИЙ: `person()` ставит куку `relay-lang=en`
 * (см. fixtures/stand), поэтому подписи здесь из `messages/en.json`, а не из
 * `ru.json`.
 *
 * Что нужно стенду: поднятый стек (см. заголовок playwright.config) и
 * `SITE_PASSWORD`, если ворота инсталляции включены. Имена — через `unique()`,
 * так что чистить стенд между прогонами не нужно.
 */

/** Раздел ЛС: кнопка тулбара — единственный вход в него. */
async function openDirect(page: Page): Promise<void> {
  await page.getByTestId('toolbar-direct').click();
  await expect(page.getByText('Direct', { exact: true })).toBeVisible({ timeout: 15_000 });
}

/**
 * Строка переписки в списке — по нику И последней реплике сразу.
 *
 * Одним ником нельзя: ник собеседника написан на экране ещё дважды — в стеке
 * лиц у тулбара (подсказка при наведении) и в шапке открытой беседы, — и
 * `getByText(ник)` находит все три места, а Playwright на неоднозначности
 * падает. Имя роли у строки собирается из её содержимого целиком, поэтому
 * «ник, а следом эта реплика» — то, чем строка списка отличается от всего
 * остального на экране.
 */
function conversationRow(page: Page, nick: string, preview: string) {
  return page.getByRole('button', { name: new RegExp(`${nick}[\\s\\S]*${preview}`) });
}

/**
 * Написать человеку, с которым ещё не было ни слова: «+» → поиск по нику →
 * строка человека → композер.
 *
 * Кнопку «+» ищем по доступному имени, а не по `data-testid`: имя у неё и так
 * обязано быть — кнопка без подписи, одна иконка, и без `aria-label` её не
 * прочитает скринридер. Тестид тут завёл бы вторую опору для того же самого,
 * причём такую, что молча переживёт потерю первой.
 *
 * Ищем по НИКУ, а не по отпечатку: полного отпечатка в интерфейсе нет вовсе
 * (везде короткая форма), а ник у каждого человека прогона свой (`unique`).
 */
async function writeTo(page: Page, nick: string, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByPlaceholder('Search by nick or fingerprint').fill(nick);
  await page.getByText(nick, { exact: true }).click();
  const composer = page.getByPlaceholder('Message', { exact: true });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(text);
  await composer.press('Enter');
}

test('двое переписываются, история переживает перезагрузку', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Боря');
  const hello = unique('привет');

  const anya = await person(browser, her);
  const borya = await person(browser, him);

  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(anya.getByText(hello)).toBeVisible({ timeout: 15_000 });

  // Боря в этот момент в лобби и раздела ЛС не открывал — и всё равно узнаёт о
  // реплике: облачко в углу называет и того, кто написал, и первую строку.
  // Это и есть «дошло», причём дошло до человека, а не до сокета.
  await expect(borya.getByText(hello)).toBeVisible({ timeout: 25_000 });

  // Перезагрузка — граница между «видел вживую» и «лежит на сервере». Всё, что
  // Боря знал о беседе, было в памяти вкладки; после reload он не знает ничего.
  await borya.reload();
  await expect(borya.getByText('общий', { exact: true })).toBeVisible({ timeout: 25_000 });

  await openDirect(borya);
  const row = conversationRow(borya, her, hello);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Непрочитанное пережило перезагрузку вместе с историей: отметки чтения
  // висят на личности, а не на вкладке (см. stores/unread + личные настройки).
  await expect(borya.getByTestId('dm-unread')).toBeVisible({ timeout: 15_000 });

  await row.click();
  await expect(borya.getByText(hello)).toBeVisible({ timeout: 20_000 });
});

test('третий не видит чужой переписки', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Боря');
  const third = unique('Карла');
  const secret = unique('только-нам');

  const anya = await person(browser, her);
  const borya = await person(browser, him);
  // Карла заходит ДО разговора и остаётся на экране всё время, пока он идёт:
  // проверяем не «не пустили внутрь», а «не долетело» — рассылку, а не дверь.
  const karla = await person(browser, third);
  await openDirect(karla);
  await expect(karla.getByText('No conversations yet')).toBeVisible({ timeout: 15_000 });

  await openDirect(anya);
  await writeTo(anya, him, secret);

  // Точка синхронизации для проверки отсутствия: пока реплика не дошла хоть до
  // кого-то, «у Карлы ничего нет» — не наблюдение, а гонка.
  await expect(borya.getByText(secret)).toBeVisible({ timeout: 25_000 });

  // Отказ третьему на самом `dm-join` закрыт на сервере двумя тестами
  // (apps/api/src/gateway/dm.handlers.test.ts — «не пускает третьего» и
  // «уходит двоим и не уходит третьему»). Здесь спрашиваем то, что видит
  // человек: у Карлы не появилось ни строки в списке, ни точки непрочитанного,
  // ни облачка — и самого текста нет нигде на странице.
  await expect(karla.getByText('No conversations yet')).toBeVisible();
  await expect(karla.getByText(secret)).toHaveCount(0);
  await expect(karla.getByTestId('dm-unread')).toHaveCount(0);
  await expect(karla.getByText(her, { exact: true })).toHaveCount(0);
});

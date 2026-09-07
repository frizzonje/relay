import { expect } from '@playwright/test';
import {
  conversationRow,
  onStage,
  openChannel,
  openDirect,
  person,
  test,
  unique,
  writeTo,
} from '../fixtures/stand';

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

test('двое переписываются, история переживает перезагрузку', async ({ browser }) => {
  test.setTimeout(180_000);
  const her = unique('Аня');
  const him = unique('Боря');
  const hello = unique('привет');

  const anya = await person(browser, her);
  const borya = await person(browser, him);

  await openDirect(anya);
  await writeTo(anya, him, hello);
  await expect(onStage(anya, hello)).toBeVisible({ timeout: 15_000 });

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
  await expect(onStage(borya, hello)).toBeVisible({ timeout: 20_000 });
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

test('док ЛС раздвигает раскладку, а свёрнутый возвращает её как была', async ({ browser }) => {
  test.setTimeout(120_000);

  /**
   * Единственная проверка раскладки во всём наборе — и она здесь потому, что
   * проверить это больше негде. В jsdom раскладки нет вовсе: там док и его
   * сосед оба «на экране», как бы они ни лежали друг на друге. А лежали они
   * именно так: панель ЛС выезжала поверх правой колонки и стирала её целиком
   * — в канале состав, в беседе карточку собеседника с кнопкой звонка, то есть
   * ровно того человека, к которому список и ведёт.
   *
   * Второе, что здесь держится, — «свернул и стало как раньше»: между составом
   * и рейкой не остаётся ни полоски, ни язычка, ни пустого проёма. Раздел,
   * которым сейчас не пользуются, обязан уходить с экрана без остатка.
   *
   * Спрашиваем не «видно ли», а координаты прямоугольников: `toBeVisible` у
   * накрытого элемента остаётся правдой — он на месте, просто его никому не
   * видно, — а у схлопнутого в ноль дока `boundingBox` вернул бы null вместо
   * честного «ширина 0».
   */
  const page = await person(browser, unique('Женя'));
  await openChannel(page, 'общий');
  // Состав приезжает не вместе с лентой, а следом за ростером канала: меряем,
  // когда он на месте, иначе первый же замер под нагрузкой берёт пустоту.
  await expect(page.getByTestId('online-members')).toBeVisible({ timeout: 20_000 });

  const rect = (testId: string) =>
    page.getByTestId(testId).evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, width: r.width };
    });

  /**
   * «Как раньше» одной строкой: состав упирается в рейку, между ними ничего.
   * Док нулевой ширины стоит ровно на этой границе — его `x` и есть левый край
   * рейки, поэтому двух замеров хватает на оба утверждения сразу.
   */
  const flush = async () => {
    const roster = await rect('online-members');
    const dock = await rect('dm-dock');
    expect(dock.width).toBe(0);
    expect(Math.abs(roster.x + roster.width - dock.x)).toBeLessThanOrEqual(1);
  };

  await flush();

  await page.getByTestId('toolbar-direct').click();
  // Створка едет 240 мс, и замер её не ждёт: без этой строки он попадал на
  // середину хода — панель уже 232, колонка ещё 14.
  await expect
    .poll(async () => (await rect('dm-dock')).width, { timeout: 20_000 })
    .toBeGreaterThan(200);

  // Раскрытый: обе колонки на экране целиком и не налезают друг на друга.
  const roster = await rect('online-members');
  const dock = await rect('dm-dock');
  const panel = await rect('dm-drawer');
  expect(roster.width).toBeGreaterThan(200);
  expect(roster.x + roster.width).toBeLessThanOrEqual(dock.x + 1);
  // Список занял док целиком: полоска не осталась пустой рамкой рядом с ним.
  expect(Math.abs(panel.width - dock.width)).toBeLessThanOrEqual(1);

  // И место дока пришло от сцены — единственной тянущейся части раскладки.
  const stage = await page.locator('main').boundingBox();
  expect(stage!.x + stage!.width).toBeLessThanOrEqual(roster.x + 1);

  // Сворачиваем той же кнопкой, которой открывали, — своей у свёрнутого дока
  // нет и не должно быть.
  await page.getByTestId('toolbar-direct').click();
  await expect.poll(async () => (await rect('dm-dock')).width, { timeout: 20_000 }).toBe(0);
  // Уехавший список снят со страницы, а не спрятан: иначе его нашли бы поиск по
  // странице и экранный диктор.
  await expect(page.getByTestId('dm-drawer')).toHaveCount(0);
  await flush();
});

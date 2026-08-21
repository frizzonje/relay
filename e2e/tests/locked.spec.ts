import { expect } from '@playwright/test';
import { createServer, person, serverButton, test, unique } from '../fixtures/stand';

/**
 * Закрытый сервер и перезаход.
 *
 * Пароль закрытого сервера человек вводит один раз, а не каждый раз, когда
 * открыл приложение. Держится это на пропуске: сервер выдаёт его в ответ на
 * верный пароль, клиент кладёт в localStorage и предъявляет в handshake — сам
 * пароль в браузере не остаётся (он общий на всех, кто в этот сервер ходит).
 *
 * Регрессия, ради которой спек и написан: пропуск открывал сокет, но об этом не
 * знал интерфейс. Список разблокированного жил в памяти вкладки, перезагрузка
 * его стирала — и на открытом сервере снова висел замок, а клик просил пароль,
 * которого серверу уже не нужно. Каналы при этом приходили, то есть отказ был
 * ровно там, где его никто не проверял, — на экране.
 *
 * Отсюда и проверка через перезагрузку страницы: обрыв сокета (`setOffline`)
 * этого не ловит вовсе — там память вкладки цела.
 */

const PASSWORD = 'очень-тайный-пароль';

test('пароль закрытого сервера спрашивают один раз, а не на каждом заходе', async ({ browser }) => {
  test.setTimeout(120_000);
  const her = unique('Аня');
  const him = unique('Борис');
  const server = unique('Тайный');
  const channel = unique('шёпот');

  const anya = await person(browser, her);
  await createServer(anya, server, channel, { password: PASSWORD });

  // Борис видит сервер в рейке, но не его каналы: сначала пароль. Замок —
  // не картинка, а подпись кнопки: по ней и видно, каким сервер ему кажется.
  const boris = await person(browser, him);
  const locked = boris.getByRole('button', {
    name: `${server} — password protected`,
    exact: true,
  });
  await expect(locked).toBeVisible({ timeout: 25_000 });
  await locked.click();
  const field = boris.getByPlaceholder('Server password');
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill(PASSWORD);
  await boris.getByRole('button', { name: 'Enter' }).click();
  await expect(boris.getByText(channel, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(serverButton(boris, server)).toBeVisible();

  // Перезаход. Ждём главный сервер: он и значит, что реестр по сокету доехал,
  // то есть пропуск из handshake уже разобран.
  await boris.reload();
  await expect(boris.getByText('общий', { exact: true })).toBeVisible({ timeout: 25_000 });

  // Вот оно: замка нет и пароля не спрашивают — каналы открываются кликом.
  await expect(locked).toHaveCount(0);
  await serverButton(boris, server).click();
  await expect(boris.getByText(channel, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(boris.getByPlaceholder('Server password')).toHaveCount(0);
});

import { expect } from '@playwright/test';
import { connected, joinVoice, person, test, tile, unique } from '../fixtures/stand';
import { API_CONTAINER, dockerReachable, restartContainer } from '../fixtures/docker';

/**
 * Обрыв сети посреди звонка — то, как звонки ломаются на самом деле. Не «упал
 * сервер» и не «сломался кодек», а вагон метро, лифт и переключение с wifi на
 * LTE. Проверок на это не было ни одной, хотя весь механизм вокруг него —
 * восстановление сессии socket.io, грейс на сервере, лестница восстановления в
 * mesh — написан ровно под этот случай.
 *
 * Сеть отбираем у контекста браузера (`setOffline`): это ближе всего к тому,
 * что происходит на самом деле, — сокет рвётся, а страница живёт дальше со
 * всем своим состоянием, в отличие от перезагрузки.
 *
 * ПРО СРОКИ. Сокет замечает пропажу не сразу: socket.io живёт на своём
 * сердцебиении (по умолчанию пинг раз в 25 с, ожидание ответа 20 с), и до
 * сорока пяти секунд обрыв для него просто не существует. Это не недосмотр:
 * короткое моргание сети так и остаётся незамеченным вовсе, а звонок за это
 * время не разбирается и не собирается заново. Про саму связь с собеседником
 * человеку при этом говорят гораздо раньше — за плитками следит своя лестница
 * восстановления (RECOVER_GRACE_MS, четыре секунды).
 *
 * Отсюда и два теста: моргание, которого никто не должен заметить, и настоящий
 * обрыв — перезапуск api под живым звонком. Второй рвёт сокеты всей
 * инсталляции разом, поэтому в общем прогоне он пропускается: соседние спеки
 * ему не переживут. Гоняется отдельным шагом, с `E2E_DISRUPTIVE=1`.
 *
 * Второй, кстати, единственный способ получить настоящий обрыв из теста:
 * `setOffline` уже открытый веб-сокет не закрывает, и сигналинг переживает его
 * молча.
 */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

const ROOM = 'P2P общий';

test('моргание сети никто не замечает: звонок продолжается', async ({ browser }) => {
  test.setTimeout(240_000);
  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await joinVoice(anya, ROOM, her);
  await joinVoice(boris, ROOM, him);
  await connected(anya);
  await connected(boris);

  await anya.context().setOffline(true);
  await anya.waitForTimeout(6000);
  await anya.context().setOffline(false);

  // Ни звонок не пересобрался, ни собеседник ничего не потерял: шесть секунд
  // короче сердцебиения сокета, и для сигналинга этого обрыва не было.
  await expect(anya.getByText('Lost the server, reconnecting…')).toHaveCount(0);
  await expect(boris.getByText(her, { exact: true }).first()).toBeVisible();
  await connected(anya);
  await connected(boris);
});

test('сервер перезапустился под звонком: связь возвращается сама', async ({ browser }) => {
  test.setTimeout(300_000);
  test.skip(!process.env.E2E_DISRUPTIVE, 'рвёт сокеты всей инсталляции — гоняется отдельным шагом');
  test.skip(!dockerReachable(), 'нужен проброшенный сокет docker: -v /var/run/docker.sock:...');

  const her = unique('Аня');
  const him = unique('Борис');

  const anya = await person(browser, her, { permissions: ['microphone'] });
  const boris = await person(browser, him, { permissions: ['microphone'] });

  await joinVoice(anya, ROOM, her);
  await joinVoice(boris, ROOM, him);
  await connected(anya);
  await connected(boris);

  // Ровно то, что делает `relay update` на живой инсталляции: сокеты у всех
  // рвутся разом. Пропуск в медиасервер после этого мёртв, id сокета новый, и
  // звонок собирается заново — это и проверяем.
  await restartContainer(API_CONTAINER);
  await expect(anya.getByText('The server is back.')).toBeVisible({ timeout: 150_000 });

  await connected(anya);
  await connected(boris);
  // И собеседник ровно один: плитку от прежнего сокета снимает грейс, а не
  // оставляет висеть рядом с новой.
  await expect(tile(boris, her)).toHaveCount(1);
  await expect(tile(anya, him)).toHaveCount(1);
});

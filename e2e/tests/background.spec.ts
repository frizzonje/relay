import { expect, test } from '@playwright/test';

/**
 * Сторож цены фона.
 *
 * Атмосфера (`components/layout/Background.tsx` + `.atmos` в globals.css) лежит
 * под всем приложением и видна там, где каркас её не закрывает. Однажды она уже
 * стоила приложению кадров: два пятна во весь экран с `filter: blur(48px)` и
 * `mix-blend-mode: screen`, а спотлайт и сетка под курсором собирались из
 * полноэкранных градиента и маски по переменным --mx/--my. Такой слой браузер
 * не может нарисовать один раз и потом возить готовым — он пересобирает его на
 * каждом кадре, который страница вообще рисует, а рисует она их непрерывно:
 * хватает пульсирующей точки «в сети». Замер на стенде: 7-10 кадров в секунду
 * против 55 после правки, и хуже всего было как раз в движении мыши.
 *
 * Спрашиваем не «сколько кадров» — такой замер зависит от того, чем занята
 * машина, и врал бы через раз, — а то, из-за чего кадры терялись: слой обязан
 * быть готовой картинкой, которую только двигают.
 *
 * Логин не нужен: фон живёт в корневой раскладке и есть на любой странице,
 * включая ворота с паролем.
 */
test('фон под курсором двигается, но не перерисовывается', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.locator('.atmos')).toBeAttached({ timeout: 20_000 });

  const paint = (sel: string) =>
    page.locator(sel).evaluate((e) => {
      const c = getComputedStyle(e);
      return {
        // Входные данные отрисовки: пока они не меняются, слой перерисовывать
        // не из-за чего.
        background: c.backgroundImage,
        mask: c.maskImage,
        filter: c.filter,
        blend: c.mixBlendMode,
        transform: (e as HTMLElement).style.transform,
        width: (e as HTMLElement).offsetWidth,
      };
    });

  await page.mouse.move(300, 200);
  await page.waitForTimeout(200);
  const spotA = await paint('.atmos__spot');
  const meshA = await paint('.atmos__mesh');

  await page.mouse.move(900, 560);
  await page.waitForTimeout(200);
  const spotB = await paint('.atmos__spot');
  const meshB = await paint('.atmos__mesh');

  // Свет пошёл за курсором…
  expect(spotB.transform).not.toBe(spotA.transform);
  expect(meshB.transform).not.toBe(meshA.transform);
  // …и это единственное, что изменилось: рисовать заново нечего.
  expect(spotB.background).toBe(spotA.background);
  expect(meshB.mask).toBe(meshA.mask);

  // Слой размером со свет, а не с экран: полноэкранный пересобирался бы целиком
  // на каждое движение мыши, каким бы дешёвым ни было само его содержимое.
  const viewport = page.viewportSize()!.width;
  expect(spotA.width).toBeLessThan(viewport / 2);
  expect(meshA.width).toBeLessThan(viewport / 2);

  // И ни размытия, ни смешивания ни на одном слое атмосферы: и то и другое
  // заставляет браузер пересобирать слой каждый кадр (см. заголовок).
  const heavy = await page.locator('.atmos').evaluate((root) =>
    [root, ...root.querySelectorAll('*')]
      .map((e) => {
        const c = getComputedStyle(e);
        return { cls: (e as HTMLElement).className, filter: c.filter, blend: c.mixBlendMode };
      })
      .filter((x) => x.filter !== 'none' || x.blend !== 'normal'),
  );
  expect(heavy, 'дорогие слои в фоне').toEqual([]);
});

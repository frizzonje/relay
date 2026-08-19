import { defineConfig, devices } from '@playwright/test';

/**
 * Прогон против поднятого прод-стека (api+web+caddy за одним origin).
 * BASE_URL задаёт раннер: в Docker-сети это https://caddy (DOMAIN=caddy →
 * внутренний CA Caddy для single-label-хоста), локально — https://localhost.
 * Сертификат самоподписанный → ignoreHTTPSErrors.
 *
 * Браузер должен быть не старше Chromium 137: личность в 1.0 стоит на Ed25519
 * в WebCrypto, а до 137 его в Chrome не было — на старом устройство не
 * доводит до конца заведение ключа, и окно выбора имени не закрывается вовсе.
 * Версия @playwright/test обязана совпадать с тегом образа playwright, которым
 * это запускают (см. .github/workflows/ci.yml).
 *
 * Спеки изолированы именами, а не стендом: сервер, канал и ник каждый берёт
 * через `unique()` (см. fixtures/stand), и двух одинаковых на инсталляции не
 * бывает — ни между спеками одного прогона, ни между прогонами. Поэтому весь
 * набор гоняется разом и параллельно, а стенд между прогонами чистить не надо.
 * Убирать за собой они по-прежнему не убирают: заведённые серверы копятся до
 * `down -v`, и на потолки инсталляции (MAX_SERVERS, MAX_CHANNELS) один и тот же
 * стенд когда-нибудь наткнётся.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://localhost',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

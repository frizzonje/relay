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
 * ЧЕГО ЗДЕСЬ ЕЩЁ НЕТ: спеки не изолированы друг от друга. Каждая заводит свои
 * серверы и каналы под постоянными именами и после себя их не убирает, поэтому
 * поодиночке на чистом стенде зелены все, а подряд в одном прогоне — мешают
 * друг другу. Чинится именами, уникальными на прогон (или уборкой за собой);
 * до тех пор гонять по одной, вытирая базу между ними.
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

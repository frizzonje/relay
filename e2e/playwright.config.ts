import { defineConfig, devices } from '@playwright/test';

/**
 * Прогон против поднятого прод-стека (api+web+caddy за одним origin).
 * BASE_URL задаёт раннер: в Docker-сети это https://caddy (DOMAIN=caddy →
 * внутренний CA Caddy для single-label-хоста), локально — https://localhost.
 * Сертификат самоподписанный → ignoreHTTPSErrors.
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

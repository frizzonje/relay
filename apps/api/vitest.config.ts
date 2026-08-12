import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // scrypt дорог намеренно, и через семафор на два места очередь из проверок
    // пароля идёт последовательно; под инструментированием покрытия дефолтные
    // 5 с — это про сборщик, а не про тест.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // `all` — считаем и то, что ни один тест не импортировал: без этого
      // непокрытый модуль просто не попадает в отчёт, и цифра врёт вверх.
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Стенд для тестов гейтвея, не продуктовый код.
        'src/gateway/testkit.ts',
        // Точки сборки без собственной логики: main.ts поднимает Nest и слушает
        // порт прямо при импорте (его проверяемая часть вынесена в http-gate.ts),
        // app.module.ts — один список провайдеров.
        'src/main.ts',
        'src/app.module.ts',
        // Схема: объявления без поведения. Их правильность проверяется не
        // покрытием, а тем, что TypeORM после миграции ничего не хочет
        // дописать (src/db/schema.test.ts) — и настоящей базой в e2e.
        'src/db/entities.ts',
        'src/db/migrations/**',
      ],
      reporter: ['text', 'html'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Поддельные mediasoup и socket.io для тестов, не продуктовый код.
        'src/media/testkit.ts',
        // Точки сборки: main.ts поднимает Nest прямо при импорте, app.module.ts
        // — один список провайдеров.
        'src/main.ts',
        'src/app.module.ts',
      ],
      reporter: ['text', 'html'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});

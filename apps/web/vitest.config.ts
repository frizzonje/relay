import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Тот же alias, что в tsconfig: '@/...' → корень apps/web.
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['lib/**/*.test.{ts,tsx}', 'stores/**/*.test.{ts,tsx}'],
    // По умолчанию node; тесты, которым нужен DOM, объявляют jsdom через
    // // @vitest-environment jsdom в шапке файла.
    environment: 'node',
    // Первый динамический импорт модуля под jsdom + инструментированием
    // покрытия занимает секунды: дефолтные 5 с — это про сам тест, а не про
    // разогрев сборщика.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['lib/**/*.{ts,tsx}', 'stores/**/*.ts'],
      exclude: ['**/*.test.*'],
      reporter: ['text', 'html'],
    },
  },
});

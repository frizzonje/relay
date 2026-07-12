import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Тот же alias, что в tsconfig: '@/...' → корень apps/web.
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts', 'stores/**/*.test.ts'],
    // По умолчанию node; тесты, которым нужен DOM, объявляют jsdom через
    // // @vitest-environment jsdom в шапке файла.
    environment: 'node',
  },
});

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
    // Компоненты сюда попали позже: почти всё, что стоит проверять, живёт в
    // lib и stores, но есть вещи, которых там не поймать вовсе — например
    // доезжает ли «человек говорит» из стора до самой картинки лица.
    include: [
      'lib/**/*.test.{ts,tsx}',
      'stores/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
    ],
    // По умолчанию node; тесты, которым нужен DOM, объявляют jsdom через
    // // @vitest-environment jsdom в шапке файла.
    environment: 'node',
    // Первый динамический импорт модуля под jsdom + инструментированием
    // покрытия занимает секунды: дефолтные 5 с — это про сам тест, а не про
    // разогрев сборщика.
    testTimeout: 20_000,
    // По той же причине и хуки. Тесты голоса тянут дирижёра целиком в
    // `beforeAll`, и под нагрузкой (CI гоняет api и веб разом) дефолтные 10 с
    // он не всегда успевает — падал не тест, а разогрев, причём молча: файл
    // помечался упавшим, а все его случаи — пропущенными.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['lib/**/*.{ts,tsx}', 'stores/**/*.ts'],
      exclude: ['**/*.test.*'],
      reporter: ['text', 'html'],
    },
  },
});

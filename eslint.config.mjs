// @ts-check
// Единый flat-конфиг ESLint 9 для монорепо. Запуск из корня: `pnpm lint`.
// Форматирование отдано Prettier (eslint-config-prettier гасит конфликтующие правила).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Сборочный каталог Rust-клиента: у того, кто собирал десктоп локально,
      // сюда падают сгенерированные Tauri скрипты, и линт тонет в их ошибках.
      'clients/desktop/src-tauri/target/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      'e2e/**',
      '.pnpm-store/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Фронт: Next (core-web-vitals) + правила хуков React + браузерные глобалы.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
      // App Router — каталога pages/ нет, правило неприменимо.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Бэк и общий пакет — Node-окружение.
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Экран выбора сервера десктоп-клиента: обычная браузерная страница внутри
  // webview (без сборки и без Next), поэтому браузерные глобалы ей нужны так же,
  // как фронту — иначе весь файл тонет в no-undef.
  {
    files: ['clients/desktop/src/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // AudioWorklet демо-звука: исполняется в отдельном worklet-скоупе, где нет ни
  // window, ни модульной сборки, зато есть свои глобалы (globals.browser их не
  // знает) — без этого файл падает на no-undef.
  {
    files: ['apps/web/public/*-worklet.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.audioworklet } },
  },

  // CommonJS-скрипты сборки (Node, require разрешён).
  {
    files: ['**/*.cjs', 'scripts/**'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Осознанные послабления: RTC-касты и SSR-заглушки местами требуют any;
  // неиспользуемые аргументы с префиксом «_» — норма.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  prettier,
);

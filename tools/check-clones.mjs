#!/usr/bin/env node
// Клоны кода: один и тот же кусок в двух местах (jscpd, от 8 строк и 60
// токенов). Копия — это правка, которую однажды сделают в одном месте из двух.
//
// Пара файлов с клоном допустима, только если записана ниже: в ALLOWED —
// намеренные (с причиной), в DEBT — известный долг, который ещё не убран
// (с ссылкой на план). Новый клон роняет проверку; убранный, но оставшийся в
// DEBT, — тоже: список обязан говорить правду.
//
// Запуск: node tools/check-clones.mjs (или pnpm clones:check).

import { createRequire } from 'node:module';
import { relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// CommonJS-вход, а не ESM: ESM-сборка jscpd 4.3 импортирует `colors/safe` без
// расширения, и Node её не грузит.
const { detectClones } = createRequire(import.meta.url)('jscpd');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATHS = [
  'apps/api/src',
  'apps/sfu/src',
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/web/stores',
  'packages/shared/src',
];

/** Пара «файл ↔ файл» (по алфавиту) → почему копия намеренная. */
const ALLOWED = {
  'apps/api/src/auth/auth.ts ↔ packages/shared/src/auth.ts':
    'синхронный близнец пропуска на node:crypto; формат сторожит тест parity в auth.test.ts',
  'apps/api/src/gateway/testkit.ts ↔ apps/sfu/src/media/testkit.ts':
    'подделка сокета socket.io в двух приложениях, которые друг от друга не зависят',
  'apps/api/src/db/entities.ts ↔ apps/api/src/db/entities.ts':
    'одинаковые декораторы колонок у разных сущностей TypeORM — объявление схемы, а не логика',
};

/** Пара → где записан долг. Пустеет по мере уборки (docs/plans/code-audit.md, D4). */
const DEBT = {
  'apps/api/src/gateway/guests.handlers.ts ↔ apps/api/src/gateway/voice.handlers.ts':
    'одинаковый набор зависимостей в конструкторе; уходит с DI модулей Nest — фаза 2 architecture-cleanup.md',
};

const key = (a, b) => [a, b].sort().join(' ↔ ');

const clones = await detectClones({
  path: PATHS.map((p) => resolve(ROOT, p)),
  minLines: 8,
  minTokens: 60,
  format: ['typescript', 'tsx', 'javascript'],
  ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.test.tsx'],
  silent: true,
  reporters: [],
});

const found = new Map();
for (const c of clones) {
  const a = relative(ROOT, c.duplicationA.sourceId);
  const b = relative(ROOT, c.duplicationB.sourceId);
  const k = key(a, b);
  const where = `${a}:${c.duplicationA.start.line} ↔ ${b}:${c.duplicationB.start.line}`;
  if (!found.has(k)) found.set(k, []);
  found.get(k).push(where);
}

const problems = [];
for (const [k, places] of found) {
  if (ALLOWED[k] || DEBT[k]) continue;
  problems.push(`клон: ${places.join(', ')}`);
}
for (const k of Object.keys(DEBT)) {
  if (!found.has(k)) problems.push(`долг убран, а запись осталась — удалите из DEBT: ${k}`);
}

if (problems.length) {
  console.error(`clones: ${problems.length}\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nВынесите общее в одно место. Намеренная копия — в ALLOWED tools/check-clones.mjs, с причиной.',
  );
  process.exit(1);
}
const debt = Object.keys(DEBT).length;
console.log(`clones: новых нет${debt ? `, записанный долг: ${debt}` : ''}`);

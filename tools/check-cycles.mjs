#!/usr/bin/env node
// Циклы импорта по каждому пакету. Цикл — это модуль, который нельзя понять,
// не поняв другой, который не понять без первого; при загрузке он же — `undefined`
// там, где ждали значение. Исключения — только записанные ниже, с причиной.
//
// Запуск: node tools/check-cycles.mjs (или pnpm cycles:check).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import madge from 'madge';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  { name: 'shared', paths: ['packages/shared/src'] },
  { name: 'api', paths: ['apps/api/src'] },
  { name: 'sfu', paths: ['apps/sfu/src'] },
  {
    name: 'web',
    paths: ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'apps/web/stores'],
    // Алиас `@/` — явным `baseUrl`: из tsconfig без него madge путей не
    // разрешает и молча теряет половину рёбер графа (163 вместо 944), а граф
    // без рёбер циклов не содержит по определению.
    alias: { '@/*': ['./*'] },
  },
];

/** Цикл, записанный по порядку модулей, → почему он допустим. */
const ALLOWED = {
  'lib/signer.ts > lib/signer-shell.ts':
    'обратная сторона — динамический import() внутри функции: модуль грузится по требованию, а не при загрузке',
};

const problems = [];
for (const pkg of PACKAGES) {
  const baseDir = resolve(ROOT, pkg.alias ? dirname(pkg.paths[0]) : pkg.paths[0]);
  const graph = await madge(
    pkg.paths.map((p) => resolve(ROOT, p)),
    {
      baseDir,
      fileExtensions: ['ts', 'tsx'],
      excludeRegExp: [/\.test\.tsx?$/, /node_modules/, /\/dist\//],
      tsConfig: {
        compilerOptions: {
          baseUrl: baseDir,
          module: 'esnext',
          moduleResolution: 'bundler',
          jsx: 'preserve',
          ...(pkg.alias ? { paths: pkg.alias } : {}),
        },
      },
    },
  );
  const edges = Object.values(graph.obj()).reduce((n, deps) => n + deps.length, 0);
  // Граф без рёбер циклов не содержит по определению: это не «чисто», а
  // сломанное разрешение импортов.
  if (edges < Object.keys(graph.obj()).length) {
    problems.push(
      `${pkg.name}: рёбер ${edges} на ${Object.keys(graph.obj()).length} файлов — импорты не разрешаются`,
    );
  }
  for (const cycle of graph.circular()) {
    const key = cycle.join(' > ');
    if (!ALLOWED[key]) problems.push(`${pkg.name}: ${key}`);
  }
}

if (problems.length) {
  console.error(`cycles: ${problems.length}\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`cycles: ${PACKAGES.length} пакета без циклов импорта`);

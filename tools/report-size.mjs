#!/usr/bin/env node
// Размер: файлы и функции, которые стоит разглядеть на разрез.
//
// Отчёт, а не гейт. Длина сама по себе не приговор — каталог настроек или
// таблица глифов законно длинные; режут, когда у файла больше одной причины
// меняться (docs/plans/module-split.md). Отчёт говорит, куда смотреть.
//
// Считаются строки КОДА: без пустых и без комментариев. Код здесь
// комментирован плотно, и `wc -l` вдвое завышал бы почти каждый файл.
//
// Запуск: node tools/report-size.mjs (или pnpm size:report).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  'apps/api/src',
  'apps/sfu/src',
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/web/stores',
  'packages/shared/src',
];

/** Файл длиннее — кандидат на разрез (module-split.md, «Что считаем большим»). */
const FILE_LINES = 300;
/** Функция длиннее — кандидат на вынос кусков в именованные помощники и хуки. */
const FUNCTION_LINES = 150;

const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'coverage']);

function* sources(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* sources(rel);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      yield rel;
    }
  }
}

const isJsDoc = (node) =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * Номера строк (с нуля), на которых есть хоть один токен кода. Токены — листья
 * дерева разбора, а не голый сканер: без парсера сканер не отличает `}` внутри
 * `${…}` от закрывающей скобки и `/` деления от начала регулярки — и считает
 * кодом комментарии после первой же шаблонной строки.
 */
function codeLines(file) {
  const lines = new Set();
  const visit = (node) => {
    if (isJsDoc(node)) return;
    const kids = node.getChildren(file);
    if (kids.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      // Многострочный токен (шаблонная строка, JSX-текст) — код на всех своих строках.
      const from = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
      const to = file.getLineAndCharacterOfPosition(node.getEnd()).line;
      for (let line = from; line <= to; line++) lines.add(line);
      return;
    }
    for (const kid of kids) visit(kid);
  };
  visit(file);
  return lines;
}

function countIn(lines, file, node) {
  const from = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
  const to = file.getLineAndCharacterOfPosition(node.getEnd()).line;
  let n = 0;
  for (let line = from; line <= to; line++) if (lines.has(line)) n++;
  return n;
}

function nameOf(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  // `const Foo = () => …`, `const Foo = forwardRef(() => …)`
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isBlock(p) || ts.isSourceFile(p)) break;
  }
  return '(анонимная)';
}

const files = [];
const functions = [];

for (const pkg of PACKAGES) {
  for (const rel of sources(pkg)) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
    const lines = codeLines(file);
    files.push({ rel, code: lines.size, total: text.split('\n').length });

    const visit = (node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const code = countIn(lines, file, node);
        if (code > FUNCTION_LINES) functions.push({ rel, name: nameOf(node), code });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}

const big = files.filter((f) => f.code > FILE_LINES).sort((a, b) => b.code - a.code);
console.log(`Файлы длиннее ${FILE_LINES} строк кода: ${big.length} из ${files.length}\n`);
for (const f of big)
  console.log(`  ${String(f.code).padStart(5)} / ${String(f.total).padEnd(5)} ${f.rel}`);

functions.sort((a, b) => b.code - a.code);
console.log(`\nФункции длиннее ${FUNCTION_LINES} строк кода: ${functions.length}\n`);
for (const f of functions) console.log(`  ${String(f.code).padStart(5)}  ${f.name}  ${f.rel}`);

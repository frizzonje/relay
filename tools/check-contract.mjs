#!/usr/bin/env node
// Проверка, что у контракта один дом — @relay/shared.
//
//   1. Тени: имя, которое экспортирует shared, приложение объявляет заново.
//   2. Второй путь: приложение реэкспортирует имя из shared через свой модуль
//      или заводит ему второе имя (`type Source = SfuSource`).
//   3. Копии по форме: тип в приложении с тем же набором полей, что у типа
//      контракта или у типа в другом приложении. Проверка по именам их не
//      видит — переименованная копия (`BanView` вместо `BanEntry`) проходит её
//      насквозь; именно так девять копий пережили фазу 1.
//
// Исключения — только записанные ниже, каждое с причиной.
// Запуск: node tools/check-contract.mjs (или pnpm contract:check).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SHARED = 'packages/shared/src';
const APPS = {
  api: ['apps/api/src'],
  sfu: ['apps/sfu/src'],
  web: ['apps/web/app', 'apps/web/components', 'apps/web/lib', 'apps/web/stores'],
};

/** Намеренные реализации под тем же именем: `файл#имя` → почему. */
const SHADOW_ALLOWED = {
  'apps/api/src/identity/crypto.ts#isPublicKey':
    'серверная проверка на Buffer: shared проверяет через atob, которому на сервере не место',
  'apps/api/src/identity/crypto.ts#isSignature': 'то же, что isPublicKey',
  'apps/api/src/identity/crypto.ts#fingerprint':
    'синхронный node:crypto: отпечаток считается на каждом входе, shared — асинхронный Web Crypto',
  // Пропуск и гостевой токен: синхронные близнецы на node:crypto для ворот,
  // которые спрашивают их на каждый запрос и каждое рукопожатие. Shared —
  // Web Crypto для middleware Next. Формат байт в байт сторожит тест
  // «parity» в apps/api/src/auth/auth.test.ts.
  'apps/api/src/auth/auth.ts#issueToken': 'синхронный близнец, см. выше',
  'apps/api/src/auth/auth.ts#verifyToken': 'синхронный близнец, см. выше',
  'apps/api/src/auth/auth.ts#issueGuestToken': 'синхронный близнец, см. выше',
  'apps/api/src/auth/auth.ts#verifyGuestToken': 'синхронный близнец, см. выше',
};

/**
 * Совпадения по форме, которые копиями не являются: набор полей → почему.
 * Ключ — поля через запятую в алфавитном порядке, как их печатает отчёт.
 */
const SHAPE_ALLOWED = {};

/** Форма короче этого — не форма, а совпадение (`{ ok, error }`). */
const MIN_FIELDS = 3;

// ── Обход файлов ────────────────────────────────────────────────────────────

const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'coverage', 'testing']);

function* sources(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* sources(rel);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$|testkit\.ts$/.test(entry.name)
    ) {
      yield rel;
    }
  }
}

function parse(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
}

const exported = (node) =>
  ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export ||
  node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Имена верхнего уровня файла: `[имя, узел]`. */
function* declarations(file) {
  for (const st of file.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) yield [d.name.text, st];
      }
    } else if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      yield [st.name.text, st];
    }
  }
}

/**
 * Поля верхнего уровня у интерфейса или у псевдонима на литерал объекта.
 * Интерфейс, который расширяет тип контракта, — реализация, а не копия
 * (`ServerMedia extends SfuMedia` уточняет `unknown` до типов mediasoup).
 */
function shapeOf(node) {
  let members;
  if (ts.isInterfaceDeclaration(node)) {
    const parents = node.heritageClauses?.flatMap((h) => h.types) ?? [];
    if (parents.some((p) => contract.has(p.expression.getText()))) return null;
    members = node.members;
  } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type))
    members = node.type.members;
  else return null;
  const fields = members
    .filter((m) => (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.name)
    .map((m) => m.name.getText())
    .sort();
  return fields.length >= MIN_FIELDS ? fields.join(',') : null;
}

/** `type X = Untrusted<wire.X>` — тело с клиента под именем контракта, это и есть замысел. */
function isUntrustedTwin(name, node) {
  if (!ts.isTypeAliasDeclaration(node) || !ts.isTypeReferenceNode(node.type)) return false;
  if (node.type.typeName.getText() !== 'Untrusted') return false;
  const arg = node.type.typeArguments?.[0];
  return !!arg && ts.isTypeReferenceNode(arg) && arg.typeName.getText().endsWith(`.${name}`);
}

/**
 * `type Source = SfuSource` — второе имя тому же типу. Псевдоним с
 * подставленными аргументами (`SfuConsumer<ClientMedia>`) — уже другой тип.
 */
function renamedContract(node) {
  if (!ts.isTypeAliasDeclaration(node) || !ts.isTypeReferenceNode(node.type)) return null;
  const target = node.type.typeName.getText();
  if (!contract.has(target)) return null;
  const own = (node.typeParameters ?? []).map((p) => p.name.text).join(',');
  const passed = (node.type.typeArguments ?? []).map((a) => a.getText()).join(',');
  return own === passed ? target : null;
}

// ── Контракт ────────────────────────────────────────────────────────────────

const contract = new Set();
/** форма → «Имя @ файл» у типов контракта. */
const shapes = new Map();
const note = (shape, where) => {
  if (!shapes.has(shape)) shapes.set(shape, []);
  shapes.get(shape).push(where);
};

for (const rel of sources(SHARED)) {
  const file = parse(rel);
  for (const [name, node] of declarations(file)) {
    if (!exported(node)) continue;
    contract.add(name);
    const shape = shapeOf(node);
    if (shape) note(shape, { name, rel, app: 'shared' });
  }
}

// ── Приложения ──────────────────────────────────────────────────────────────

const problems = [];

for (const [app, roots] of Object.entries(APPS)) {
  for (const root of roots) {
    for (const rel of sources(root)) {
      const file = parse(rel);

      for (const [name, node] of declarations(file)) {
        if (
          contract.has(name) &&
          !SHADOW_ALLOWED[`${rel}#${name}`] &&
          !isUntrustedTwin(name, node)
        ) {
          problems.push(
            `${rel}: «${name}» объявлен заново — это имя контракта, импортируй его из @relay/shared`,
          );
        }
        const renamed = renamedContract(node);
        if (renamed) {
          problems.push(`${rel}: «${name}» — второе имя для «${renamed}» из @relay/shared`);
        }
        const shape = shapeOf(node);
        if (shape) note(shape, { name, rel, app });
      }

      for (const st of file.statements) {
        if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
        if (st.moduleSpecifier.text !== '@relay/shared') continue;
        const names =
          st.exportClause && ts.isNamedExports(st.exportClause)
            ? st.exportClause.elements.map((e) => e.name.text).join(', ')
            : '*';
        problems.push(`${rel}: реэкспорт ${names} из @relay/shared — у имени контракта один путь`);
      }
    }
  }
}

// Копия — форма, которая встречается больше чем в одном пакете. Совпадения
// внутри одного пакета — его собственное дело (их ловит чек-лист аудита).
for (const [shape, where] of shapes) {
  if (SHAPE_ALLOWED[shape]) continue;
  const packages = new Set(where.map((w) => w.app));
  if (packages.size < 2) continue;
  const list = where.map((w) => `${w.name} (${w.rel})`).join(', ');
  problems.push(`одна форма {${shape}} в разных пакетах: ${list}`);
}

if (problems.length) {
  console.error(`contract: ${problems.length} нарушений\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nИмя или форма контракта живёт в @relay/shared. Намеренное исключение — в ${relative(ROOT, fileURLToPath(import.meta.url))}, с причиной.`,
  );
  process.exit(1);
}
console.log(`contract: ${contract.size} имён, ${shapes.size} форм — копий и второго пути нет`);

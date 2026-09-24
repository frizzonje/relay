#!/usr/bin/env node
// Проверка, что документация не отстала от кода.
//
//   1. Ссылки из документов на файлы репозитория ведут на существующие файлы,
//      а якоря — на существующие заголовки.
//   2. Пути в `код`-кавычках (`apps/api/src/...`) существуют.
//   3. Каждое socket-событие контракта (@relay/shared), каждый @SubscribeMessage
//      гейтвеев и каждое событие медиасервера описаны в protocol.md / media.md.
//
// Без зависимостей: node tools/check-docs.mjs (или pnpm docs:check).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Документы, за которые отвечает проверка. `docs/plans` — история решений, её не трогаем. */
const DOCS = [
  'README.md',
  'README.ru.md',
  'CONTRIBUTING.md',
  'clients/README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** Где должны быть описаны события. */
const EVENT_DOCS = ['docs/protocol.md', 'docs/media.md'];

/** Корни, по которым путь в `кавычках` узнаётся как путь репозитория. */
const PATH_ROOTS = /^(apps|packages|clients|infra|docs|tools|e2e)\//;

const problems = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── Заголовки и якоря (как их считает GitHub) ───────────────────────────────

function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map();

function anchorsOf(rel) {
  if (anchorCache.has(rel)) return anchorCache.get(rel);
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of read(rel).split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n ? `${base}-${n}` : base);
  }
  anchorCache.set(rel, anchors);
  return anchors;
}

// ── Ссылки и пути ───────────────────────────────────────────────────────────

function stripFences(text) {
  return text.replace(/^\s*```[\s\S]*?^\s*```/gm, '');
}

function checkTarget(doc, target) {
  if (/^(https?:|mailto:|data:)/.test(target)) return;
  const [pathPart, anchor] = target.split('#');
  const decoded = decodeURIComponent(pathPart);
  const file = decoded ? relative(ROOT, resolve(join(ROOT, dirname(doc)), decoded)) : doc;
  if (decoded && !existsSync(join(ROOT, file))) {
    problems.push(`${doc}: ссылка на несуществующий путь ${target}`);
    return;
  }
  if (anchor && file.endsWith('.md') && statSync(join(ROOT, file)).isFile()) {
    if (!anchorsOf(file).has(decodeURIComponent(anchor))) {
      problems.push(`${doc}: в ${file} нет заголовка #${anchor}`);
    }
  }
}

for (const doc of DOCS) {
  const text = stripFences(read(doc));

  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) checkTarget(doc, m[1]);
  for (const m of text.matchAll(/(?:src|srcset|href)="([^"]+)"/g)) checkTarget(doc, m[1]);

  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const raw = m[1];
    if (!PATH_ROOTS.test(raw) || /[<>*…{}]/.test(raw)) continue;
    const path = raw.replace(/:\d+$/, '').replace(/[.,;]$/, '');
    if (!existsSync(join(ROOT, path))) problems.push(`${doc}: путь \`${raw}\` не существует`);
  }
}

// ── События ─────────────────────────────────────────────────────────────────

function interfaceKeys(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`не найден интерфейс ${name}`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s{2}'?([a-z][a-z-]*)'?\s*:/gm)].map((m) => m[1]);
}

const shared = read('packages/shared/src/index.ts');
const apiGateway = read('apps/api/src/gateway/signaling.gateway.ts');
const sfuGateway = read('apps/sfu/src/gateway/sfu.gateway.ts');

const events = new Map();
const note = (name, from) => events.set(name, events.get(name) ?? from);

for (const e of interfaceKeys(shared, 'ClientToServerEvents')) note(e, 'ClientToServerEvents');
for (const e of interfaceKeys(shared, 'ServerToClientEvents')) note(e, 'ServerToClientEvents');
for (const m of apiGateway.matchAll(/@SubscribeMessage\('([^']+)'\)/g)) note(m[1], 'api gateway');
for (const m of sfuGateway.matchAll(/@SubscribeMessage\('([^']+)'\)/g)) note(m[1], 'sfu gateway');
for (const m of sfuGateway.matchAll(/\.emit\('([^']+)'/g)) note(m[1], 'sfu gateway (emit)');

const described = EVENT_DOCS.map(read).join('\n');
for (const [name, from] of events) {
  if (!described.includes(`\`${name}\``)) {
    problems.push(
      `событие \`${name}\` (${from}) не описано ни в одном из ${EVENT_DOCS.join(', ')}`,
    );
  }
}

// ── Итог ────────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error(`Документация разошлась с кодом (${problems.length}):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log(`docs: ${DOCS.length} документов, ${events.size} событий — всё на месте`);

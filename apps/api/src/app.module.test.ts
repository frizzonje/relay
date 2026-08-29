import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Класс, который собирает Nest, обязан импортировать свои зависимости
 * ЗНАЧЕНИЕМ.
 *
 * Тест заведён по случившемуся, и случившееся стоит записать целиком.
 * `ChatService` получил четвёртым доводом `SettingsService`, ввезённый как
 * `import type`. Тип стирается при сборке, `emitDecoratorMetadata` записывает
 * в метаданные `Function` вместо класса, и контейнер такой довод не разрешает:
 * боевой api не поднимался вовсе, падая на старте с `Nest can't resolve
 * dependencies of the ChatService`.
 *
 * Ни один из девятисот с лишним тестов этого не заметил, и не мог: все они
 * собирают сервисы руками — `new ChatService(db, registry, dm, settings)`, — а
 * рукам метаданные декораторов не нужны. Зелёный прогон при мёртвом приложении
 * хуже красного: он выглядит как разрешение выпускать.
 *
 * Поднять здесь настоящий контейнер нельзя: vitest транспилирует через esbuild,
 * а тот `emitDecoratorMetadata` не поддерживает вовсе — метаданных не будет ни
 * у кого, и тест «падал» бы всегда и на всём. Поэтому правило проверяется по
 * исходникам, как это уже сделано для дверей панели и для копии каталога.
 *
 * Спрашивается оно у ВСЕХ, кого собирает контейнер, а не только у списка
 * `providers`: первая версия этого теста читала именно список — и пропускала
 * контроллеры, guard'ы и сам гейтвей, которые Nest создаёт тем же способом и
 * ломает тем же `import type`. Признак принадлежности — декоратор, а не место
 * в модуле.
 *
 * `import type` остаётся законным для тех, кого собирают ВРУЧНУЮ, — обработчики
 * гейтвея и `PerimeterService` как раз такие, и им метаданные не нужны. Ровно
 * поэтому проверка смотрит на декоратор: он и есть граница между «создаёт
 * контейнер» и «создаём мы сами».
 */

const SRC = join(__dirname);
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** Все исходники api, кроме самих тестов. */
function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Имена, ввезённые типом: обе формы одинаково стираются при сборке. */
function typeOnlyImports(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/import type \{([^}]*)\}/g)) {
    for (const raw of m[1].split(','))
      names.add(
        raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      );
  }
  for (const m of src.matchAll(/import \{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (name.startsWith('type '))
        names.add(
          name
            .slice(5)
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        );
    }
  }
  names.delete('');
  return names;
}

/** Где лежит класс провайдера — по строке импорта в самом модуле. */
function providerFiles(): Map<string, string> {
  const module = read('app.module.ts');
  const providers = module.slice(
    module.indexOf('providers: ['),
    module.indexOf('],', module.indexOf('providers: [')),
  );
  const names = [...providers.matchAll(/^\s{8}(\w+),$/gm)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(10);

  const files = new Map<string, string>();
  for (const name of names) {
    const from = new RegExp(`import \\{ ${name} \\} from '(\\.[^']+)'`).exec(module);
    // Гейтвей и его соседи лежат по своим путям; не нашли — пусть падает
    // громко, а не тихо пропускает провайдера мимо проверки.
    expect(from, name).not.toBeNull();
    files.set(name, `${from![1]}.ts`);
  }
  return files;
}

describe('классы, которые собирает контейнер', () => {
  it('ни один не ввозит довод конструктора типом — иначе Nest его не разрешит', () => {
    const guilty: string[] = [];
    for (const path of sources()) {
      const src = readFileSync(path, 'utf8');
      // Декоратор — единственный надёжный признак «создаёт контейнер».
      if (!/@(Injectable|Controller|WebSocketGateway)\s*\(/.test(src)) continue;
      const typeOnly = typeOnlyImports(src);
      for (const ctor of src.matchAll(/constructor\s*\(([\s\S]*?)\)\s*\{/g)) {
        for (const param of ctor[1].matchAll(/:\s*([A-Z]\w*)/g)) {
          if (typeOnly.has(param[1])) {
            guilty.push(`${path.slice(SRC.length + 1)}: довод ${param[1]} ввезён типом`);
          }
        }
      }
    }
    expect(guilty).toEqual([]);
  });

  it('проверка вообще кого-то нашла — иначе она молча ничего не смотрит', () => {
    // Сузься регулярка до нуля совпадений, тест выше остался бы зелёным навсегда.
    const decorated = sources().filter((path) =>
      /@(Injectable|Controller|WebSocketGateway)\s*\(/.test(readFileSync(path, 'utf8')),
    );
    expect(decorated.length).toBeGreaterThan(10);
  });

  it('список провайдеров модуля и его импорты не разошлись', () => {
    // Провайдер, потерявший строку импорта, не соберётся вовсе; проверка выше
    // на нём бы просто не сработала, а это тише, чем нужно.
    const files = providerFiles();
    for (const [name, path] of files) {
      expect(read(path), `${name} объявлен не там, где сказано`).toContain(`class ${name}`);
    }
  });
});

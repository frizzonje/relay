import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Провайдер, которого собирает Nest, обязан импортировать свои зависимости
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
 * исходникам, как это уже сделано для дверей панели и для копии каталога:
 * читаем список провайдеров из самого модуля и смотрим, чем они ввозят друг
 * друга.
 *
 * `import type` остаётся законным для тех, кого собирают ВРУЧНУЮ, — обработчики
 * гейтвея как раз такие, и им метаданные не нужны.
 */

const SRC = join(__dirname);
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

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

describe('провайдеры собираются контейнером', () => {
  it('ни один не ввозит другого типом — иначе Nest не разрешит довод', () => {
    const files = providerFiles();
    const names = [...files.keys()];

    const guilty: string[] = [];
    for (const [name, path] of files) {
      const source = read(path);
      for (const other of names) {
        if (other === name) continue;
        // `import type { X }` и `import { type X }` — обе формы стираются.
        const typeOnly = new RegExp(
          `import type \\{[^}]*\\b${other}\\b[^}]*\\}|import \\{[^}]*\\btype ${other}\\b[^}]*\\}`,
        );
        if (typeOnly.test(source)) guilty.push(`${name} (${path}) ввозит ${other} типом`);
      }
    }
    expect(guilty).toEqual([]);
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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from './settings';

/**
 * У каждого параметра каталога есть тот, кто его читает.
 *
 * Это обещание этапа, записанное в его же плане: «поле, которое ничего не
 * делает, — брак этапа, а не мелочь». До этого теста обещание держалось на
 * внимательности, и не удержалось: `messages.pageSize` прожил весь этап
 * мёртвым. Владелец менял размер страницы, значение сохранялось в базу, уезжало
 * в журнал — и лента всё равно отдавала пятьдесят реплик, потому что читалась
 * константа рядом с настройкой, а не сама настройка.
 *
 * Такую поломку не видит ни один тест поведения: настройка исправно
 * сохраняется, а «не подействовала» — это отсутствие события, а не ошибка.
 * Заметить её можно только сверху, глядя на каталог целиком.
 *
 * Половина этой сверки уже есть у браузера (`apps/web/stores/config.test.ts`):
 * там пометка `client` и чтение сверяются в обе стороны. Здесь — вторая
 * половина и вопрос попроще: помянут ли ключ хоть где-нибудь за пределами
 * самого каталога.
 *
 * Чего тест НЕ доказывает, и это стоит знать, глядя на его зелёный цвет: он
 * ловит ключ, о котором не знает никто, но не ключ, который прочли и положили
 * в переменную без дела. Более сильной проверки текстом не выходит, а слабая
 * здесь лучше отсутствующей — тот же `pageSize` она бы поймала в день, когда
 * его завели.
 *
 * `readOnly` не в счёт: такие строки — зеркало переменной окружения, панель их
 * показывает и не правит, а работает код с самой переменной. Требовать от них
 * потребителя значило бы требовать бессмыслицы.
 */

const dirOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Каталог существует в двух побайтово одинаковых копиях — обе не в счёт. */
const CATALOGUE = new Set(['settings.ts', 'catalog.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'test-results']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(name)) return [];
    // Тесты не в счёт: ключ, помянутый только в собственной проверке, не
    // означает, что его кто-то читает в работе.
    if (/\.test\.tsx?$/.test(name)) return [];
    return CATALOGUE.has(name) ? [] : [path];
  });
}

describe('каждый параметр каталога кем-то читается', () => {
  const files = [
    ...sources(dirOf('../../../apps/api/src')),
    ...sources(dirOf('../../../apps/web')),
  ];
  const blob = files.map((path) => readFileSync(path, 'utf8')).join('\n');

  it('исходники вообще нашлись — иначе проверка ниже пуста и всегда зелена', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('ни один ключ не остался без единого упоминания в коде', () => {
    const orphans = SETTINGS.filter(
      (spec) => !spec.readOnly && !blob.includes(`'${spec.key}'`),
    ).map((spec) => spec.key);
    expect(orphans).toEqual([]);
  });

  it('зеркала окружения потребителя не имеют и не должны', () => {
    // Обратная сторона исключения выше: помечать `readOnly` можно только то,
    // что и правда живёт в переменной окружения, — иначе исключение станет
    // способом протащить мёртвое поле мимо проверки.
    for (const spec of SETTINGS) {
      if (spec.readOnly) expect(typeof spec.env, spec.key).toBe('string');
    }
  });
});

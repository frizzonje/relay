import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Номер сборки, которую сейчас отдаёт этот сервер, — тот, что Next записал в
 * `.next/BUILD_ID`. Только для сервера: клиенту он приезжает в разметке
 * страницы (`<meta name="relay-build">`) и в ответе `/version.json`.
 *
 * Читаем файл, а не вшиваем значение в бандл на сборке: next.config
 * исполняется в каждом процессе сборки заново, и вшитое «время сборки» у
 * клиентских чанков и у сервера разошлось бы — клиент считал бы себя
 * устаревшим вечно. Файл один на сборку. Нет файла (dev-сервер) — 'dev', и
 * проверка свежести молчит.
 */
let cached: string | null = null;

export function buildId(): string {
  if (cached === null) {
    try {
      cached = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'dev';
    } catch {
      cached = 'dev';
    }
  }
  return cached;
}

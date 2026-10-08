import { QueryFailedError } from 'typeorm';

/**
 * Запись упёрлась в уникальный индекс (Postgres `23505`). Так выглядит
 * проигравший в гонке двух одинаковых вставок: проверка «такого ещё нет»
 * прошла у обоих, а база пустила одного. Ответ на это — прочитать то, что
 * завёл победитель, а не падать с 500.
 */
export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof QueryFailedError &&
    (e.driverError as { code?: unknown } | undefined)?.code === '23505'
  );
}

import { DataSource, type DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities';
import { MIGRATIONS } from './migrations';

/**
 * Подключение к Postgres.
 *
 * База в 1.0 — не кэш и не улучшение: без неё нет ни переписки, ни личности,
 * поэтому api с недоступной базой не «работает частично», а честно не работает.
 * Единственное, что здесь по-настоящему важно, — как именно он об этом говорит:
 * контейнер перезапускается сам, и невнятная ошибка превращается в бесконечную
 * ленту стектрейсов, по которой невозможно понять, что делать руками.
 */

/** Сколько соединений держим. Одноядерная VM, `max_connections=30` на сервере. */
const POOL_SIZE = 10;

/** Сколько раз пробуем достучаться до базы на старте и с какой паузой. */
const CONNECT_ATTEMPTS = 10;
const CONNECT_DELAY_MS = 1000;
const CONNECT_DELAY_MAX_MS = 8000;

export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : undefined;
}

export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    // Обе выключены намеренно. `synchronize` приводит схему к сущностям сам —
    // то есть на проде однажды удалит колонку, которую кто-то переименовал.
    // `migrationsRun` — потому что миграции гоняет bootstrap явно и ДО того,
    // как порт начнёт слушаться: иначе первый же запрос придёт в полусхему.
    synchronize: false,
    migrationsRun: false,
    poolSize: POOL_SIZE,
    // Своё имя в pg_stat_activity: когда на маленькой машине кончаются
    // соединения, первый вопрос — чьи они.
    applicationName: 'relay-api',
    logging: process.env.DB_LOGGING === '1' ? 'all' : ['error', 'warn', 'migration'],
  };
}

export function createDataSource(url: string): DataSource {
  return new DataSource(dataSourceOptions(url));
}

/** Пауза между попытками: 1, 2, 4, 8, 8, 8… секунд. */
export function retryDelay(attempt: number): number {
  return Math.min(CONNECT_DELAY_MS * 2 ** (attempt - 1), CONNECT_DELAY_MAX_MS);
}

/**
 * Почему база недоступна — человеческим языком и с указанием, что делать.
 * Различаем ровно те три случая, которые встречаются на живых инсталляциях, и
 * никогда не глотаем исходную ошибку: она уходит последней строкой.
 */
export function explainDbFailure(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return (
      'База не отвечает. Сервис `db` не поднят или ещё поднимается.\n' +
      '  Проверьте: docker compose ps db && docker compose logs db\n' +
      `  Исходная ошибка: ${message}`
    );
  }
  if (code === '28P01' || code === '28000') {
    return (
      'База отказала в пароле. DATABASE_URL и POSTGRES_PASSWORD разошлись.\n' +
      '  Пароль базы читается один раз, при создании тома: сменить его в .env\n' +
      '  задним числом недостаточно. Верните прежний пароль либо восстановите\n' +
      '  инсталляцию из бэкапа (`relay restore`).\n' +
      `  Исходная ошибка: ${message}`
    );
  }
  if (code === '3D000') {
    return (
      'Базы с таким именем нет — том создан с другим POSTGRES_DB.\n' +
      `  Исходная ошибка: ${message}`
    );
  }
  return `Не удалось подключиться к базе.\n  Исходная ошибка: ${message}`;
}

/** Текст на случай, когда переменной нет вовсе: это не сбой, а незавершённое обновление. */
export const NO_DATABASE_URL =
  'DATABASE_URL не задан, а без базы relay 1.0 не работает: в ней живут\n' +
  '  переписка, реестр и личности.\n' +
  '  Если это обновление с 0.x — стек обновился не целиком. Выполните на\n' +
  '  сервере `relay update`: он дотянет docker-compose.prod.yml с сервисом db\n' +
  '  и допишет POSTGRES_PASSWORD в .env.';

export interface ConnectOptions {
  attempts?: number;
  /** Куда писать о повторах. Отдельным параметром, чтобы тест не шумел в консоль. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  /** Подменяемая пауза — тест не должен ждать по-настоящему. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Инициализация с повторами. Проба здоровья в compose уже ждёт готовности базы,
 * но она отвечает за свой контейнер, а не за наш: при обновлении, откате или
 * ручном `docker compose up api` порядок ничем не гарантирован. Дешевле
 * подождать десяток секунд, чем упасть и разбудить рестарт-луп.
 */
export async function connectWithRetry(ds: DataSource, opts: ConnectOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? CONNECT_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ds.initialize();
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      const delay = retryDelay(attempt);
      opts.onRetry?.(attempt, delay, e instanceof Error ? e.message : String(e));
      await sleep(delay);
    }
  }
}

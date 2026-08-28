import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingRow } from '../db/entities';
import { parseRetention, retentionEnvComplaint } from '../db/retention.policy';
import { parseBytes } from '../uploads.policy';
import {
  SETTINGS,
  defaults,
  settingSpec,
  validateSetting,
  type SettingError,
  type SettingGroup,
  type SettingSpec,
  type SettingValue,
} from './catalog';

/**
 * Действующие настройки инсталляции.
 *
 * Таблица `settings` хранит ТОЛЬКО переопределения. Это главное решение здесь,
 * и оно объясняет всё остальное: строки нет — значит владелец этого параметра
 * не касался, и ответом служит умолчание каталога, равное вчерашнему поведению
 * relay. Инсталляция, где панель не открывали ни разу, работает как прежде не
 * потому, что кто-то посеял в таблицу правильные числа, а потому, что сеять
 * туда нечего.
 *
 * Ленивый посев при чтении — «нет строки, значит запишем умолчание» — отвергнут
 * намеренно. Он превращает чтение в запись: двое читателей дерутся за одну
 * вставку, у строки появляется случайный автор, а в журнал уезжает событие о
 * том, чего человек не делал.
 *
 * `.env` участвует ровно один раз — на первом старте пустой таблицы, и только
 * там, где окружение расходится с умолчанием каталога (см. `seed`). Засевать
 * совпадающее значило бы вморозить сегодняшние умолчания навсегда: правка
 * каталога в следующей версии молча не доехала бы до живых инсталляций.
 */

/**
 * Причина отказа. К шести причинам каталога добавлена седьмая, которой в нём
 * нет и быть не должно: `validateSetting` зовёт и браузер — он обязан уметь
 * проверить длину нового пароля, не отправляя его. А вот ЗАПИСАТЬ секрет общей
 * дорогой нельзя, и это правило сервера, а не контракта.
 */
export type SetError = SettingError | 'secret-path';

export type SetResult =
  | { ok: true; changed: boolean; before: SettingValue }
  | { ok: false; error: SetError };

export type SettingsListener = (key: string, value: SettingValue) => void;

/**
 * Что умеет засеваться из окружения. Список отдельный, а не «все, у кого есть
 * `env`», по двум причинам: инфраструктурные ключи (`readOnly`) живут в
 * окружении и копия в таблице разошлась бы с тем, что реально слушает порт, а
 * секрет из `.env` в таблицу не кладётся вовсе — там место тому, что задаст
 * владелец, а не пароль открытым текстом в чужой резервной копии.
 *
 * Каталог заведёт ключ с `env` мимо этого списка — упадёт тест, а не тишина.
 */
export const SEEDED_FROM_ENV: readonly string[] = [
  'messages.retentionMode',
  'messages.retentionDays',
  'files.installQuotaBytes',
];

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  /** Умолчания каталога — снимок на процесс, ниже он только читается. */
  private readonly base = frozen(defaults());

  /** Переопределения: ровно то, что лежит в таблице. */
  private readonly overrides = new Map<string, SettingValue>();

  private readonly listeners = new Set<SettingsListener>();

  constructor(private readonly db: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.load();
    await this.seed();
  }

  /**
   * Значение параметра. Синхронно — его спрашивают в горячих местах, по разу
   * на сообщение, и ходить за ним в базу значило бы платить за настройку
   * запросом на каждую реплику.
   *
   * Неизвестный ключ — ошибка, а не `undefined`. Опечатка в ключе иначе
   * выключила бы проверку молча и одинаково во всех средах: код спросил бы
   * «сколько можно упоминаний», получил бы пустоту и не ограничил ничего.
   */
  get<T extends SettingValue>(key: string): T {
    const value = this.overrides.has(key) ? this.overrides.get(key) : this.base[key];
    if (value === undefined) throw new Error(`настройки: неизвестный ключ ${key}`);
    return value as T;
  }

  /**
   * Всё, что можно показать. Секрет уходит признаком «задано» — это свойство
   * каталога (`secret: true`), а не дисциплина того, кто пишет экран.
   *
   * Инфраструктурное (`readOnly`) читается из окружения В МОМЕНТ ВЫЗОВА, а не
   * из кэша: `.env` рядом поднимает coturn и медиасервер, и показать вместо
   * него значение, снятое при старте api, значит соврать ровно тогда, когда
   * человек пришёл разбираться, почему звонок собрался, а звука нет.
   */
  public(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const spec of SETTINGS) {
      if (spec.secret) {
        out[spec.key] = this.secretIsSet(spec);
        continue;
      }
      if (spec.readOnly) {
        // `env` у readOnly есть всегда — это держит тест каталога.
        out[spec.key] = process.env[spec.env!] ?? spec.fallback;
        continue;
      }
      const value = this.get(spec.key);
      // Список уезжает наружу и обратно уже не вернётся — отдаём копию, чтобы
      // правка снимка не пришлась по кэшу.
      out[spec.key] = Array.isArray(value) ? [...value] : value;
    }
    return out;
  }

  /**
   * Записать. Проверяет каталог и только он: второй проверки здесь нет
   * намеренно — разъехавшись, она отказала бы в том, что панель предлагает.
   *
   * `changed: false` — значение уже было таким. Строку в этом случае не
   * трогаем: запись «поменял на то же самое» ничего не сообщает, а время
   * правки сдвигает.
   */
  async set(key: string, value: unknown, by: string): Promise<SetResult> {
    const check = validateSetting(key, value);
    if (!check.ok) return { ok: false, error: check.error };

    // Секрет общей дорогой не пишется. Здесь значение легло бы в `settings`
    // как есть — то есть пароль инсталляции открытым текстом в jsonb и в
    // каждом `pg_dump`, ровно то, чего мы не делаем даже при посеве из `.env`.
    // У пароля своя дорога с scrypt и отзывом выданных пропусков (задача 8);
    // до неё общий обработчик панели (задача 7) обязан получать отказ, а не
    // «сохранено».
    if (settingSpec(key)?.secret) return { ok: false, error: 'secret-path' };

    const before = this.get<SettingValue>(key);
    if (same(before, check.value)) return { ok: true, changed: false, before };

    await this.write(key, check.value, by);
    this.remember(key, check.value);
    this.emit(key, check.value);
    return { ok: true, changed: true, before };
  }

  /**
   * Сбросить группу к умолчаниям каталога. Возвращает ключи, у которых
   * значение действительно стало другим, — по ним отчитывается панель и по
   * ним же будят потребителей.
   *
   * Строки удаляются все, включая те, что и так совпадали с умолчанием:
   * «сброшено» обязано означать «переопределений в этой группе больше нет»,
   * иначе следующая правка каталога обошла бы инсталляцию стороной.
   */
  async resetGroup(group: SettingGroup, by: string): Promise<string[]> {
    // Секреты сброс не трогает по той же причине, по которой их не пишет
    // `set`: «вернуть группу к умолчаниям» не должно означать «снять пароль со
    // всей инсталляции» — умолчание у него пустая строка, то есть открытая
    // дверь, и человек, сбрасывавший вид страницы входа, узнал бы об этом
    // последним.
    const keys = SETTINGS.filter(
      (item) => item.group === group && !item.secret && this.overrides.has(item.key),
    ).map((item) => item.key);
    if (keys.length === 0) return [];

    const changed = keys.filter((key) => !same(this.overrides.get(key)!, this.base[key]));
    await this.db.getRepository(SettingRow).delete(keys);
    for (const key of keys) this.overrides.delete(key);
    for (const key of changed) this.emit(key, this.base[key]);

    // След до появления журнала (задача 6): сброс — единственная операция,
    // которая стирает чужие правки пачкой, и «кто это сделал» спрашивают о ней
    // первым делом.
    this.logger.log(`настройки: группа ${group} сброшена к умолчаниям (${by})`);
    return changed;
  }

  /** Подписка на изменение. Возвращает отписку — ею живут потребители. */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── внутреннее ────────────────────────────────────────────────────────────

  /** Прогрев кэша. Строка мимо каталога — не повод падать, но и не тишина. */
  private async load(): Promise<void> {
    this.overrides.clear();
    for (const row of await this.db.getRepository(SettingRow).find()) {
      const check = validateSetting(row.key, row.value);
      if (!check.ok) {
        // Каталог мог ужаться между версиями, а таблицу мог править человек
        // руками. И то и другое кончается умолчанием — но вслух: параметр,
        // тихо потерявший значение, ищут по всему коду, кроме этой строки.
        this.logger.warn(
          `настройки: строка ${row.key} не проходит проверку каталога (${check.error}) — беру умолчание`,
        );
        continue;
      }
      this.remember(row.key, check.value);
    }
  }

  /**
   * Первый старт: перенести в таблицу то, чем инсталляция уже отличается от
   * умолчаний. Совпавшее с умолчанием не пишется — иначе `.env` вморозил бы
   * сегодняшние числа, и обновление каталога не доехало бы до тех, кто ничего
   * не настраивал.
   */
  private async seed(): Promise<void> {
    // Непонятое значение переменной — не повод молча взять умолчание: «14» и
    // «непонятно что, поэтому 14» выглядят в логе одинаково, а означают
    // разное. Сказать об этом можно только здесь: дальше `RETENTION_DAYS`
    // никто не читает.
    const raw = process.env.RETENTION_DAYS;
    if (raw !== undefined && parseRetention(raw) === null) {
      this.logger.warn(`настройки: ${retentionEnvComplaint(raw)} — беру умолчания каталога`);
    }
    // То же самое про размер каталога загрузок: до этапа C жалобу писал сам
    // `uploads.ts`, и раз переменную больше не читает никто, кроме посева,
    // жалоба обязана переехать сюда — иначе опечатка в `.env` пропадёт молча.
    const rawQuota = process.env.UPLOAD_MAX_TOTAL_BYTES;
    if (rawQuota !== undefined && Number.isNaN(parseBytes(rawQuota, 0))) {
      this.logger.warn(
        `настройки: UPLOAD_MAX_TOTAL_BYTES="${rawQuota}" не похоже на размер — беру умолчание каталога`,
      );
    }

    for (const key of SEEDED_FROM_ENV) {
      if (this.overrides.has(key)) continue; // переопределение есть — окружение опоздало
      const value = envValue(key);
      if (value === undefined || same(value, this.base[key])) continue;

      const check = validateSetting(key, value);
      if (!check.ok) {
        this.logger.warn(
          `настройки: ${key} из окружения не проходит проверку (${check.error}) — беру умолчание`,
        );
        continue;
      }
      // Автора нет: это не правка человека, а перенос того, что уже было.
      await this.write(key, check.value, null);
      this.remember(key, check.value);
      this.logger.log(`настройки: ${key} засеян из окружения — ${JSON.stringify(check.value)}`);
    }
  }

  private async write(key: string, value: SettingValue, by: string | null): Promise<void> {
    // Время правки ставит база, и в ветке обновления — выражением: дефолт
    // колонки срабатывает только на вставке, а `new Date()` пришёл бы из часов
    // того процесса, который принял запрос (сосед `prefs.service.ts` делает
    // именно так — повторять не надо).
    await this.db.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), by],
    );
  }

  /** Секрет наружу уходит признаком. Здесь — откуда этот признак берётся. */
  private secretIsSet(spec: SettingSpec): boolean {
    if (spec.readOnly) return (process.env[spec.env!] ?? '') !== '';
    const stored = this.overrides.get(spec.key);
    if (typeof stored === 'string') return stored !== '';
    // Строки нет — значит из панели секрет не задавали, и источник у него
    // прежний, `.env`. Ответить «не задано» на запертой паролем инсталляции
    // было бы опаснее всего: по этому признаку решают, есть ли ворота вообще.
    return !!spec.env && (process.env[spec.env] ?? '') !== '';
  }

  private remember(key: string, value: SettingValue): void {
    this.overrides.set(key, Object.isFrozen(value) ? value : freeze(value));
  }

  /**
   * Разбудить потребителей. Бросивший слушатель дальше себя не идёт: значение
   * к этому моменту уже в базе и в кэше, откатывать нечего, а исключение
   * наружу означало бы «не сохранено» на сохранённом — и панель показала бы
   * ошибку там, где настройка сменилась.
   *
   * Молчать при этом нельзя: подписчик, тихо не узнавший о правке, — это ровно
   * тот случай, когда настройка «есть, но не действует», и найти его потом
   * можно только по этой строке.
   */
  private emit(key: string, value: SettingValue): void {
    for (const listener of this.listeners) {
      try {
        listener(key, value);
      } catch (err) {
        this.logger.error(
          `настройки: подписчик на ${key} бросил исключение — правка сохранена, но до него не дошла`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}

/**
 * Начальное значение из окружения. `RETENTION_DAYS` разбирает тот же
 * `parseRetention`, что и сегодняшняя ретенция: одна переменная задаёт и режим
 * хранения, и число дней, и второй разбор той же строки разошёлся бы с первым
 * на первом же `forever`. `UPLOAD_MAX_TOTAL_BYTES` — тот же `parseBytes`, что
 * читал её до появления панели: «2G» человек пишет охотнее, чем 2147483648.
 */
function envValue(key: string): SettingValue | undefined {
  if (key === 'files.installQuotaBytes') {
    const parsed = parseBytes(process.env.UPLOAD_MAX_TOTAL_BYTES, NaN);
    // Мусор в переменной — не повод засевать догадку: про него уже сказано
    // вслух в `seed`, а в таблице она осталась бы навсегда.
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const policy = parseRetention();
  // `null` — в переменной мусор. Про него уже кричит RetentionService, а
  // засевать догадку в таблицу значило бы сделать её постоянной.
  if (!policy) return undefined;
  if (key === 'messages.retentionMode') return policy.mode;
  return policy.mode === 'days' ? policy.days : undefined;
}

/** Равенство значений каталога. Список сравнивается по составу и порядку. */
function same(a: SettingValue, b: SettingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/**
 * Списки в кэше заморожены. Иначе первый же потребитель, отсортировавший
 * «запрещённые слова» на месте, поправил бы не свою копию, а действующую
 * настройку — и в базе бы это не отразилось.
 */
function freeze(value: SettingValue): SettingValue {
  return Array.isArray(value) ? (Object.freeze([...value]) as string[]) : value;
}

function frozen(values: Record<string, SettingValue>): Record<string, SettingValue> {
  for (const key of Object.keys(values)) values[key] = freeze(values[key]);
  return values;
}

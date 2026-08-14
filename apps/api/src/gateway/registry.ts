import { Logger } from '@nestjs/common';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Старый реестр серверов и каналов на диске — тот, что до 1.0 был единственным
 * хранилищем api вообще. Теперь он умеет только читаться: реестр живёт в
 * Postgres, а этот файл нужен ровно один раз — чтобы переехать (см.
 * `registry.service`, importLegacy) — и после переезда остаётся нетронутым.
 *
 * Нетронутым намеренно: это цена отката. Если 1.0 не пошёл, инсталляция
 * возвращается на 0.x со своими серверами и каналами, а не с нуля.
 *
 * Отсюда же требование, которого у обычного кэша не бывает: НИ ОДИН сценарий
 * не должен заканчиваться молчаливой потерей. Битый файл — это не «файла нет»:
 * ответить пустым реестром значит потерять все серверы и все каналы
 * инсталляции без единой строчки в логе.
 */

// Реестр направлений (api намеренно не тянет @relay/shared — типы дублируем, как и
// прочие константы здесь; формат совпадает с Channel/Server из packages/shared).
export type ChannelType = 'text' | 'voice';
// Транспорт голосового канала: p2p (mesh, каждый каждому) или sfu (через
// медиасервер). Отсутствие поля = p2p — старые registry.json читаются как есть.
export type VoiceMode = 'p2p' | 'sfu';
// Реестровый сервер (гильдия). Имя ServerEntry, чтобы не столкнуться с socket.io
// `Server` (WebSocketServer). Формат совпадает с Server из packages/shared.
export interface ServerEntry {
  id: string;
  name: string;
  emoji?: string;
  removable: boolean;
  // Хэш пароля закрытого сервера (`salt:hash` hex, scrypt). Клиенту НЕ отдаём —
  // наружу уходит только флаг `locked`. Персистится в registry.json.
  passwordHash?: string;
  // clientId устройства-создателя (localStorage) у записей, созданных до 1.0.
  // Поле отсутствует у тех, что старше самого правила владения, — такие серверы
  // остаются в общем доступе. Заслон от случайного сноса, не право.
  creatorId?: string;
  // Личность создателя — он же модератор этого сервера. Пишется начиная с 1.0;
  // в registry.json такого поля не было и быть не могло.
  creatorIdentityId?: string;
}
export interface Channel {
  id: string;
  serverId: string;
  type: ChannelType;
  name: string;
  slug: string;
  removable: boolean;
  // Только для type: 'voice'. Меняется через channel-mode, права — как у
  // channel-delete: дефолтные каналы (removable: false) остаются на p2p.
  mode?: VoiceMode;
  // clientId устройства-создателя, как у ServerEntry: владелец канала. У старых
  // записей отсутствует — их может править любой участник.
  creatorId?: string;
  // Личность создателя, как у ServerEntry.
  creatorIdentityId?: string;
}

export interface PersistedRegistry {
  servers?: ServerEntry[];
  channels?: Channel[];
}

// Куда: DATA_DIR из env, иначе `<cwd>/data` — в дев/превью процесс запускается с
// `-w /app/apps/api` на bind-примонтированном репозитории, так что `apps/api/data/`
// ложится на ХОСТ и переживает пересоздание контейнера без всяких доп-монтирований.
// В проде DATA_DIR задаём явно на persistent-том uploads (см. docker-compose.yml).
export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
export const REGISTRY_FILE = join(DATA_DIR, 'registry.json');

/**
 * Маркер состоявшегося переезда. Лежит рядом с самим файлом и отвечает на один
 * вопрос: «этот registry.json уже перелит в базу?» Без него повторный старт
 * воскрешал бы удалённые после переезда серверы.
 */
export const MIGRATED_MARKER = REGISTRY_FILE + '.migrated';

const log = new Logger('registry');

export interface LoadedRegistry {
  data: PersistedRegistry;
  // Файл был, но не прочитался: сюда отложены исходные байты. Тот, кто пришёл
  // разбираться, начинает с этого пути.
  corruptCopy?: string;
  // Данные подняты из прошлой копии, а не из основного файла.
  fromBackup?: boolean;
}

/**
 * Разбор содержимого. `null` — «это не наш файл»: и синтаксическая ошибка, и
 * пустая строка (ровно то, что оставляет пропадание питания), и правильный
 * JSON с полем не того типа. Пустой объект при этом законен — так выглядит
 * реестр без пользовательских записей.
 */
function parseRegistry(raw: string): PersistedRegistry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { servers, channels } = parsed as PersistedRegistry;
  if (servers !== undefined && !Array.isArray(servers)) return null;
  if (channels !== undefined && !Array.isArray(channels)) return null;
  return { servers, channels };
}

function readAndParse(file: string): PersistedRegistry | null {
  try {
    return parseRegistry(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadRegistry(file: string = REGISTRY_FILE): LoadedRegistry {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Файла нет — обычная первая установка, молчим. Всё остальное (нет прав,
    // ошибка ввода-вывода) — уже повод сказать вслух: «реестр пуст» и «реестр
    // недоступен» выглядят на экране одинаково, а это разные беды.
    if (code !== 'ENOENT') log.error(`не удалось прочитать ${file} (${code}): реестр не поднят`);
    return { data: {} };
  }

  const parsed = parseRegistry(raw);
  if (parsed) return { data: parsed };

  // Дальше — путь битого файла. Первым делом уносим исходные байты в сторону:
  // после этого их уже нечем перезаписать, что бы ни случилось следующим.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let corruptCopy: string | undefined = `${file}.corrupt.${stamp}`;
  try {
    renameSync(file, corruptCopy);
  } catch {
    corruptCopy = undefined;
  }

  // Прошлая копия — та, что оставляла запись реестра до 1.0. Реестр менялся
  // редко (создали сервер, переименовали канал), так что откат на одну запись
  // назад — это почти всегда откат в ничто.
  const backup = readAndParse(file + '.bak');
  if (backup) {
    log.error(
      `${file} не читается — реестр поднят из ${file}.bak. ` +
        (corruptCopy ? `Битый файл сохранён: ${corruptCopy}` : 'Битый файл отложить не удалось'),
    );
    return { data: backup, corruptCopy, fromBackup: true };
  }

  log.error(
    `${file} не читается, годной копии рядом нет — стартуем с пустым реестром. ` +
      (corruptCopy
        ? `Серверы и каналы этой инсталляции остались в ${corruptCopy}`
        : 'Битый файл отложить не удалось'),
  );
  return { data: {}, corruptCopy };
}

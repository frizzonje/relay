/**
 * Хранилище браузера (`localStorage`), которое не бросает.
 *
 * Бросает оно чаще, чем кажется: Safari в приватном режиме и переполненная
 * квота — на `setItem`, Firefox с запретом хранилища — на самом обращении к
 * `localStorage` (даже `typeof localStorage` уже исключение). Пойманный не на
 * месте, такой бросок ронял действие, ради которого человек нажал кнопку, —
 * смену микрофона, темы, хоткея. Здесь он ловится один раз: запомнить не вышло
 * — значит, выбор не переживёт перезагрузку, и только.
 *
 * Что лежит под ключом, проверяет вызывающий: хранилище общее с прошлыми
 * версиями и с руками человека в devtools, и доверять форме значения нельзя.
 */

function area(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Строка под ключом или `null` — нет её или хранилище недоступно. */
export function readStored(key: string): string | null {
  try {
    return area()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    area()?.setItem(key, value);
  } catch {
    // Приватный режим, квота, запрет хранилища — живём без запоминания.
  }
}

export function forgetStored(key: string): void {
  try {
    area()?.removeItem(key);
  } catch {
    // Нечего забывать там, куда не пускают.
  }
}

/** Разобранный JSON под ключом; `undefined` — нет его или он битый. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return; // циклическая ссылка и прочее, чего в JSON не бывает
  }
  writeStored(key, text);
}

/** Все ключи хранилища — для разбора записей прежних версий по приставке. */
export function storedKeys(): string[] {
  const store = area();
  if (!store) return [];
  try {
    const out: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) out.push(key);
    }
    return out;
  } catch {
    return [];
  }
}

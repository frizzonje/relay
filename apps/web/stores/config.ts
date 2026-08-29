import { create } from 'zustand';
import { defaults, settingSpec, type SettingValue, type SettingsSnapshot } from '@relay/shared';

/**
 * Чем настроена эта инсталляция — с точки зрения браузера.
 *
 * До этапа C клиент про настройки не знал ничего: имя инсталляции, тема, длина
 * реплики, битрейты и порог перехода в mesh жили в нём константами, и владелец,
 * поменявший их в панели, менял только серверную половину. Половина настройки
 * хуже её отсутствия: поле в панели обещает, а экран живёт по-старому.
 *
 * Начальное состояние — умолчания каталога, и это не заглушка «пока не приехало».
 * Умолчание каталога равно сегодняшнему поведению relay (ограничение 13 плана
 * этапа C), поэтому вкладка, которой снимок ещё не доехал — или которой он не
 * доедет вовсе, потому что сервер старой версии его не шлёт, — ведёт себя ровно
 * как до этапа C. Отдельного «загружается» здесь нет и не нужно.
 *
 * Снимок приезжает двумя дорогами: полем `settings` в `GET /api/config` (он
 * нужен до сокета и нужен гостю по инвайту) и событием `settings` в сокете — на
 * подключении и при каждой правке. Вторая дорога и есть то, ради чего стор
 * реактивный: настройка, доезжающая только после перезагрузки вкладки, —
 * половина настройки.
 */

interface ConfigState {
  /** Действующие значения. Ключи — из каталога `@relay/shared`. */
  settings: SettingsSnapshot;
  /** Снимок приехал (http или сокет). Пустой ответ ничего не меняет. */
  apply: (snapshot: SettingsSnapshot | undefined | null) => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  settings: defaults(),
  apply: (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return;
    // Поверх умолчаний, а не вместо них: сервер прошлой версии может не знать
    // о параметре, заведённом в этом клиенте, и ключ, пропавший из снимка,
    // обязан вернуться к умолчанию каталога, а не к `undefined`.
    set({ settings: { ...defaults(), ...snapshot } });
  },
}));

/**
 * Значение параметра вне React — там, где текста и компонента нет: сборка
 * дорожек звонка, обработчики сокета, звуковые сигналы.
 *
 * Неизвестный ключ — исключение, а не `undefined`, ровно как на сервере
 * (`SettingsService.get`). Опечатка иначе выключила бы проверку молча: код
 * спросил бы «сколько можно упоминаний», получил бы пустоту и не ограничил
 * ничего.
 */
export function setting<T extends SettingValue>(key: string): T {
  if (!settingSpec(key)) throw new Error(`настройки: неизвестный ключ ${key}`);
  return useConfigStore.getState().settings[key] as T;
}

/** То же самое внутри React: экран перерисуется, когда владелец поменяет значение. */
export function useSetting<T extends SettingValue>(key: string): T {
  if (!settingSpec(key)) throw new Error(`настройки: неизвестный ключ ${key}`);
  return useConfigStore((s) => s.settings[key] as T);
}

/**
 * Текст, который владелец волен переписать, а мог и не трогать.
 *
 * Пока значение равно умолчанию каталога, показывать надо ПЕРЕВОД — иначе
 * инсталляция, где панель не открывали, начала бы отвечать русскоязычному
 * человеку по-английски: умолчания каталога написаны на языке базы (en.json), и
 * подставить их вместо перевода значит потерять перевод. Как только владелец
 * написал своё, оно и показывается — на том языке, на котором написано.
 */
export function ownerText(key: string, translated: string): string {
  const spec = settingSpec(key);
  if (!spec) throw new Error(`настройки: неизвестный ключ ${key}`);
  const value = setting<string>(key);
  return value && value !== spec.fallback ? value : translated;
}

/** То же внутри React. */
export function useOwnerText(key: string, translated: string): string {
  const spec = settingSpec(key);
  if (!spec) throw new Error(`настройки: неизвестный ключ ${key}`);
  const value = useSetting<string>(key);
  return value && value !== spec.fallback ? value : translated;
}

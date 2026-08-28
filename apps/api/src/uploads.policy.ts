/**
 * Файловая политика как понятие — отдельно от того, кто и когда её применяет.
 *
 * Модуль стоит особняком по той же причине, что `db/retention.policy.ts`:
 * разбор `UPLOAD_MAX_TOTAL_BYTES` нужен настройкам (окружение засевается в
 * таблицу при первом старте), а действующую квоту настройки же и раздают
 * обратно `UploadsService`. Оставь разбор в сервисе — и два модуля начнут
 * импортировать друг друга.
 */

/**
 * Размер из env: голые байты или с приставкой — `2G`, `512M`, `1.5Gi`. Человек,
 * правящий `.env` руками, пишет «2G» гораздо охотнее, чем 2147483648, и молча
 * получить вместо этого дефолт — худший из возможных ответов.
 */
export function parseBytes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(raw.trim());
  if (!m) return NaN; // разбирает вызывающий: тихо подставить дефолт нельзя
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]!;
  const value = Number(m[1]) * scale;
  return value > 0 ? Math.floor(value) : NaN;
}

/**
 * Потолок на ВЕСЬ каталог. Без него 25 МБ на файл — единственное ограничение, и
 * один авторизованный клиент забивает том за минуты. Том общий: рядом лежат
 * registry.json и сертификаты Caddy, так что кончившийся диск роняет не
 * загрузки, а всё сразу. Дефолт выбран так, чтобы не съесть диск даже самого
 * скромного VPS.
 *
 * С этапа C это умолчание настройки `files.installQuotaBytes`; знающему свою
 * машину по-прежнему отвечает `UPLOAD_MAX_TOTAL_BYTES` — её засевает в таблицу
 * первый старт, и больше её не читает никто.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 ** 3;

/**
 * Расширения, которыми носят исполняемое. Список закрытый и по последнему
 * расширению, а не по «есть ли где-то в имени»: решает его тем же способом та
 * система, которая файл запустит, а `отчёт.exe.txt` открывает блокнот.
 *
 * Почему вообще по имени, а не по виду вложения: видов в relay ровно три
 * (`detectKind` — картинка, mp3 и всё остальное), и `.exe` приезжает тем же
 * `file`, что и pdf. Различить их можно только так.
 */
const EXECUTABLE_EXT =
  /\.(exe|msi|msp|scr|com|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|lnk|reg|jar|apk|dmg|pkg|deb|rpm|appimage|sh|bash|zsh|csh|ksh|run|bin|elf|dll|so|dylib|scpt|command)$/i;

/**
 * Типы, которыми исполняемое называется в заголовке. Проверяем и его: имя
 * пишет клиент, и «фото.png» с телом .exe отличается от картинки ровно здесь.
 */
const EXECUTABLE_MIME = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-msi',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-elf',
  'application/x-sharedlib',
  'application/x-dosexec',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
]);

/**
 * Похоже ли это на исполняемое. Отвечает на вопрос настройки
 * `files.blockExecutables`, и только на него: сегодня такой файл проходит
 * наравне с pdf, и включает эту проверку владелец, а не обновление.
 */
export function isExecutable(name: string, mime: string): boolean {
  return EXECUTABLE_EXT.test(name) || EXECUTABLE_MIME.has(mime.trim().toLowerCase());
}

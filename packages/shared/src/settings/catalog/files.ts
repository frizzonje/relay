/** Каталог настроек, группа `files` — файлы. */

import { KIB, MIB, GIB, TIB, ATTACHMENT_KINDS } from '../limits';
import type { SettingSpec } from '../spec';

export const FILES_SETTINGS: readonly SettingSpec[] = [
  { key: 'files.uploadsEnabled', group: 'files', kind: 'boolean', fallback: true, applies: 'now' },
  // MAX_UPLOAD_BYTES = 25 МиБ, и это же потолок настройки: поле УЖИМАЕТ предел,
  // поднять его не может. Выше 25 МиБ не пустят двое, и оба — не эта проверка:
  // multer обрывает тело на своём `limits.fileSize`, заданном при разборе
  // декоратора (upload.controller.ts), а браузер отказывает ещё раньше по общей
  // константе. Поднять потолок — работа на обе стороны сразу; предложить здесь
  // гигабайт значило бы показать владельцу поле, которое вверх не двигается.
  {
    key: 'files.maxUploadBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 25 * MIB,
    applies: 'now',
    min: 1 * KIB,
    max: 25 * MIB,
  },
  // Виды — ровно те, что различает detectKind (apps/api/src/uploads/uploads.service.ts): картинка,
  // mp3 и всё остальное. Четвёртым тут стояло «video», которого в коде нет: ролик
  // сегодня приезжает как `file`, и снятая галочка «видео» не сделала бы ничего,
  // а снятая «файл» молча унесла бы с роликами и pdf. `satisfies` держит список
  // на замке: расширится AttachmentKind — не соберётся каталог.
  {
    key: 'files.allowedKinds',
    group: 'files',
    kind: 'list',
    fallback: [...ATTACHMENT_KINDS],
    applies: 'now',
    options: ATTACHMENT_KINDS,
    max: ATTACHMENT_KINDS.length,
  },
  // Выключенные превью не запрещают картинку — они перестают её раскрывать в
  // ленте: файл приезжает карточкой, как pdf. Решает это клиент, потому что
  // «показывать» — вопрос экрана, а не сервера.
  {
    key: 'files.imagePreviews',
    group: 'files',
    kind: 'boolean',
    fallback: true,
    applies: 'now',
    client: true,
  },
  // Ноль — без квоты: сегодня никто ничего не считает.
  {
    key: 'files.perIdentityDailyBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 0,
    applies: 'now',
    min: 0,
    max: 1 * TIB,
  },
  // Потолок на ВЕСЬ каталог загрузок: без него 25 МБ на файл — единственное
  // ограничение, и один клиент забивает том за минуты. Том общий (рядом
  // registry.json и сертификаты Caddy), так что кончившийся диск роняет всё
  // сразу. 2 ГиБ не съедят диск даже самого скромного VPS; за потолком
  // вытесняются самые старые вложения. Ноль — «без квоты», и это выбор
  // владельца, а не умолчание. Знающему свою машину по-прежнему
  // отвечает UPLOAD_MAX_TOTAL_BYTES: она засевается в таблицу на первом старте
  // (см. SEEDED_FROM_ENV) и больше нигде не читается.
  {
    key: 'files.installQuotaBytes',
    group: 'files',
    kind: 'bytes',
    fallback: 2 * GIB,
    applies: 'now',
    min: 0,
    max: 1 * TIB,
    env: 'UPLOAD_MAX_TOTAL_BYTES',
  },
  {
    key: 'files.orphanSweepHours',
    group: 'files',
    kind: 'number',
    fallback: 24,
    applies: 'now',
    min: 1,
    max: 720,
  },
  // Выключен, и это не осторожность, а правда: сегодня .exe проходит наравне с
  // pdf — вид у него `file`, и никакой другой проверки на пути нет. Включённый
  // по умолчанию, он запретил бы в день обновления то, что вчера носили.
  {
    key: 'files.blockExecutables',
    group: 'files',
    kind: 'boolean',
    fallback: false,
    applies: 'now',
  },
  { key: 'files.spoilerAllowed', group: 'files', kind: 'boolean', fallback: true, applies: 'now' },
];

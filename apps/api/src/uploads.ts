import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DataSource, In } from 'typeorm';
import { AttachmentRow, MessageRow } from './db/entities';
import { SettingsService } from './settings/settings.service';
import { isExecutable } from './uploads.policy';

// Файлы храним вне public (он монтируется read-only в превью) — отдельная
// писучая папка, которую main.ts раздаёт по префиксу /uploads за авторизацией.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', 'uploads');
/**
 * Жёсткий потолок процесса: столько multer соглашается принять на один файл, и
 * это единственное ограничение, которое действует ДО того, как тело окажется на
 * диске. Оно намеренно осталось константой — предел передаётся интерсептору
 * один раз, при разборе декораторов, и настройка его не двигает.
 *
 * Настройка `files.maxUploadBytes` сужает этот потолок и проверяется по
 * НАСТОЯЩЕМУ размеру записанного файла (см. `UploadsService.register`).
 * Поднять её выше 25 МиБ сегодня некуда: столько же знает и браузер
 * (`MAX_UPLOAD_BYTES` в `@relay/shared`), и он откажет ещё до отправки.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 МБ на файл

// Разбор размера из `.env` живёт в uploads.policy.ts — там же, где его
// спрашивают настройки при первом старте. Здесь остаётся имя, под которым его
// знает всё остальное.
export { parseBytes } from './uploads.policy';

/**
 * Сколько живёт файл, которого никто не отправил в чат. Раньше TTL был общим
 * для всех загрузок и равнялся неделе — потому что метаданные жили в памяти, и
 * после рестарта файл нельзя было связать с сообщением. Теперь связь хранится
 * в базе, и слепой проход остался ровно для сирот: человек выбрал файл,
 * загрузка прошла, а сообщение он так и не отправил.
 *
 * Сутки, а не минуты: страница может висеть открытой с уже загруженным файлом,
 * и удалить его из-под неё значило бы сломать отправку молча. С этапа C это
 * умолчание настройки `files.orphanSweepHours`.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Окно квоты личности: «на сутки» — это скользящие сутки, а не с полуночи. */
const DAY_MS = 24 * 60 * 60 * 1000;

mkdirSync(UPLOAD_DIR, { recursive: true });

// То, как клиент рисует вложение: картинка инлайн, mp3 — плеером, прочее — карточкой
export type AttachmentKind = 'image' | 'audio' | 'file';

export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  // Спойлер — метка сообщения, а не файла: реестр её не хранит, гейт добавляет
  // при рассылке (см. handleChatMessage). Здесь — только чтобы тип совпал.
  spoiler?: boolean;
}

/**
 * Почему загрузку не приняли. Наружу уходит кодом состояния и короткой
 * строкой — вкладке этого хватает, чтобы сказать человеку разное про «файлы
 * выключили», «слишком большой» и «такие сюда не носят».
 */
export type UploadRefusal =
  | 'uploads-off'
  | 'too-big'
  | 'kind-not-allowed'
  | 'executable'
  | 'daily-quota';

const REFUSAL: Record<UploadRefusal, { status: HttpStatus; text: string }> = {
  'uploads-off': { status: HttpStatus.FORBIDDEN, text: 'загрузки выключены' },
  'too-big': { status: HttpStatus.PAYLOAD_TOO_LARGE, text: 'файл больше разрешённого' },
  'kind-not-allowed': {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    text: 'такие файлы не принимаются',
  },
  executable: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    text: 'исполняемые файлы не принимаются',
  },
  // 413, а не 403: человек упёрся в размер, а не в право. Отдельный код от
  // «файл больше разрешённого» не нужен — текст объясняет, во что именно.
  'daily-quota': {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    text: 'на сегодня загружено столько, сколько разрешено',
  },
};

// Минимум полей multer'а, чтобы не тянуть @types/multer
interface StoredFile {
  filename: string;
  originalname: string;
  size: number;
  mimetype: string;
}

/**
 * Кто принёс файл. Обычно это личность; когда её нет (клиент без куки сессии),
 * считаем по адресу — иначе квота на сутки обходилась бы удалением одной куки.
 */
export interface Uploader {
  identityId?: string;
  ip?: string;
}

/**
 * Единственный распознаватель вида. Он же решает, что покажет клиент, и он же
 * отвечает на вопрос «этот вид разрешён» (`files.allowedKinds`): второй разбор
 * по mime разошёлся бы с первым, и человек получил бы отказ на то, что в чате
 * выглядит картинкой.
 */
export function detectKind(mime: string, name: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  // Нативный плеер — только для mp3, как просили
  if (mime === 'audio/mpeg' || /\.mp3$/i.test(name)) return 'audio';
  return 'file';
}

// Имя для показа/скачивания: режем путь и длину, оставляем безопасные символы
function sanitizeName(raw: string): string {
  const base = (raw || 'файл').replace(/^.*[\\/]/, '').trim();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').slice(0, 80);
  return cleaned || 'файл';
}

// Файл на диске — то, чем оперируют подметание и вытеснение. Метаданные для
// этого не нужны: после рестарта их нет вовсе, а файлы остаются.
interface DiskFile {
  name: string;
  size: number;
  mtimeMs: number;
}

@Injectable()
export class UploadsService implements OnModuleInit {
  // Суммарный размер каталога. Счётчик, а не подсчёт на каждый запрос: обход
  // каталога на горячем пути стоил бы дороже самой загрузки. Сверяется с диском
  // при каждом подметании и перед вытеснением, так что разъехаться надолго
  // не может.
  private total = 0;

  private readonly logger = new Logger(UploadsService.name);

  /**
   * Что каждый уже загрузил за скользящие сутки: ключ (личность или адрес) →
   * пары «когда и сколько». В памяти, а не в базе, и это осознанный размен —
   * тот же, на котором стоят бюджет байтов на адрес (`upload.guard.ts`) и счёт
   * первых реплик в ЛС (`dm.handlers.ts`). Считать по таблице вложений нельзя:
   * оттуда строки уходят и подметанием сирот, и вытеснением по квоте
   * инсталляции, и человек добирал бы себе сутки, забив каталог.
   *
   * Цена: рестарт api прощает всем накопленное. Квота эта — про «не залить том
   * за вечер», и рестарт ради лишнего файла — не тот обход, ради которого
   * стоит платить строкой в базе на каждую загрузку.
   */
  private readonly daily = new Map<string, { at: number; bytes: number }[]>();

  /**
   * Каталог — параметр экземпляра, а не константа модуля: тесту он нужен свой,
   * и без этого каждый из них перезагружал бы модуль целиком — вместе с
   * сущностями, которые после перезагрузки перестают быть теми же классами,
   * что знает открытое соединение.
   *
   * Потолка в параметрах больше нет: его знает `files.installQuotaBytes`, и
   * спрашивается он в момент дела (см. `quota`).
   */
  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
    @Optional() readonly dir: string = UPLOAD_DIR,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Квота каталога прямо сейчас. Ноль — без квоты: вытеснять не за что. */
  private quota(): number {
    return this.settings.get<number>('files.installQuotaBytes');
  }

  /**
   * Что не так с этой загрузкой; `null` — всё в порядке. Настройки
   * спрашиваются в момент дела, а не при старте: иначе выключенные в панели
   * загрузки продолжали бы приниматься до перезапуска.
   *
   * Вид приходит уже посчитанным — тем самым `detectKind`, который дальше
   * раскладывает вложение.
   */
  private refuse(
    file: { size: number; name: string; mime: string },
    kind: AttachmentKind,
    by: Uploader,
  ): UploadRefusal | null {
    if (!this.settings.get<boolean>('files.uploadsEnabled')) return 'uploads-off';
    if (file.size > this.settings.get<number>('files.maxUploadBytes')) return 'too-big';
    if (!this.settings.get<string[]>('files.allowedKinds').includes(kind)) {
      return 'kind-not-allowed';
    }
    if (
      this.settings.get<boolean>('files.blockExecutables') &&
      isExecutable(file.name, file.mime)
    ) {
      return 'executable';
    }
    if (!this.withinDailyQuota(by, file.size)) return 'daily-quota';
    return null;
  }

  /**
   * Влезает ли этот файл в суточную квоту того, кто его принёс.
   *
   * Квота ОТКАЗЫВАЕТ, а не вытесняет, — в отличие от квоты инсталляции. Разница
   * не в реализации, а в том, чьё это ограничение: инсталляция вытесняет чужое
   * старое, потому что иначе один человек останавливал бы вложения всем;
   * личность упирается в собственный предел, и отобрать у неё вчерашние файлы
   * значило бы наказать за то, что она уже сделала по правилам.
   */
  private withinDailyQuota(by: Uploader, size: number): boolean {
    const limit = this.settings.get<number>('files.perIdentityDailyBytes');
    if (limit <= 0) return true; // ноль — без квоты (см. каталог)
    const key = by.identityId ?? by.ip;
    // Никого не опознали (тест, внутренний вызов) — считать не на кого.
    if (!key) return true;
    const since = Date.now() - DAY_MS;
    const mine = (this.daily.get(key) ?? []).filter((row) => row.at > since);
    // Подчищаем на месте: карта живёт всю жизнь процесса, а заводить ради неё
    // таймер незачем (так же считает первые реплики dm.handlers).
    if (mine.length) this.daily.set(key, mine);
    else this.daily.delete(key);
    return mine.reduce((sum, row) => sum + row.bytes, 0) + size <= limit;
  }

  /** Записать потраченное. Зовётся ПОСЛЕ того, как загрузка состоялась. */
  private chargeDaily(by: Uploader, size: number): void {
    if (this.settings.get<number>('files.perIdentityDailyBytes') <= 0) return;
    const key = by.identityId ?? by.ip;
    if (!key) return;
    this.daily.set(key, [...(this.daily.get(key) ?? []), { at: Date.now(), bytes: size }]);
  }

  /** Убрать тело, строки для которого ещё нет: отказ не должен копить мусор. */
  private drop(name: string): void {
    try {
      unlinkSync(join(this.dir, name));
    } catch {
      // Файла может уже не быть (подметание, чужие руки) — отказ от этого
      // не меняется.
    }
  }

  /**
   * Загрузка состоялась: метаданные — в базу, а не в память процесса. Именно
   * из-за памяти файл после рестарта нельзя было связать с его сообщением, и
   * именно поэтому весь каталог мёлся вслепую по времени изменения.
   */
  async register(file: StoredFile, by: Uploader = {}): Promise<Attachment & { id: string }> {
    const name = sanitizeName(file.originalname);
    const mime = file.mimetype || 'application/octet-stream';
    const kind = detectKind(file.mimetype || '', name);

    // Первое место, где известны настоящий размер и вид файла: multer пишет
    // тело раньше, чем сюда доходит хоть одна проверка, а `Content-Length`
    // до того — слово клиента и вдобавок считает вместе с обёрткой multipart.
    const refusal = this.refuse({ size: file.size, name, mime }, kind, by);
    if (refusal) {
      this.drop(file.filename);
      throw new HttpException(REFUSAL[refusal].text, REFUSAL[refusal].status);
    }

    await this.db.getRepository(AttachmentRow).insert({
      id: file.filename,
      name,
      size: file.size,
      mime,
      kind,
    });
    this.chargeDaily(by, file.size);
    this.total += file.size;
    // Только что записанный файл не вытесняем: иначе отправитель получил бы в
    // ответ ссылку на то, чего уже нет.
    const quota = this.quota();
    if (quota > 0 && this.total > quota) await this.evictOldest(file.filename);
    return {
      id: file.filename,
      url: '/uploads/' + file.filename,
      name,
      size: file.size,
      mime,
      kind,
    };
  }

  /** Есть ли такая загрузка. Единственное, что нужно чату от этого сервиса. */
  async exists(id: string | undefined): Promise<boolean> {
    if (!id) return false;
    return (await this.db.getRepository(AttachmentRow).countBy({ id })) > 0;
  }

  onModuleInit() {
    void this.sweep();
    const timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref?.(); // не держим процесс живым ради чистильщика
  }

  /**
   * Каталог как он есть на диске. Только файлы верхнего уровня: рядом лежит
   * подкаталог `state` с реестром (DATA_DIR в обоих compose — подпапка
   * uploads), и ни подметание, ни вытеснение не должны его даже замечать.
   */
  private scan(): DiskFile[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: DiskFile[] = [];
    for (const name of names) {
      try {
        const st = statSync(join(this.dir, name));
        if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // файл исчез под руками (гонка) — пропускаем
      }
    }
    return out;
  }

  /** Файл с диска вместе с его строкой: одно без другого — это мусор. */
  private async remove(name: string): Promise<void> {
    unlinkSync(join(this.dir, name));
    await this.db.getRepository(AttachmentRow).delete({ id: name });
  }

  /**
   * Подметание сирот. Сирота — загрузка, на которую не ссылается ни одно
   * сообщение и которой больше суток: либо человек выбрал файл и передумал,
   * либо сообщение с ней удалили (в том числе ретенцией — тогда файл уходит
   * следом за своим сообщением, как и обещано).
   *
   * Файлы на диске без строки в базе — отдельный случай: так выглядит упавшая
   * посреди дела загрузка и остатки от инсталляций до 1.0, где метаданные жили
   * в памяти. Их та же участь, по тому же сроку.
   *
   * Заодно это единственное место, где счётчик размера сверяется с диском.
   *
   * Публичный: его зовёт не только собственный таймер — им же начинается
   * работа после старта, и он же нужен тесту, чтобы не ждать час.
   */
  async sweep(): Promise<void> {
    const hours = this.settings.get<number>('files.orphanSweepHours');
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const orphans = await this.db
      .getRepository(AttachmentRow)
      .createQueryBuilder('a')
      .select('a.id', 'id')
      .where('a.uploaded_at < :cutoff', { cutoff })
      .andWhere((qb) => {
        const sub = qb
          .subQuery()
          .select('1')
          .from(MessageRow, 'm')
          .where('m.attachment_id = a.id')
          .getQuery();
        return `NOT EXISTS ${sub}`;
      })
      .getRawMany<{ id: string }>();

    const doomed = new Set(orphans.map((o) => o.id));
    const known = new Set(
      (await this.db.getRepository(AttachmentRow).find({ select: { id: true } })).map((a) => a.id),
    );

    const kept: DiskFile[] = [];
    for (const f of this.scan()) {
      // Файла нет в базе вовсе — считаем сиротой по возрасту самого файла.
      const stray = !known.has(f.name) && f.mtimeMs < cutoff.getTime();
      if (!doomed.has(f.name) && !stray) {
        kept.push(f);
        continue;
      }
      try {
        await this.remove(f.name);
        doomed.delete(f.name);
      } catch {
        kept.push(f); // не удалилось — значит всё ещё занимает место
      }
    }
    // Строки без файлов на диске (файл унесли руками) — тоже уборка.
    if (doomed.size) {
      await this.db.getRepository(AttachmentRow).delete({ id: In([...doomed]) });
    }

    this.total = kept.reduce((sum, f) => sum + f.size, 0);
    const quota = this.quota();
    if (quota > 0 && this.total > quota) await this.evictOldest(undefined, kept);
  }

  /**
   * Вытеснение самых старых до возвращения под потолок.
   *
   * Выбор в пользу вытеснения, а не отказа, сделан осознанно: отказ означал бы,
   * что один человек, забивший каталог, останавливает вложения всем остальным
   * до вмешательства администратора. Цена — старые вложения перестают
   * открываться, поэтому вытеснение всегда говорит об этом в лог: молчаливо
   * пропадающие файлы выглядели бы как поломка.
   */
  private async evictOldest(keep?: string, known?: DiskFile[]): Promise<void> {
    const quota = this.quota();
    // Ноль — без квоты: вытеснять не за что, и звать сюда было незачем.
    if (quota <= 0) return;
    const files = known ?? this.scan();
    // Счётчик мог разъехаться с диском (рестарт, чужие руки, сбойное удаление)
    // — перед тем как что-то удалять, сверяемся с тем, что там на самом деле.
    this.total = files.reduce((sum, f) => sum + f.size, 0);
    if (this.total <= quota) return;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // старые первыми
    let freed = 0;
    let count = 0;
    for (const f of files) {
      if (this.total <= quota) break;
      if (f.name === keep) continue;
      try {
        await this.remove(f.name);
      } catch {
        continue;
      }
      this.total -= f.size;
      freed += f.size;
      count += 1;
    }
    if (count) {
      const mib = (n: number) => Math.round(n / 1024 ** 2);
      this.logger.warn(
        `квота каталога загрузок (${mib(quota)} МиБ) исчерпана: ` +
          `вытеснено ${count} файл(ов) на ${mib(freed)} МиБ. ` +
          'Самые старые вложения в чате больше не откроются',
      );
    }
    if (this.total > quota) {
      // Осталось только то, что вытеснять нельзя (свежая загрузка). Значит
      // потолок меньше одного файла — это ошибка настройки, а не переполнение.
      this.logger.error(
        `квота каталога загрузок (${quota} Б) меньше того, ` +
          'что уже занято одной свежей загрузкой — проверьте files.installQuotaBytes',
      );
    }
  }
}

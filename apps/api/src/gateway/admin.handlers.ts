import type { AppServer, AppSocket } from './socket-data';
import type { Moderation } from './moderation';
import type { Perimeter } from './perimeter';
import type { AuditService } from '../settings/audit.service';
import type { OverviewService } from '../settings/overview.service';
import type { SettingsService } from '../settings/settings.service';
import type { IdentityService, Speaker } from '../identity/identity.service';
import type { OwnerService } from '../identity/owner.service';
import type { RolesService } from '../identity/roles.service';
import type { RetentionService } from '../db/retention.service';
import type { UploadsService } from '../uploads';
import { revokeAllSessions } from '../identity/session';
import {
  SETTINGS,
  SETTING_GROUPS,
  settingSpec,
  type SettingGroup,
  type SettingValue,
} from '../settings/catalog';
import {
  LIMIT,
  PROTOCOL_VERSION,
  str,
  trimmed,
  type AdminAction,
  type AdminActionPayload,
  type AdminActionResult,
  type AdminAuditPayload,
  type AdminAuditResult,
  type AdminBansResult,
  type AdminExport,
  type AdminImportRejection,
  type AdminPasswordPayload,
  type AdminPasswordResult,
  type AdminPeoplePayload,
  type AdminPeopleResult,
  type AdminResetPayload,
  type AdminResetResult,
  type AdminSetPayload,
  type AdminSetResult,
  type AdminStateResult,
  type AuditCursor,
  type SettingsSnapshot,
} from './protocol';

/**
 * Админ-панель: семь событий и одна дверь.
 *
 * ДВЕРЬ ПРОВЕРЯЕТ КАЖДЫЙ ОБРАБОТЧИК САМ (`me`), и это главное правило файла.
 * Соблазн проверить владение один раз — при подключении или в гейтвее — стоил
 * бы ровно того, ради чего панель и заводится: события socket.io шлёт кто
 * угодно и когда угодно, «интерфейс не показал кнопку» проверкой не считается,
 * а власть меняется под живым сокетом (ссылка владельца переводит её мгновенно,
 * см. `syncOwner`). Восьмое событие, добавленное завтра и забывшее позвать
 * `me`, оставило бы настройки инсталляции открытыми молча — поэтому дверь
 * проверяется ещё и тестом, перебирающим ВСЕ подписки `admin-*` гейтвея, а не
 * три названных руками.
 *
 * Второй роли здесь нет и не будет: модератор сервера — власть над своим
 * сервером, а панель меняет инсталляцию целиком.
 */

/**
 * Действия, которым подтверждение не нужно. Белый список, а не чёрный, — и это
 * не вкус: действие, добавленное завтра, окажется опасным по умолчанию, а
 * ошибиться здесь можно в две стороны, и они не равны. Лишний вопрос стоит
 * одного нажатия, пропущенный — чужой переписки.
 */
const SAFE_ACTIONS = new Set<AdminAction>(['export']);

/** Пароль инсталляции. Подтверждение и пометка «опасное» спрашиваются у каталога. */
const PASSWORD_KEY = 'access.sitePasswordSet';

/** Всё, что панель умеет делать кнопкой. Порядок — как в контракте. */
const ACTIONS: readonly AdminAction[] = [
  'owner-link',
  'retention-run',
  'files-sweep',
  'revoke-sessions',
  'revoke-device',
  'ban',
  'unban',
  'export',
  'import',
];

export class AdminHandlers {
  constructor(
    private readonly settings: SettingsService,
    private readonly overview: OverviewService,
    private readonly audit: AuditService,
    private readonly roles: RolesService,
    private readonly owners: OwnerService,
    private readonly identities: IdentityService,
    private readonly retention: RetentionService,
    private readonly uploads: UploadsService,
    private readonly perimeter: Perimeter,
    private readonly moderation: Moderation,
    /** Выгнать сокеты отозванного устройства — тем же кодом, что и отзыв своего. */
    private readonly dropDevice: (deviceId: string) => number,
    private readonly serverOf: () => AppServer,
  ) {}

  /**
   * Дверь. Владелец, и только он: гость по инвайту сюда не попадает вовсе
   * (власть спрашивается у личности, а у него её нет), бывший владелец теряет
   * доступ в тот же миг, когда ссылку открыл другой, — `syncOwner` пересобирает
   * права живых сокетов, и следующее же событие панели получит отказ.
   *
   * Лимитер спрашивается здесь же, как у модерации и ЛС: панель — такой же
   * сокет, и заваливать ею сервер можно ровно так же, как чем угодно другим.
   */
  private me(client: AppSocket): Speaker | undefined {
    if (!this.perimeter.allow(client)) return undefined;
    if (!this.perimeter.isOwner(client)) return undefined;
    return this.perimeter.speaker(client);
  }

  /**
   * Состояние панели одним ответом: каталог, значения, сводка.
   *
   * Каталог уезжает с сервера, хотя такой же лежит в самом клиенте: параметры
   * добавляются в любом выпуске, а версия контракта поднимается только с
   * мажором, — и панель, нарисованная по своей копии, показала бы поля, о
   * которых сервер не знает.
   *
   * Значения — `public()`, а не `snapshot()`: второй отдаёт помеченное
   * `client`, то есть то, чем пользуется браузер, а владельцу в панели нужно
   * всё. Секретов в `public()` нет и там — у них уезжает признак «задано».
   */
  async state(client: AppSocket): Promise<AdminStateResult> {
    if (!this.me(client)) return { ok: false, error: 'forbidden' };
    return {
      ok: true,
      catalog: [...SETTINGS],
      values: this.settings.public(),
      overview: await this.overview.summary(this.online()),
    };
  }

  /**
   * Записать параметр.
   *
   * Опасное (`danger` в каталоге) требует подтверждения ПОЛЕМ В ЗАПРОСЕ.
   * Диалог «вы уверены?» рисует клиент, а отвечать за режим обслуживания и за
   * стёртую переписку серверу — поэтому вопрос «спросили ли человека» здесь
   * решается не доверием к экрану.
   *
   * Причина отказа приходит из каталога как есть (`validateSetting`): «не то
   * значение» и «слишком длинное» человек чинит по-разному, и общий отказ
   * советовал бы ему невозможное.
   */
  async set(client: AppSocket, payload: AdminSetPayload): Promise<AdminSetResult> {
    const me = this.me(client);
    if (!me) return { ok: false, error: 'forbidden' };

    const key = str(payload?.key);
    const spec = settingSpec(key);
    if (!spec) return { ok: false, error: 'unknown-key' };
    if (spec.danger && payload?.confirm !== true) return { ok: false, error: 'needs-confirm' };

    const res = await this.settings.set(key, payload?.value, me.id);
    // `secret-path` — не поломка, а ответ по существу: у пароля инсталляции
    // своя дорога (scrypt и отзыв выданных пропусков), и «сохранено» на нём
    // означало бы пароль открытым текстом в jsonb.
    if (!res.ok) return { ok: false, error: res.error };
    if (res.changed) this.announce(client, me.id, [key]);
    return { ok: true, key, changed: res.changed, value: this.settings.get<SettingValue>(key) };
  }

  /**
   * Сбросить группу к умолчаниям каталога.
   *
   * Подтверждение спрашивается ВСЕГДА, а не только когда в группе есть опасное:
   * это правка десятка полей одним нажатием, и человек, вернувший «внешний вид»
   * к умолчаниям, не должен заодно молча узнать, что сбросил срок хранения.
   */
  async reset(client: AppSocket, payload: AdminResetPayload): Promise<AdminResetResult> {
    const me = this.me(client);
    if (!me) return { ok: false, error: 'forbidden' };

    const group = str(payload?.group) as SettingGroup;
    // Группы нет в каталоге — это опечатка клиента, и она того же рода, что
    // неизвестный ключ: отвечаем ею, а не «подтвердите».
    if (!SETTING_GROUPS.includes(group)) return { ok: false, error: 'unknown-key' };
    if (payload?.confirm !== true) return { ok: false, error: 'needs-confirm' };

    const changed = await this.settings.resetGroup(group, me.id);
    if (changed.length) this.announce(client, me.id, changed);
    return { ok: true, group, changed, values: this.settings.public() };
  }

  /**
   * Сменить пароль инсталляции.
   *
   * Своё событие, а не поле в `admin-set`: общая запись секретам отказывает
   * (`secret-path`), и правильно делает — там значение легло бы в jsonb как
   * есть. Здесь оно уходит в scrypt, а всё выданное под прежним паролем
   * перестаёт пускать в тот же миг: пропуска и гостевые ссылки подписаны
   * материалом, которого больше нет, сессии личностей отзывает сам сервис.
   *
   * Подтверждение спрашивается всегда, и не «потому что страшно»: параметр
   * помечен в каталоге `danger`, и спрашиваем мы ровно по этой пометке.
   *
   * Живые сокеты рвём ВСЕ, включая гостей по ссылке, — тем же кодом, что и
   * отзыв сессий, и по той же причине: пропуск проверяется один раз, при
   * подключении. Гость здесь не исключение, в отличие от отзыва сессий: его
   * ссылка подписана тем же паролем и уже недействительна.
   */
  async password(client: AppSocket, payload: AdminPasswordPayload): Promise<AdminPasswordResult> {
    const me = this.me(client);
    if (!me) return { ok: false, error: 'forbidden' };
    if (settingSpec(PASSWORD_KEY)?.danger && payload?.confirm !== true) {
      return { ok: false, error: 'needs-confirm' };
    }

    // Значение передаём как пришло: `str()` превратил бы число в пустую строку,
    // то есть «снять пароль» — не то, о чём просили. Пусть отказывает каталог.
    const res = await this.settings.setSitePassword(payload?.password, me.id);
    if (!res.ok) return { ok: false, error: res.error };

    const count = res.changed ? this.dropOthers(client, () => true) : 0;
    return { ok: true, set: res.set, changed: res.changed, count };
  }

  /** Страница людей: лицо (отпечаток), имя, устройства и положение. */
  async people(client: AppSocket, payload: AdminPeoplePayload): Promise<AdminPeopleResult> {
    if (!this.me(client)) return { ok: false, error: 'forbidden' };
    const query = trimmed(payload?.query, LIMIT.adminQuery);
    const cursor = str(payload?.cursor);
    const page = await this.overview.people({
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return { ok: true, ...page };
  }

  /**
   * Забаненные на всю инсталляцию. Баны отдельных серверов сюда не попадают:
   * их снимает создатель сервера своей дорогой (`moderation-bans`), а панель
   * говорит от лица инсталляции.
   */
  async bans(client: AppSocket): Promise<AdminBansResult> {
    if (!this.me(client)) return { ok: false, error: 'forbidden' };
    return { ok: true, bans: await this.roles.bans(null) };
  }

  /** Страница журнала — от свежих к старым. */
  async journal(client: AppSocket, payload: AdminAuditPayload): Promise<AdminAuditResult> {
    if (!this.me(client)) return { ok: false, error: 'forbidden' };
    const page = await this.audit.page(auditCursor(payload?.cursor));
    return { ok: true, ...page };
  }

  /**
   * Действие — то, что делают кнопкой.
   *
   * Незнакомое имя отвергаем (`unsupported`), а не пытаемся угадать: клиент,
   * который новее сервера, обязан узнать об этом словом, а не тишиной.
   */
  async action(client: AppSocket, payload: AdminActionPayload): Promise<AdminActionResult> {
    const me = this.me(client);
    if (!me) return { ok: false, error: 'forbidden' };

    const action = str(payload?.action) as AdminAction;
    if (!ACTIONS.includes(action)) return { ok: false, error: 'unsupported' };
    if (!SAFE_ACTIONS.has(action) && payload?.confirm !== true) {
      return { ok: false, error: 'needs-confirm' };
    }

    switch (action) {
      case 'owner-link':
        return this.issueOwnerLink(me);
      case 'retention-run':
        return this.runRetention(me);
      case 'files-sweep':
        return this.sweepFiles(me);
      case 'revoke-sessions':
        return this.revokeSessions(client, me);
      case 'revoke-device':
        return this.revokeDevice(me, str(payload?.target));
      case 'ban':
        return this.ban(me, str(payload?.target));
      case 'unban':
        return this.unban(me, str(payload?.target));
      case 'export':
        return { ok: true, action, settings: this.exportSettings() };
      case 'import':
        return this.importSettings(client, me, payload?.values);
    }
  }

  // ── Действия ──────────────────────────────────────────────────────────────

  /**
   * Перевыпустить ссылку владельца.
   *
   * Ключ уезжает В ЭТОМ ОТВЕТЕ И БОЛЬШЕ НИГДЕ: в базе лежит только его хэш, и
   * второй раз тот же ключ не покажет ни одно событие — ни `admin-state`, ни
   * журнал (там записан лишь факт выпуска). Спросивший ссылку второй раз
   * получит ДРУГУЮ, а прежняя умрёт в тот же миг: живой ключ на инсталляции
   * ровно один, иначе «перевыпустил, потому что старый мог утечь» не значило бы
   * ничего.
   */
  private async issueOwnerLink(me: Speaker): Promise<AdminActionResult> {
    const { token, expiresAt } = await this.owners.issue(me.id);
    return { ok: true, action: 'owner-link', link: { token, expiresAt: expiresAt.getTime() } };
  }

  /** Прогнать ретенцию сейчас — тем же проходом, что ходит по таймеру. */
  private async runRetention(me: Speaker): Promise<AdminActionResult> {
    const count = await this.retention.sweep();
    await this.audit.write({ actor: me.id, action: 'retention-run', detail: { removed: count } });
    return { ok: true, action: 'retention-run', count };
  }

  /** Подмести осиротевшие вложения — тем же проходом, что ходит по таймеру. */
  private async sweepFiles(me: Speaker): Promise<AdminActionResult> {
    const count = await this.uploads.sweep();
    await this.audit.write({ actor: me.id, action: 'files-swept', detail: { removed: count } });
    return { ok: true, action: 'files-sweep', count };
  }

  /**
   * Отозвать все выданные сессии.
   *
   * Сессия — подписанная кука, сервер её нигде не хранит (см. `session.ts`),
   * поэтому отзыв всех сразу — это смена ключа подписи. Она задевает и того,
   * кто нажал: своя кука умирает вместе с чужими, и это честно — «все» значит
   * все. Человеку это ничего не стоит: личность — ключ, и клиент проходит
   * челлендж заново, ни о чём не спрашивая.
   *
   * Живые сокеты рвём отдельно: личность узнаётся один раз, при подключении, —
   * без этого отозванная сессия говорила бы в каналы до перезагрузки страницы,
   * то есть часами. Свой сокет остаётся единственным исключением: оборвав его,
   * мы не доставили бы ответ тому, кто нажал, и панель осталась бы гадать,
   * случилось ли что-нибудь.
   */
  private async revokeSessions(client: AppSocket, me: Speaker): Promise<AdminActionResult> {
    revokeAllSessions();
    // Гость по ссылке сессии не предъявлял — за него ручается токен
    // приглашения, и отзыв сессий его не касается.
    const count = this.dropOthers(client, (sock) => !!this.perimeter.speaker(sock));
    await this.audit.write({
      actor: me.id,
      action: 'sessions-revoked',
      detail: { sockets: count },
    });
    return { ok: true, action: 'revoke-sessions', count };
  }

  /**
   * Отозвать чужое устройство. Строка остаётся на месте — отзыв это факт, и в
   * списке он должен быть виден.
   *
   * То, с которого смотрит сам владелец, не отзывается: ключ этого устройства —
   * единственный способ вернуться, и панель, позволившая нажать здесь, отняла
   * бы у инсталляции хозяина одним движением. Отказ тот же `forbidden`, что и
   * у бана самого себя, — и по той же причине.
   */
  private async revokeDevice(me: Speaker, deviceId: string): Promise<AdminActionResult> {
    if (!deviceId) return { ok: false, error: 'not-found' };
    // Устройство сессии, а не то, что назвал клиент в handshake
    // (`perimeter.deviceOf`): второе клиент выдумывает сам, и запретом по нему
    // владелец отзывал бы своё, назвавшись чужим.
    if (deviceId === me.deviceId) return { ok: false, error: 'forbidden' };
    const target = await this.identities.revokeAny(deviceId);
    if (!target) return { ok: false, error: 'not-found' };
    const count = this.dropDevice(deviceId);
    await this.audit.write({
      actor: me.id,
      action: 'device-revoked',
      // Целью служит отпечаток личности, а не id устройства: строку журнала
      // читают глазами через год, и «отозвано у 9f2c…» не говорит ничего.
      target: target.fingerprint,
      detail: { nick: target.nick, device: target.name, sockets: count },
    });
    return { ok: true, action: 'revoke-device', count };
  }

  /**
   * Забанить на всю инсталляцию по отпечатку.
   *
   * Отпечаток, а не сообщение: в панели человека называют лицом из таблицы, и
   * искать его последнюю реплику ради бана было бы издевательством. Владельца
   * забанить нельзя — ни другого (его нет, он один), ни себя: отказывает сам
   * `RolesService`, потому что строка бана на инсталляцию и строка владельца —
   * это одна и та же пара ключей в таблице.
   */
  private async ban(me: Speaker, fingerprint: string): Promise<AdminActionResult> {
    const identityId = await this.roles.byFingerprint(fingerprint);
    if (!identityId) return { ok: false, error: 'not-found' };
    const done = await this.roles.ban(identityId, null, me.id);
    if (!done.ok) {
      return { ok: false, error: done.reason === 'unknown' ? 'not-found' : 'forbidden' };
    }
    // Бан обязан подействовать под живым сокетом, а не со следующего входа:
    // иначе он длится ровно столько, сколько человек не перезагружает страницу.
    this.moderation.applyBan(identityId, null);
    return { ok: true, action: 'ban' };
  }

  /** Снять бан на инсталляцию. `not-found` — такого бана и не было. */
  private async unban(me: Speaker, fingerprint: string): Promise<AdminActionResult> {
    const identityId = await this.roles.byFingerprint(fingerprint);
    if (!identityId) return { ok: false, error: 'not-found' };
    if (!(await this.roles.unban(identityId, null, me.id))) {
      return { ok: false, error: 'not-found' };
    }
    this.moderation.liftBan(identityId, null);
    return { ok: true, action: 'unban' };
  }

  /**
   * Выгрузка настроек.
   *
   * Секретов в ней нет вовсе — ни значением, ни признаком «задано»: файл ездит
   * по почте и лежит в чужих каталогах, и сообщать ему, заперта ли дверь,
   * незачем.
   *
   * Инфраструктурного (`readOnly`) тоже нет, и это не забывчивость: оно живёт в
   * `.env` именно этой машины, обратно его не принял бы и сам каталог
   * (`read-only`), — а строка в файле обещала бы переносимость, которой нет.
   */
  private exportSettings(): AdminExport {
    const all = this.settings.public();
    const values: SettingsSnapshot = {};
    for (const spec of SETTINGS) {
      if (spec.secret || spec.readOnly) continue;
      values[spec.key] = all[spec.key];
    }
    return { protocol: PROTOCOL_VERSION, at: Date.now(), values };
  }

  /**
   * Загрузка настроек из выгрузки.
   *
   * Годное применяется, отвергнутое ПЕРЕЧИСЛЯЕТСЯ с причиной: молча проглотить
   * половину файла — худший исход из возможных, потому что человек уходит в
   * уверенности, что инсталляция настроена так, как в файле. Причины те же, что
   * у одиночной записи, и берутся из каталога.
   *
   * Опасные ключи из файла применяются вместе со всеми: подтверждение уже дано
   * на само действие, а спрашивать его по второму разу за каждую строку значило
   * бы сделать импорт неприменимым.
   *
   * В отчёт попадает то, что ДЕЙСТВИТЕЛЬНО поменялось: «применено 40» на файле,
   * равном текущим настройкам, рассказало бы о работе, которой не было.
   */
  private async importSettings(
    client: AppSocket,
    me: Speaker,
    raw: unknown,
  ): Promise<AdminActionResult> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'wrong-type' };
    }
    const applied: string[] = [];
    const rejected: AdminImportRejection[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const res = await this.settings.set(key, value, me.id);
      if (!res.ok) {
        rejected.push({ key, reason: res.error });
        continue;
      }
      if (res.changed) applied.push(key);
    }
    // Запись одна на весь импорт — как у сброса группы: человек нажал один раз.
    // Отвергнутое живёт только здесь: по строкам `setting-changed` его не
    // восстановить, потому что их у отвергнутого ключа и нет.
    await this.audit.write({
      actor: me.id,
      action: 'settings-imported',
      detail: { applied: applied.length, rejected },
    });
    if (applied.length) this.announce(client, me.id, applied);
    return { ok: true, action: 'import', imported: { applied, rejected } };
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  /**
   * Сказать другим сессиям владельца, что параметр поменялся.
   *
   * Общий снимок настроек всем вкладкам рассылает гейтвей подпиской на
   * `onChange`, и второй такой рассылки здесь нет. Это событие про другое: в
   * общий снимок попадает только помеченное `client` (браузеру не раздают
   * список стоп-слов и пороги блокировки), а панели на втором устройстве нужно
   * ровно то, что она показывает, — иначе она сохранит поверх свежей правки то,
   * что видела минуту назад.
   *
   * Своему сокету не шлём: он уже получил ответ на своё же событие.
   */
  private announce(from: AppSocket, identityId: string, keys: string[]): void {
    const all = this.settings.public();
    const values: SettingsSnapshot = {};
    for (const key of keys) if (key in all) values[key] = all[key];
    for (const sock of this.perimeter.socketsOf(identityId)) {
      if (sock.id === from.id) continue;
      sock.emit('admin-changed', { keys, values });
    }
  }

  /**
   * Оборвать чужие живые сокеты — тех из них, кого выбрали.
   *
   * Личность и пропуск узнаются один раз, при подключении, поэтому отозванное
   * говорило бы в каналы до перезагрузки страницы, то есть часами. Сокет
   * нажавшего не рвём никогда: оборвав его, мы не доставили бы ему же ответ, и
   * панель осталась бы гадать, случилось ли что-нибудь.
   */
  private dropOthers(client: AppSocket, pick: (sock: AppSocket) => boolean): number {
    let count = 0;
    for (const sock of [...(this.serverOf()?.sockets.sockets.values() ?? [])]) {
      if (sock.id === client.id || !pick(sock)) continue;
      sock.disconnect(true);
      count += 1;
    }
    return count;
  }

  /**
   * Сколько людей на связи. Считается по живым сокетам — единственному месту,
   * где это вообще известно; база о подключениях не знает.
   *
   * Личность, а не сокет: человек с телефоном и ноутбуком — один человек, и
   * сводка, показывающая двоих, врала бы ровно в том месте, где на неё смотрят.
   */
  private online(): number {
    const seen = new Set<string>();
    for (const sock of this.serverOf()?.sockets.sockets.values() ?? []) {
      const id = this.perimeter.speaker(sock)?.id;
      if (id) seen.add(id);
    }
    return seen.size;
  }
}

/**
 * Курсор журнала из тела запроса. Негодный не превращаем в «первую страницу»:
 * `AuditService` отвечает на него пустотой, и это правильно — панель, сбившись,
 * иначе листала бы по кругу одно и то же начало журнала.
 */
function auditCursor(raw: unknown): AuditCursor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { at, id } = raw as { at?: unknown; id?: unknown };
  if (at === undefined && id === undefined) return undefined;
  return { at: typeof at === 'number' ? at : NaN, id: str(id) };
}

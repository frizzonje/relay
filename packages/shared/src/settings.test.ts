import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  CHAT_PAGE_SIZE,
  DM_PREVIEW_LIMIT,
  GUEST_TOKEN_TTL_MS,
  LIMITS,
  MAX_UPLOAD_BYTES,
  NICK_MAX,
  PIN_LIMIT,
  TOKEN_TTL_MS,
} from './index';
import {
  SETTINGS,
  SETTING_GROUPS,
  addressBlocked,
  defaults,
  normalizeAddressPrefix,
  settingSpec,
  validateSetting,
  type SettingGroup,
} from './settings';

describe('каталог', () => {
  it('без повторов ключей', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('у каждого параметра ключ вида «группа.имя», и группа совпадает', () => {
    for (const spec of SETTINGS) {
      expect(spec.key).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(spec.key.split('.')[0]).toBe(spec.group);
    }
  });

  it('у чисел заданы границы, у выбора — варианты', () => {
    for (const spec of SETTINGS) {
      if (spec.kind === 'number' || spec.kind === 'bytes') {
        expect(typeof spec.min).toBe('number');
        expect(typeof spec.max).toBe('number');
        expect(spec.min).toBeLessThan(spec.max as number);
      }
      if (spec.kind === 'select') expect(spec.options?.length).toBeGreaterThan(1);
    }
  });

  it('умолчание каждого параметра проходит собственную проверку', () => {
    for (const spec of SETTINGS) {
      if (spec.readOnly) continue;
      expect(validateSetting(spec.key, spec.fallback).ok).toBe(true);
    }
  });

  it('в каждой группе есть хотя бы один параметр', () => {
    for (const group of SETTING_GROUPS) {
      expect(SETTINGS.some((s) => s.group === group)).toBe(true);
    }
  });

  it('умолчания собираются одним снимком', () => {
    expect(defaults()['messages.retentionDays']).toBe(14);
    expect(defaults()['direct.enabled']).toBe(true);
  });
});

describe('проверка значения', () => {
  it('пропускает годное', () => {
    expect(validateSetting('messages.retentionDays', 30)).toEqual({ ok: true, value: 30 });
    expect(validateSetting('direct.enabled', false)).toEqual({ ok: true, value: false });
  });

  it('отвергает чужой тип', () => {
    expect(validateSetting('direct.enabled', 'да')).toEqual({ ok: false, error: 'wrong-type' });
    expect(validateSetting('messages.retentionDays', '30')).toEqual({
      ok: false,
      error: 'wrong-type',
    });
  });

  it('отвергает выход за границы', () => {
    expect(validateSetting('messages.retentionDays', 0)).toEqual({
      ok: false,
      error: 'out-of-range',
    });
    expect(validateSetting('messages.retentionDays', 99999)).toEqual({
      ok: false,
      error: 'out-of-range',
    });
  });

  it('отвергает дробное там, где ждут целое', () => {
    expect(validateSetting('messages.retentionDays', 1.5)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
  });

  it('отвергает вариант не из списка', () => {
    expect(validateSetting('messages.retentionMode', 'иногда')).toEqual({
      ok: false,
      error: 'not-an-option',
    });
  });

  it('не даёт править то, что живёт в окружении', () => {
    expect(validateSetting('voice.turnUrls', 'turn:x')).toEqual({ ok: false, error: 'read-only' });
  });

  it('не знает выдуманных ключей', () => {
    expect(validateSetting('secret.backdoor', true)).toEqual({ ok: false, error: 'unknown-key' });
  });

  it('режет длинный текст по границе, а не молча', () => {
    expect(validateSetting('appearance.installName', 'я'.repeat(200))).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('список принимает только строки и только из вариантов, если они заданы', () => {
    expect(validateSetting('files.allowedKinds', ['image', 'audio'])).toEqual({
      ok: true,
      value: ['image', 'audio'],
    });
    expect(validateSetting('files.allowedKinds', ['exe'])).toEqual({
      ok: false,
      error: 'not-an-option',
    });
    expect(validateSetting('files.allowedKinds', [1])).toEqual({ ok: false, error: 'wrong-type' });
  });

  it('знает все 103 параметра каталога', () => {
    expect(SETTINGS.length).toBe(103);
    expect(settingSpec('maintenance.mode')?.danger).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Дальше — проверки сверх плана. Каталог обещает три вещи, каждая из которых
// без падающего теста ломается молча: счёт по группам, разметку секретов и
// опасного, и главное — что умолчание равно сегодняшнему поведению.
// ─────────────────────────────────────────────────────────────────────────

describe('состав групп', () => {
  // Числа — из плана (раздел «Каталог параметров»). Тест ловит не опечатку в
  // сумме, а потерянную или удвоенную строку: `SETTINGS.length === 103` сходится
  // и тогда, когда один параметр забыт, а другой написан дважды.
  const expected: Record<SettingGroup, number> = {
    access: 11,
    people: 6,
    moderation: 12,
    messages: 10,
    files: 9,
    direct: 8,
    spaces: 8,
    voice: 12,
    calls: 7,
    invites: 6,
    appearance: 7,
    notifications: 4,
    maintenance: 3,
  };

  it('в каждой группе ровно столько параметров, сколько обещано', () => {
    for (const group of SETTING_GROUPS) {
      expect(SETTINGS.filter((s) => s.group === group)).toHaveLength(expected[group]);
    }
  });

  it('групп тринадцать и других групп в каталоге нет', () => {
    expect(SETTING_GROUPS).toHaveLength(13);
    expect(new Set(SETTINGS.map((s) => s.group)).size).toBe(SETTING_GROUPS.length);
  });
});

describe('разметка каталога', () => {
  it('секреты помечены секретами', () => {
    const secrets = SETTINGS.filter((s) => s.secret).map((s) => s.key);
    expect(secrets.sort()).toEqual([
      'access.sitePasswordSet',
      'voice.sfuSecretSet',
      'voice.turnSecretSet',
    ]);
    // Секрет — это вид значения, а не только флажок: перепутав одно с другим,
    // экран показал бы пароль как обычный текст.
    for (const spec of SETTINGS) expect(spec.secret ?? false).toBe(spec.kind === 'secret');
  });

  it('только чтение — у инфраструктуры, и оно совпадает с применением «env»', () => {
    const readOnly = SETTINGS.filter((s) => s.readOnly).map((s) => s.key);
    expect(readOnly.sort()).toEqual([
      'voice.sfuSecretSet',
      'voice.sfuUrl',
      'voice.turnSecretSet',
      'voice.turnUrls',
    ]);
    for (const spec of SETTINGS) expect(spec.applies === 'env').toBe(spec.readOnly === true);
    // И у каждого — имя переменной, из которой значение приходит. Поле «только
    // чтение» без источника — пустая строка, которую нечем заполнить: панель
    // покажет её навсегда серой, а человек будет искать, где же она задаётся.
    // Так в каталог и попал `notifications.pushGateway` — шлюз, которого в
    // relay нет; вернётся он вместе с кодом, который его читает.
    for (const spec of SETTINGS) if (spec.readOnly) expect(typeof spec.env).toBe('string');
  });

  it('опасное просит подтверждения', () => {
    const danger = SETTINGS.filter((s) => s.danger).map((s) => s.key);
    expect(danger.sort()).toEqual([
      'access.sitePasswordSet',
      'maintenance.mode',
      'messages.retentionMode',
      'moderation.readOnlyMode',
    ]);
  });

  it('начальное значение берётся из названных переменных окружения', () => {
    const env = Object.fromEntries(SETTINGS.filter((s) => s.env).map((s) => [s.key, s.env]));
    expect(env).toEqual({
      'access.sitePasswordSet': 'SITE_PASSWORD',
      // RETENTION_DAYS задаёт и режим, и число дней сразу — иначе установка с
      // RETENTION_DAYS=30 засеяла бы режим «дни» и 14 дней из умолчания.
      'messages.retentionMode': 'RETENTION_DAYS',
      'messages.retentionDays': 'RETENTION_DAYS',
      'files.installQuotaBytes': 'UPLOAD_MAX_TOTAL_BYTES',
      'voice.turnUrls': 'TURN_URLS',
      'voice.turnSecretSet': 'TURN_SECRET',
      'voice.sfuUrl': 'SFU_URL',
      'voice.sfuSecretSet': 'SFU_SECRET',
    });
  });

  it('у всякого текста и списка есть потолок — иначе «too-long» недостижим', () => {
    for (const spec of SETTINGS) {
      if (['text', 'multiline', 'secret', 'list'].includes(spec.kind)) {
        expect(typeof spec.max).toBe('number');
        expect(spec.max as number).toBeGreaterThan(0);
      }
    }
  });

  it('применение размечено у всех и только известными значениями', () => {
    for (const spec of SETTINGS) {
      expect(['now', 'new', 'restart', 'env']).toContain(spec.applies);
    }
  });
});

describe('умолчание равно сегодняшнему поведению', () => {
  // Каждое число здесь — не константа плана, а константа работающего кода.
  // Установка, где панель не открывали ни разу, обязана вести себя как прежде;
  // разъедься эти пары — и она поведёт себя иначе в день обновления.
  it('повторяет действующие константы контракта', () => {
    const d = defaults();
    expect(d['people.nickMaxLength']).toBe(NICK_MAX);
    expect(d['messages.maxLength']).toBe(LIMITS.chatText);
    expect(d['messages.pageSize']).toBe(CHAT_PAGE_SIZE);
    expect(d['messages.pinLimit']).toBe(PIN_LIMIT);
    expect(d['messages.replyPreviewLength']).toBe(DM_PREVIEW_LIMIT);
    expect(d['files.maxUploadBytes']).toBe(MAX_UPLOAD_BYTES);
    expect(d['access.sessionTtlDays']).toBe(TOKEN_TTL_MS / 86_400_000);
    expect(d['invites.ttlHours']).toBe(GUEST_TOKEN_TTL_MS / 3_600_000);
    expect(d['appearance.installName']).toBe(APP_NAME);
  });

  it('ничего не запрещает и не включает того, чего не было', () => {
    const d = defaults();
    // Хранение: 14 дней и режим «дни» — ровно то, что делает retention.service
    // без RETENTION_DAYS в окружении.
    expect(d['messages.retentionMode']).toBe('days');
    expect(d['messages.retentionDays']).toBe(14);
    // Обслуживание и «только чтение» выключены: включённые, они закрыли бы
    // установку сразу после обновления.
    expect(d['maintenance.mode']).toBe(false);
    expect(d['moderation.readOnlyMode']).toBe(false);
    // Тема сегодня тёмная и никакой другой в вебе нет.
    expect(d['appearance.defaultTheme']).toBe('dark');
    expect(d['appearance.defaultLocale']).toBe('en');
    // Всё, что сегодня работает, работает и с пустой таблицей настроек.
    for (const key of [
      'files.uploadsEnabled',
      'messages.searchEnabled',
      'messages.reactionsEnabled',
      'direct.enabled',
      'invites.enabled',
      'voice.videoEnabled',
      'voice.screenShareEnabled',
    ]) {
      expect(d[key]).toBe(true);
    }
    // Квоты не заведены: ноль — это «без квоты», а не «ничего нельзя».
    expect(d['files.perIdentityDailyBytes']).toBe(0);
    expect(d['moderation.editWindowMinutes']).toBe(0);
    expect(d['moderation.bannedWords']).toEqual([]);
    // Пределов на голос и на гостей сегодня нет ни одного: в канал пускают
    // всех, кто до него дошёл, а сколько человек придёт по ссылке — не считает
    // никто. Число вместо нуля запретило бы в день обновления то, что вчера
    // было можно.
    expect(d['spaces.maxVoiceOccupants']).toBe(0);
    expect(d['invites.maxGuestsPerChannel']).toBe(0);
    // А вот у каталога загрузок потолок ЕСТЬ и сегодня: 2 ГиБ, за которыми
    // вытесняются самые старые вложения (DEFAULT_MAX_TOTAL_BYTES в
    // apps/api/src/uploads.policy.ts). Ноль здесь означал бы «без квоты» —
    // то есть поведение, которого до панели не было.
    expect(d['files.installQuotaBytes']).toBe(2 * 1024 ** 3);
    // Сутки сироты — ORPHAN_TTL_MS, каким он был константой.
    expect(d['files.orphanSweepHours']).toBe(24);
    // Исполняемое сегодня проходит наравне с pdf: вид у него `file`, и другой
    // проверки на пути нет. Включённая по умолчанию, эта запретила бы то, что
    // вчера носили.
    expect(d['files.blockExecutables']).toBe(false);
    // Спойлер и общий срок хранения переписки — тоже как вчера.
    expect(d['files.spoilerAllowed']).toBe(true);
    expect(d['direct.retentionMode']).toBe('inherit');
  });

  it('размер загрузки задан байтами, а не «на глаз»', () => {
    const spec = settingSpec('files.maxUploadBytes');
    expect(spec?.kind).toBe('bytes');
    expect(spec?.min).toBe(1024);
    // Потолок равен умолчанию: настройкой предел только ужимают. Выше 25 МиБ
    // тело обрывает multer, а до него отказывает браузер — поле, которое вверх
    // не двигается, не должно предлагать гигабайт.
    expect(spec?.max).toBe(25 * 1024 ** 2);
    expect(spec?.fallback).toBe(25 * 1024 ** 2);
  });

  it('виды вложений — те же, что различает сервер', () => {
    // Каталог не выдумывает вид, которого нет: `detectKind` в uploads.ts знает
    // картинку, mp3 и «прочее», а ролик приезжает как `file`. Строка «video»
    // здесь была бы галочкой, которая не выключает ничего.
    const spec = settingSpec('files.allowedKinds');
    expect(spec?.options).toEqual(['image', 'audio', 'file']);
    expect(defaults()['files.allowedKinds']).toEqual(['image', 'audio', 'file']);
    expect(validateSetting('files.allowedKinds', ['video'])).toEqual({
      ok: false,
      error: 'not-an-option',
    });
  });

  it('текст про приватность бесед — тот же, что показывает веб', () => {
    // Ключ `dm.privacy` из apps/web/lib/i18n/messages/en.json, этап A.
    expect(defaults()['direct.privacyNotice']).toBe(
      "Direct messages are addressed to one person, but they aren't hidden from the installation's owner.",
    );
  });
});

describe('снимок умолчаний', () => {
  it('содержит все ключи каталога и ничего сверх', () => {
    expect(Object.keys(defaults()).sort()).toEqual(SETTINGS.map((s) => s.key).sort());
  });

  it('отдаёт копию: правка снимка не портит каталог', () => {
    const snapshot = defaults();
    (snapshot['files.allowedKinds'] as string[]).push('exe');
    expect(defaults()['files.allowedKinds']).not.toContain('exe');
  });
});

describe('проверка значения — прочие виды', () => {
  it('знает каждый вид, какой есть в каталоге', () => {
    expect(validateSetting('files.maxUploadBytes', 1024 ** 2)).toEqual({
      ok: true,
      value: 1024 ** 2,
    });
    expect(validateSetting('files.maxUploadBytes', 512)).toEqual({
      ok: false,
      error: 'out-of-range',
    });
    expect(validateSetting('maintenance.message', 'вернёмся через час')).toEqual({
      ok: true,
      value: 'вернёмся через час',
    });
    expect(validateSetting('maintenance.message', 'я'.repeat(2001))).toEqual({
      ok: false,
      error: 'too-long',
    });
    expect(validateSetting('access.sitePasswordSet', 'новый-пароль')).toEqual({
      ok: true,
      value: 'новый-пароль',
    });
    expect(validateSetting('access.sitePasswordSet', true)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
    expect(validateSetting('moderation.bannedWords', ['ы'])).toEqual({ ok: true, value: ['ы'] });
    expect(validateSetting('spaces.creationAllowed', 'owner')).toEqual({
      ok: true,
      value: 'owner',
    });
    expect(validateSetting('spaces.creationAllowed', 7)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
  });

  it('не пропускает ни NaN, ни бесконечность', () => {
    expect(validateSetting('messages.retentionDays', Number.NaN)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
    expect(validateSetting('messages.retentionDays', Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      error: 'wrong-type',
    });
  });

  it('меряет длину символами, а не единицами utf-16', () => {
    // Восемь знаков — это восемь знаков, даже когда каждый занимает по две
    // ячейки: иначе значок установки обрезался бы на середине пары суррогатов.
    expect(validateSetting('appearance.installEmoji', '🌊'.repeat(8)).ok).toBe(true);
    expect(validateSetting('appearance.installEmoji', '🌊'.repeat(9))).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('список длиннее своего потолка не проходит', () => {
    const many = Array.from({ length: 501 }, (_, i) => `w${i}`);
    expect(validateSetting('moderation.bannedWords', many)).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('слово длиннее строки ввода не проходит', () => {
    expect(validateSetting('moderation.bannedWords', ['я'.repeat(101)])).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('читаемое из окружения не правится, даже когда значение верное', () => {
    expect(validateSetting('voice.sfuUrl', 'https://sfu.example')).toEqual({
      ok: false,
      error: 'read-only',
    });
    expect(validateSetting('voice.sfuSecretSet', 'x')).toEqual({ ok: false, error: 'read-only' });
  });

  it('спецификация ищется по ключу и не выдумывает несуществующий', () => {
    expect(settingSpec('voice.turnUrls')?.group).toBe('voice');
    expect(settingSpec('voice.нет')).toBeUndefined();
  });
});

/**
 * Каталог существует в двух экземплярах: этот и `apps/api/src/settings/catalog.ts`.
 * Так вышло не от лени — api намеренно не зависит от этого пакета (см.
 * `gateway/protocol.ts`), а собирается он в commonjs из своего `src`, куда
 * исходник на ESM попросту не доедет ни компиляцией, ни `require`.
 *
 * Цена копии — расхождение, и оно было бы худшего сорта: панель показала бы
 * границы, по которым сервер не проверяет, а владелец узнал бы об этом,
 * получив отказ на значение, которое ему только что предложили. Поэтому копия
 * сверяется не по духу, а по букве.
 */
describe('копия каталога в api', () => {
  /** Всё, начиная с первого объявления: до него у файлов своя шапка и свой импорт. */
  const body = (src: string) => {
    const at = src.indexOf('export type SettingKind');
    expect(at).toBeGreaterThan(0);
    return src.slice(at);
  };

  it('совпадает с этим файлом слово в слово', () => {
    const mine = readFileSync(fileURLToPath(new URL('./settings.ts', import.meta.url)), 'utf8');
    const theirs = readFileSync(
      fileURLToPath(new URL('../../../apps/api/src/settings/catalog.ts', import.meta.url)),
      'utf8',
    );
    expect(body(theirs)).toBe(body(mine));
  });

  it('берёт вид вложения у сервера, а не у этого пакета', () => {
    const theirs = readFileSync(
      fileURLToPath(new URL('../../../apps/api/src/settings/catalog.ts', import.meta.url)),
      'utf8',
    );
    expect(theirs).toContain("import type { AttachmentKind } from '../uploads';");
  });
});

/**
 * Список закрытых адресов: разбор, каноническая запись и совпадение.
 *
 * Проверяется здесь не «функция вернула правду», а три обещания, каждое из
 * которых ломается тихо. Первое: строка, которая адресом не является, в
 * таблицу не попадает — иначе она лежала бы там как настройка и не делала бы
 * ничего. Второе: голый IPv6 разворачивается в /64 и виден развёрнутым — бан
 * одного /128 перестал бы действовать через несколько минут (RFC 4941), ничего
 * об этом не сказав. Третье: семьи адресов не смешиваются.
 */
describe('закрытые адреса', () => {
  const check = (items: string[]) => validateSetting('access.blockedAddresses', items);

  it('принимает адрес, сеть и обе версии протокола', () => {
    expect(check(['1.2.3.4', '10.0.0.0/8', '2001:db8::/32', '::1'])).toEqual({
      ok: true,
      value: ['1.2.3.4', '10.0.0.0/8', '2001:db8::/32', '::/64'],
    });
  });

  it('строку, которая адресом не является, отвергает с отдельной причиной', () => {
    // Не `wrong-type`: тип как раз тот, строка. Панель обязана сказать, что
    // непонятен ПУНКТ, а не весь список.
    for (const bad of ['1.2.3.4/33', '10.0.0.0/-1', '2001:db8::/129', 'не адрес', '', '1.2.3.4 ']) {
      expect(check([bad]), bad).toEqual({ ok: false, error: 'bad-item' });
    }
  });

  it('голый IPv6 сохраняется своим блоком /64, и это видно на экране', () => {
    // Жильё раздаётся блоком /64, адрес внутри него меняется сам собой.
    // Разворачиваем при записи, а не при сравнении: владелец обязан увидеть,
    // во что превратилась его строка.
    expect(check(['2001:db8::1'])).toEqual({ ok: true, value: ['2001:db8::/64'] });
  });

  it('маска обнуляет то, что за ней, — сеть это сеть, а не адрес внутри неё', () => {
    expect(check(['10.1.2.3/8', '2001:db8:1:2:3::/48'])).toEqual({
      ok: true,
      value: ['10.0.0.0/8', '2001:db8:1::/48'],
    });
  });

  it('IPv4 в обёртке IPv6 — тот же самый IPv4', () => {
    // Так Node называет IPv4-клиента на двойном сокете; не разбери мы эту
    // форму, маска выглядела бы работающей и не работала.
    expect(check(['::ffff:10.0.0.0/8'])).toEqual({ ok: true, value: ['10.0.0.0/8'] });
    expect(addressBlocked(['10.0.0.0/8'], '::ffff:10.1.2.3')).toBe(true);
  });

  it('ловит адрес внутри сети и не ловит вне её', () => {
    expect(addressBlocked(['10.0.0.0/8'], '10.1.2.3')).toBe(true);
    expect(addressBlocked(['10.0.0.0/16'], '10.1.2.3')).toBe(false);
    expect(addressBlocked(['1.2.3.4'], '1.2.3.4')).toBe(true);
    expect(addressBlocked(['1.2.3.4'], '1.2.3.5')).toBe(false);
    expect(addressBlocked(['2001:db8::/32'], '2001:db8:1:2::9')).toBe(true);
    expect(addressBlocked(['2001:db8::/32'], '2001:dba::9')).toBe(false);
  });

  it('семьи не смешиваются: IPv4 не попадает под IPv6-маску', () => {
    // `::/0`, написанный ради «закрыть всё шестое», иначе закрыл бы и
    // четвёртое — то есть инсталляцию целиком.
    expect(addressBlocked(['::/0'], '10.1.2.3')).toBe(false);
    expect(addressBlocked(['0.0.0.0/0'], '2001:db8::1')).toBe(false);
    expect(addressBlocked(['0.0.0.0/0'], '10.1.2.3')).toBe(true);
  });

  it('пустой список не закрывает никого, а непонятный адрес не ловится', () => {
    expect(addressBlocked([], '10.1.2.3')).toBe(false);
    // Так socket.io называет адрес, которого не знает.
    expect(addressBlocked(['0.0.0.0/0'], 'unknown')).toBe(false);
  });

  it('каноническая запись годится обратно на вход', () => {
    // Иначе сохранённое второй раз отвергалось бы собственной проверкой.
    for (const item of ['1.2.3.4', '10.0.0.0/8', '2001:db8::/32', '::/64', '::ffff:1.2.3.4']) {
      const first = normalizeAddressPrefix(item);
      expect(first, item).not.toBeNull();
      expect(normalizeAddressPrefix(first as string)).toBe(first);
    }
  });

  it('клиенту список не уезжает', () => {
    // С кем воюет владелец — не дело чужого браузера, и уж точно не гостевого.
    expect(settingSpec('access.blockedAddresses')?.client).toBeUndefined();
  });
});

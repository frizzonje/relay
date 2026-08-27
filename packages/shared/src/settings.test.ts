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
  defaults,
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

  it('знает все 98 параметров каталога', () => {
    expect(SETTINGS.length).toBe(98);
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
  // сумме, а потерянную или удвоенную строку: `SETTINGS.length === 98` сходится
  // и тогда, когда один параметр забыт, а другой написан дважды.
  const expected: Record<SettingGroup, number> = {
    access: 12,
    people: 6,
    moderation: 12,
    messages: 10,
    files: 9,
    direct: 8,
    spaces: 8,
    voice: 12,
    invites: 6,
    appearance: 7,
    notifications: 5,
    maintenance: 3,
  };

  it('в каждой группе ровно столько параметров, сколько обещано', () => {
    for (const group of SETTING_GROUPS) {
      expect(SETTINGS.filter((s) => s.group === group)).toHaveLength(expected[group]);
    }
  });

  it('групп двенадцать и других групп в каталоге нет', () => {
    expect(SETTING_GROUPS).toHaveLength(12);
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
      'notifications.pushGateway',
      'voice.sfuSecretSet',
      'voice.sfuUrl',
      'voice.turnSecretSet',
      'voice.turnUrls',
    ]);
    for (const spec of SETTINGS) expect(spec.applies === 'env').toBe(spec.readOnly === true);
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
    expect(d['access.blockNewIdentities']).toBe(false);
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
    expect(d['files.installQuotaBytes']).toBe(0);
    expect(d['moderation.editWindowMinutes']).toBe(0);
    expect(d['moderation.bannedWords']).toEqual([]);
  });

  it('размер загрузки задан байтами, а не «на глаз»', () => {
    const spec = settingSpec('files.maxUploadBytes');
    expect(spec?.kind).toBe('bytes');
    expect(spec?.min).toBe(1024);
    expect(spec?.max).toBe(1024 ** 3);
    expect(spec?.fallback).toBe(25 * 1024 ** 2);
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
    expect(validateSetting('notifications.pushGateway', 'https://push.example')).toEqual({
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

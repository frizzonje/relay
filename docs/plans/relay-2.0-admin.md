# Этап C: админ-панель — план реализации

> **Для исполнителя:** ОБЯЗАТЕЛЬНЫЙ СУБ-НАВЫК: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans` — задача за задачей. Шаги помечены
> чекбоксами (`- [ ]`).

**Цель:** у владельца инсталляции появляется окно, из которого видно и правится всё, что
сегодня живёт в `.env` и требует ssh, плюс люди, баны, журнал и обслуживание.

**Архитектура:** три слоя, и порядок между ними жёсткий.

1. **Каталог** (`packages/shared/src/settings.ts`) — один типизированный список всех
   параметров: ключ, группа, вид, умолчание, границы, требует ли перезапуска, секрет ли.
   Каталог и есть контракт: по нему сервер валидирует запись, по нему же интерфейс **сам
   рисует контролы**. Сотня параметров, размеченных руками в JSX, — это сотня мест, где
   значение и его проверка разъедутся.
2. **Хранилище** (`settings` в Postgres + `SettingsService`) — значения, кэш в памяти,
   подписка на изменения. `.env` остаётся источником **начального** значения: при первом
   старте он засевает таблицу, дальше решает таблица. Инфраструктурное (TURN, SFU, домен,
   БД) в панели показывается, но не правится — и панель говорит об этом прямо.
3. **Панель** (`AdminDialog`) — модалка по паттерну `SettingsDialog`, левая колонка вкладок,
   плитки сводки, таблицы людей и банов, журнал, обслуживание.

**Стек:** тот же, что в этапе A.

**Спека:** [docs/plans/relay-2.0.md](relay-2.0.md) (продукт),
[reference/direct-messages/README.md](../../reference/direct-messages/README.md) (модалка
860×600, таблица личностей, две строки вкладок на мобиле), плюс решения ниже.

**Предыдущий этап:** [relay-2.0-dm.md](relay-2.0-dm.md). Группа параметров `direct` управляет
ровно тем, что он построил, поэтому C идёт после A, а не до.

## Глобальные ограничения

- Всё то же, что в [этапе A](relay-2.0-dm.md#глобальные-ограничения): Docker, настоящий
  Postgres в тестах, пороги покрытия api (90/85/90/90), контракт в двух местах, русские
  комментарии, английские коммиты, токены из `globals.css`, ключи в обеих локалях.
- **Панель — только для владельца инсталляции.** Роль `owner` уже существует
  (`identity/owner.service.ts`), второй роли не заводим. Каждый обработчик проверяет
  владение сам; «интерфейс не показал кнопку» — не проверка.
- **Ни один секрет не уходит наружу.** Пароль инсталляции, `TURN_SECRET`, `SFU_SECRET`
  показываются как «задано / не задано», а не значением. Это правило каталога
  (`secret: true`), а не дисциплина автора экрана.
- **Каждое изменение попадает в журнал.** Кто, что, с чего на что, когда. Значения секретов
  в журнал не пишутся.
- **Опасное просит подтверждение** (`danger: true` в каталоге): смена пароля инсталляции,
  режим обслуживания, сброс группы к умолчаниям, чистка файлов.
- **Умолчание каталога равно сегодняшнему поведению.** Инсталляция, где владелец не открывал
  панель ни разу, обязана вести себя ровно как до этого этапа. Это проверяется тестом, а не
  обещанием.

---

## Карта файлов

**Создаются (shared):**

| Файл | За что отвечает |
|---|---|
| `packages/shared/src/settings.ts` | каталог параметров, типы, чистая валидация |
| `packages/shared/src/settings.test.ts` | тесты каталога и валидации |
| `packages/shared/src/admin.ts` | протокол панели: события, полезная нагрузка, ответы |

**Создаются (api):**

| Файл | За что отвечает |
|---|---|
| `apps/api/src/db/migrations/1761000000000-Settings.ts` | таблицы `settings` и `audit` |
| `apps/api/src/settings/settings.service.ts` | значения, кэш, запись, засев из env, подписка |
| `apps/api/src/settings/settings.service.test.ts` | тесты того же |
| `apps/api/src/settings/audit.service.ts` | журнал: запись и чтение страницами |
| `apps/api/src/settings/audit.service.test.ts` | тесты того же |
| `apps/api/src/gateway/admin.handlers.ts` | обработчики панели |
| `apps/api/src/gateway/admin.handlers.test.ts` | тесты того же |
| `apps/api/src/settings/overview.service.ts` | сводка: люди, сообщения, диск, база, аптайм |

**Правятся (api):** `db/entities.ts`, `db/testing.ts`, `db/migrations/index.ts`,
`db/retention.service.ts`, `uploads.ts`, `upload.guard.ts`, `gateway/perimeter.ts`,
`gateway/chat.handlers.ts`, `gateway/registry.handlers.ts`, `gateway/dm.handlers.ts`,
`gateway/signaling.gateway.ts`, `gateway/gateway.testkit.ts`, `auth/auth.ts`,
`config.controller.ts`, `app.module.ts`.

**Создаются (web):** `stores/admin.ts` (+ тест), `components/admin/AdminDialog.tsx`,
`components/admin/SettingField.tsx`, `components/admin/PeopleTab.tsx`,
`components/admin/BansTab.tsx`, `components/admin/OverviewTab.tsx`,
`components/admin/AuditTab.tsx`, `components/admin/MaintenanceTab.tsx`,
`components/admin/admin-fields.test.tsx`, `e2e/tests/admin.spec.ts`.

**Правятся (web):** `components/layout/Toolbar.tsx` (цель Admin оживает),
`components/layout/AppShell.tsx`, `stores/ui.ts` (`adminOpen`),
`components/providers/SocketProvider.tsx`, `lib/i18n/messages/*.json`.

---

## Решения, принятые заранее

1. **Каталог — данные, а не код экрана.** Добавить параметр = добавить строку в
   `settings.ts`. Экран, валидация, журнал и импорт/экспорт подхватывают его сами.
2. **`.env` засевает, таблица решает.** При первом старте пустая таблица заполняется из
   переменных окружения (там, где у параметра указан `env`). Дальше `.env` не читается —
   иначе правка в панели молча откатывалась бы после рестарта. Инфраструктурные параметры
   (`readOnly: true`) читаются из env всегда и в панели только показываются.
3. **Горячее применение — по умолчанию, но честно размеченное.** У каждого параметра в
   каталоге стоит `appliesTo`: `now` (действует сразу), `new-connections` (доедет к новым
   сокетам), `restart` (нужен перезапуск). Панель пишет это рядом с полем.
4. **Пароль инсталляции переезжает в таблицу** (хэш scrypt), env остаётся резервом на случай
   пустой таблицы. Смена из панели немедленно отзывает все куки `relay_pass` — ровно как
   сегодня это делает смена `SITE_PASSWORD`.
5. **Панель ходит по socket.io, а не по REST.** Владелец уже опознан на сокете
   (`perimeter.isOwner`), живые изменения (кто-то онлайн, счётчик сообщений) сами приезжают
   тем же каналом, и второй способ аутентификации заводить незачем.
6. **Журнал — отдельная таблица, не лог.** Файловый лог уезжает в ротацию и его нет в
   интерфейсе; «кто снял бан позавчера» — это вопрос к продукту, а не к `docker logs`.
7. **Ролей по-прежнему две.** Модераторов, админов второго уровня и раздачи прав в этом
   этапе нет: это отдельная ось, и она не влезает сюда честно.

---

## Каталог параметров

Полный список того, что появляется в панели. Это содержимое `packages/shared/src/settings.ts`
и одновременно объём задачи 2. Столбец «применение»: `now` — сразу, `new` — к новым
подключениям, `restart` — после перезапуска, `env` — только чтение.

### Группа `access` — доступ

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `access.sitePasswordSet` | secret | из `SITE_PASSWORD` | now |
| `access.sitePasswordEnabled` | boolean | true | now |
| `access.identityCreation` | select `open` / `invite` / `closed` | open | new |
| `access.maxDevicesPerIdentity` | number 1…64 | 8 | now |
| `access.deviceApprovalRequired` | boolean | true | now |
| `access.sessionTtlDays` | number 1…365 | 30 | new |
| `access.unlockAttempts` | number 1…50 | 8 | now |
| `access.unlockLockoutMinutes` | number 1…1440 | 5 | now |
| `access.loginRatePerMinute` | number 1…600 | 20 | now |
| `access.newIdentityQuietMinutes` | number 0…1440 | 0 | now |
| `access.guestsEnabled` | boolean | true | now |
| `access.blockNewIdentities` | boolean | false | new |

### Группа `people` — люди

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `people.nickMinLength` | number 1…32 | 1 | now |
| `people.nickMaxLength` | number 1…64 | 20 | now |
| `people.nickChangeCooldownMinutes` | number 0…1440 | 0 | now |
| `people.showFingerprints` | boolean | true | now |
| `people.lastSeenVisible` | boolean | true | now |
| `people.pruneInactiveDays` | number 0…3650 (0 — не чистить) | 0 | now |

### Группа `moderation` — модерация

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `moderation.messageRatePerMinute` | number 1…1200 | 1200 | now |
| `moderation.messageBurst` | number 1…40 | 40 | now |
| `moderation.allowEdit` | boolean | true | now |
| `moderation.editWindowMinutes` | number 0…10080 (0 — без предела) | 0 | now |
| `moderation.allowDelete` | boolean | true | now |
| `moderation.bannedWords` | list | пусто | now |
| `moderation.bannedWordsAction` | select `block` / `flag` | block | now |
| `moderation.linksAllowed` | boolean | true | now |
| `moderation.maxMentionsPerMessage` | number 0…50 | 8 | now |
| `moderation.readOnlyMode` | boolean (danger) | false | now |
| `moderation.serverOwnersCanBan` | boolean | true | now |
| `moderation.banNotice` | multiline | пусто | now |

### Группа `messages` — сообщения и хранение

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `messages.retentionMode` | select `days` / `forever` / `ephemeral` (danger) | из `RETENTION_DAYS`, иначе `days` | now |
| `messages.retentionDays` | number 1…3650 | 14 | now |
| `messages.maxLength` | number 1…8000 | 500 | now |
| `messages.pageSize` | number 10…200 | 50 | new |
| `messages.pinLimit` | number 0…500 | 50 | now |
| `messages.searchEnabled` | boolean | true | now |
| `messages.reactionsEnabled` | boolean | true | now |
| `messages.typingIndicator` | boolean | true | now |
| `messages.systemMessages` | boolean | true | now |
| `messages.replyPreviewLength` | number 20…500 | 120 | now |

### Группа `files` — файлы

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `files.uploadsEnabled` | boolean | true | now |
| `files.maxUploadBytes` | bytes 1 KiB…1 GiB | 25 MiB | now |
| `files.allowedKinds` | list из `image`/`audio`/`file` | все три | now |
| `files.imagePreviews` | boolean | true | now |
| `files.perIdentityDailyBytes` | bytes (0 — без квоты) | 0 | now |
| `files.installQuotaBytes` | bytes (0 — без квоты) | 0 | now |
| `files.orphanSweepHours` | number 1…720 | 24 | now |
| `files.blockExecutables` | boolean | true | now |
| `files.spoilerAllowed` | boolean | true | now |

### Группа `direct` — личные сообщения

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `direct.enabled` | boolean | true | now |
| `direct.whoCanStart` | select `everyone` / `seen-together` / `nobody` | everyone | now |
| `direct.firstMessagesPerHour` | number 0…100 | 0 (без предела) | now |
| `direct.attachmentsAllowed` | boolean | true | now |
| `direct.retentionMode` | select `inherit` / `days` / `forever` / `ephemeral` | inherit | now |
| `direct.retentionDays` | number 1…3650 | 14 | now |
| `direct.privacyNotice` | multiline | текст из этапа A | now |
| `direct.blockFromBanned` | boolean | true | now |

### Группа `spaces` — серверы и каналы

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `spaces.creationAllowed` | select `everyone` / `owner` | everyone | now |
| `spaces.maxServersPerIdentity` | number 0…100 | 5 | now |
| `spaces.maxServersInstall` | number 1…1000 | 50 | now |
| `spaces.maxChannelsPerServer` | number 1…500 | 25 | now |
| `spaces.lockedServersAllowed` | boolean | true | now |
| `spaces.defaultVoiceMode` | select `p2p` / `sfu` | p2p | new |
| `spaces.maxVoiceOccupants` | number 2…100 | 20 | now |
| `spaces.channelNameMaxLength` | number 1…64 | 32 | now |

### Группа `voice` — голос и медиа

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `voice.videoEnabled` | boolean | true | now |
| `voice.screenShareEnabled` | boolean | true | now |
| `voice.audioBitrateKbps` | number 8…256 | 128 | new |
| `voice.videoBitrateKbps` | number 100…8000 | 2500 | new |
| `voice.sfuThreshold` | number 2…50 | 4 | new |
| `voice.noiseSuppressionDefault` | boolean | true | new |
| `voice.pushToTalkDefault` | boolean | false | new |
| `voice.iceRestartSeconds` | number 2…60 | 8 | new |
| `voice.turnUrls` | text (только чтение, `TURN_URLS`) | — | env |
| `voice.turnSecretSet` | secret (только чтение, `TURN_SECRET`) | — | env |
| `voice.sfuUrl` | text (только чтение, `SFU_URL`) | — | env |
| `voice.sfuSecretSet` | secret (только чтение, `SFU_SECRET`) | — | env |

### Группа `invites` — приглашения и гости

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `invites.enabled` | boolean | true | now |
| `invites.ttlHours` | number 1…720 | 24 | now |
| `invites.whoCanInvite` | select `everyone` / `owner` | everyone | now |
| `invites.maxGuestsPerChannel` | number 1…100 | 10 | now |
| `invites.listenerByDefault` | boolean | false | now |
| `invites.guestKickCooldownMinutes` | number 1…1440 | 60 | now |

### Группа `appearance` — вид инсталляции

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `appearance.installName` | text ≤48 | `relay` | now |
| `appearance.installEmoji` | text ≤8 | пусто | now |
| `appearance.defaultTheme` | select `system` / `dark` / `light` | dark | new |
| `appearance.defaultLocale` | select `en` / `ru` | en | new |
| `appearance.loginNotice` | multiline ≤2000 | пусто | now |
| `appearance.rulesText` | multiline ≤8000 | пусто | now |
| `appearance.showVersion` | boolean | true | now |

### Группа `notifications` — уведомления

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `notifications.soundEnabled` | boolean | true | now |
| `notifications.desktopEnabled` | boolean | true | now |
| `notifications.mentionSound` | boolean | true | now |
| `notifications.directSound` | boolean | true | now |

### Группа `maintenance` — обслуживание

| Ключ | Вид | Умолчание | Применение |
|---|---|---|---|
| `maintenance.mode` | boolean (danger) | false | now |
| `maintenance.message` | multiline ≤2000 | пусто | now |
| `maintenance.bannerText` | multiline ≤500 | пусто | now |

**Действия** (не параметры — кнопки на вкладке «Обслуживание»): перевыпустить ссылку
владельца, прогнать ретенцию сейчас, подмести осиротевшие файлы, отозвать все сессии,
выгрузить настройки в JSON, загрузить настройки из JSON, сбросить группу к умолчаниям.

**Итого: 97 параметров в 12 группах + 7 действий + 4 таблицы** (люди, баны, журнал, сводка).

Проверка счётом (её же делает тест `SETTINGS.length === 97`): access 12, people 6,
moderation 12, messages 10, files 9, direct 8, spaces 8, voice 12, invites 6, appearance 7,
notifications 4, maintenance 3.

Этап B добавит тринадцатую группу `calls` (7 параметров) — тогда же в тесте станет 105.

---

### Задача 1: Схема — настройки и журнал

**Файлы:**

- Создать: `apps/api/src/db/migrations/1761000000000-Settings.ts`
- Изменить: `apps/api/src/db/entities.ts` (`SettingRow`, `AuditRow`, `ENTITIES`)
- Изменить: `apps/api/src/db/migrations/index.ts`, `apps/api/src/db/testing.ts`
- Тест: `apps/api/src/db/schema.test.ts` (существующий)

**Интерфейсы:**

- Отдаёт дальше: `settings (key text pk, value jsonb, updated_at timestamptz, updated_by uuid)`,
  `audit (id uuid pk, at timestamptz, actor uuid, actor_nick text, action text, target text,
  detail jsonb)` + индексы `audit_at_idx`, `audit_actor_idx`.

- [ ] **Шаг 1: Миграция**

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Настройки инсталляции и журнал того, кто их менял.
 *
 * До этого настройка инсталляции была строкой в `.env`, то есть правом того, у
 * кого есть ssh. Это честная модель ровно до первой инсталляции, которую
 * поставили одному человеку, а распоряжается ей другой. Таблица переносит
 * решение туда же, где живёт власть, — к владельцу, опознанному ключом.
 *
 * Значение — jsonb, а не text: у параметра есть тип (число, флаг, список), и
 * хранить его строкой значило бы разбирать её на каждом чтении и спорить о том,
 * что такое «true».
 *
 * Журнал — таблица, а не лог. Файловый лог уезжает в ротацию, его нет в
 * интерфейсе и по нему нельзя ответить на вопрос «кто снял бан позавчера», а
 * это вопрос к продукту, а не к `docker logs`.
 */
export class Settings1761000000000 implements MigrationInterface {
  name = 'Settings1761000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "settings" (
        "key" text NOT NULL,
        "value" jsonb NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" uuid,
        CONSTRAINT "PK_settings" PRIMARY KEY ("key")
      )
    `);
    await q.query(`
      CREATE TABLE "audit" (
        "id" uuid NOT NULL,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "actor" uuid,
        "actor_nick" text NOT NULL,
        "action" text NOT NULL,
        "target" text,
        "detail" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_audit" PRIMARY KEY ("id")
      )
    `);
    // Журнал читается страницами от свежих к старым — это и есть его индекс.
    await q.query(`CREATE INDEX "audit_at_idx" ON "audit" ("at" DESC, "id" DESC)`);
    await q.query(`CREATE INDEX "audit_actor_idx" ON "audit" ("actor")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "audit"`);
    await q.query(`DROP TABLE "settings"`);
  }
}
```

- [ ] **Шаг 2: Сущности** — `SettingRow` и `AuditRow` по образцу соседей в `entities.ts`
      (типы колонок проставлять руками, включая выводимые), обе в `ENTITIES`, обе в списке
      TRUNCATE в `db/testing.ts`.

- [ ] **Шаг 3: Прогнать схему**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/db/schema.test.ts'
```

Ожидаемо: зелёный — TypeORM после миграций ничего не хочет дописать.

- [ ] **Шаг 4: Коммит**

```bash
git add apps/api/src/db/migrations/1761000000000-Settings.ts apps/api/src/db/migrations/index.ts apps/api/src/db/entities.ts apps/api/src/db/testing.ts
git commit -m "feat(admin): settings and audit tables"
```

---

### Задача 2: Каталог параметров

**Файлы:**

- Создать: `packages/shared/src/settings.ts`
- Создать: `packages/shared/src/settings.test.ts`
- Изменить: `packages/shared/src/index.ts` (реэкспорт)

**Интерфейсы:**

- Отдаёт дальше (этим пользуются все остальные задачи этапа):

```ts
export type SettingKind = 'boolean' | 'number' | 'bytes' | 'text' | 'multiline' | 'select' | 'list' | 'secret';
export type SettingGroup = 'access' | 'people' | 'moderation' | 'messages' | 'files' | 'direct' | 'spaces' | 'voice' | 'invites' | 'appearance' | 'notifications' | 'maintenance';
export type SettingApplies = 'now' | 'new' | 'restart' | 'env';
export type SettingValue = boolean | number | string | string[];

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  fallback: SettingValue;
  applies: SettingApplies;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** Значение никогда не уходит наружу — только признак «задано». */
  secret?: boolean;
  /** Правка просит подтверждения. */
  danger?: boolean;
  /** Откуда берётся начальное значение при первом старте. */
  env?: string;
  /** Значение живёт в окружении и в панели только показывается. */
  readOnly?: boolean;
}

export const SETTINGS: readonly SettingSpec[];
export const SETTING_GROUPS: readonly SettingGroup[];
export function settingSpec(key: string): SettingSpec | undefined;
export function defaults(): Record<string, SettingValue>;
/** Проверка значения по каталогу: `ok` либо причина отказа. */
export function validateSetting(key: string, value: unknown):
  | { ok: true; value: SettingValue }
  | { ok: false; error: 'unknown-key' | 'read-only' | 'wrong-type' | 'out-of-range' | 'not-an-option' | 'too-long' };
```

- [ ] **Шаг 1: Тест**

`packages/shared/src/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SETTINGS, SETTING_GROUPS, defaults, settingSpec, validateSetting } from './settings';

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
    expect(validateSetting('messages.retentionDays', '30')).toEqual({ ok: false, error: 'wrong-type' });
  });

  it('отвергает выход за границы', () => {
    expect(validateSetting('messages.retentionDays', 0)).toEqual({ ok: false, error: 'out-of-range' });
    expect(validateSetting('messages.retentionDays', 99999)).toEqual({ ok: false, error: 'out-of-range' });
  });

  it('отвергает дробное там, где ждут целое', () => {
    expect(validateSetting('messages.retentionDays', 1.5)).toEqual({ ok: false, error: 'wrong-type' });
  });

  it('отвергает вариант не из списка', () => {
    expect(validateSetting('messages.retentionMode', 'иногда')).toEqual({ ok: false, error: 'not-an-option' });
  });

  it('не даёт править то, что живёт в окружении', () => {
    expect(validateSetting('voice.turnUrls', 'turn:x')).toEqual({ ok: false, error: 'read-only' });
  });

  it('не знает выдуманных ключей', () => {
    expect(validateSetting('secret.backdoor', true)).toEqual({ ok: false, error: 'unknown-key' });
  });

  it('режет длинный текст по границе, а не молча', () => {
    expect(validateSetting('appearance.installName', 'я'.repeat(200))).toEqual({ ok: false, error: 'too-long' });
  });

  it('список принимает только строки и только из вариантов, если они заданы', () => {
    expect(validateSetting('files.allowedKinds', ['image', 'audio'])).toEqual({ ok: true, value: ['image', 'audio'] });
    expect(validateSetting('files.allowedKinds', ['exe'])).toEqual({ ok: false, error: 'not-an-option' });
    expect(validateSetting('files.allowedKinds', [1])).toEqual({ ok: false, error: 'wrong-type' });
  });

  it('знает все 97 параметров каталога', () => {
    expect(SETTINGS.length).toBe(97);
    expect(settingSpec('maintenance.mode')?.danger).toBe(true);
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/shared exec vitest run src/settings.test.ts'
```

- [ ] **Шаг 3: Реализация каталога**

`packages/shared/src/settings.ts` — типы из блока «Интерфейсы» выше, затем массив `SETTINGS`
ровно по таблицам раздела «Каталог параметров» (97 строк), затем `settingSpec`, `defaults` и
`validateSetting`. Шапка файла объясняет, почему это данные, а не экраны:

```ts
/**
 * Все настройки инсталляции — одним списком.
 *
 * Списком, а не набором полей на экране, ровно по одной причине: параметров
 * почти сотня, и у каждого есть тип, границы и вопрос «когда подействует».
 * Разметить это руками в интерфейсе значит завести сотню мест, где проверка
 * значения и само значение разъедутся, — причём разъедутся молча, потому что
 * ошибётся здесь не программа, а человек, дописавший сто первое поле.
 *
 * Поэтому каталог — контракт. Сервер по нему проверяет запись, панель по нему
 * же рисует контролы и подписи, журнал берёт из него имя параметра, а
 * импорт-экспорт — список того, что вообще бывает. Добавить параметр — значит
 * добавить сюда строку; больше нигде ничего дописывать не нужно.
 *
 * Умолчание каждого параметра равно тому, как relay вёл себя до появления
 * панели. Инсталляция, где владелец не открывал её ни разу, обязана работать
 * ровно как прежде, и это проверяется тестом, а не обещанием.
 */
```

Валидация — чистая функция без обращений к базе и окружению: её гоняют и сервер, и
браузер, и тест.

- [ ] **Шаг 4: Реэкспорт** — в `packages/shared/src/index.ts`: `export * from './settings';`

- [ ] **Шаг 5: Прогнать — зелёные, коммит**

```bash
git add packages/shared/src/settings.ts packages/shared/src/settings.test.ts packages/shared/src/index.ts
git commit -m "feat(admin): the settings catalogue is the contract"
```

---

### Задача 3: SettingsService

**Файлы:**

- Создать: `apps/api/src/settings/settings.service.ts`, `settings.service.test.ts`
- Изменить: `apps/api/src/app.module.ts`

**Интерфейсы:**

```ts
class SettingsService implements OnModuleInit {
  onModuleInit(): Promise<void>;          // засев из env + прогрев кэша
  /** Значение параметра. Синхронно: спрашивается в горячих местах. */
  get<T extends SettingValue>(key: string): T;
  /** Всё, что можно показать: секреты заменены на признак «задано». */
  public(): Record<string, SettingValue>;
  /** Записать. Проверка — каталогом; `changed` — было ли что менять. */
  set(key: string, value: unknown, by: string): Promise<{ ok: true; changed: boolean; before: SettingValue } | { ok: false; error: SettingError }>;
  /** Сбросить группу к умолчаниям; возвращает ключи, которые изменились. */
  resetGroup(group: SettingGroup, by: string): Promise<string[]>;
  /** Подписка на изменение — ею живут потребители из задач 4 и 5. */
  onChange(listener: (key: string, value: SettingValue) => void): () => void;
}
```

- [ ] **Шаг 1: Тест**

```ts
describe('значения', () => {
  it('до первой записи отдаёт умолчания каталога', async () => {
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
  });

  it('засевается из окружения при первом старте', async () => {
    process.env.RETENTION_DAYS = '30';
    const fresh = new SettingsService(db);
    await fresh.onModuleInit();
    expect(fresh.get<number>('messages.retentionDays')).toBe(30);
  });

  it('после первой записи окружение больше не решает', async () => {
    await settings.set('messages.retentionDays', 7, owner);
    process.env.RETENTION_DAYS = '30';
    const restarted = new SettingsService(db);
    await restarted.onModuleInit();
    expect(restarted.get<number>('messages.retentionDays')).toBe(7);
  });

  it('переживает перезапуск', async () => { /* … */ });
});

describe('запись', () => {
  it('отказывает по каталогу и ничего не пишет', async () => {
    const res = await settings.set('messages.retentionDays', 0, owner);
    expect(res).toEqual({ ok: false, error: 'out-of-range' });
    expect(settings.get<number>('messages.retentionDays')).toBe(14);
  });

  it('повторная запись того же значения — не изменение', async () => {
    await settings.set('direct.enabled', false, owner);
    const again = await settings.set('direct.enabled', false, owner);
    expect(again).toEqual({ ok: true, changed: false, before: false });
  });

  it('будит подписчиков ровно на изменениях', async () => {
    const seen: string[] = [];
    settings.onChange((key) => seen.push(key));
    await settings.set('direct.enabled', false, owner);
    await settings.set('direct.enabled', false, owner);
    expect(seen).toEqual(['direct.enabled']);
  });
});

describe('наружу', () => {
  it('секрет уходит признаком, а не значением', async () => {
    await settings.set('access.sitePasswordSet', 'тайна', owner);
    expect(settings.public()['access.sitePasswordSet']).toBe(true);
    expect(JSON.stringify(settings.public())).not.toContain('тайна');
  });

  it('инфраструктурное показывается из окружения', async () => {
    process.env.SFU_URL = '/sfu';
    const fresh = new SettingsService(db);
    await fresh.onModuleInit();
    expect(fresh.public()['voice.sfuUrl']).toBe('/sfu');
  });
});

describe('сброс группы', () => {
  it('возвращает только то, что менялось', async () => {
    await settings.set('files.maxUploadBytes', 1024, owner);
    expect(await settings.resetGroup('files', owner)).toEqual(['files.maxUploadBytes']);
    expect(await settings.resetGroup('files', owner)).toEqual([]);
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть.**

- [ ] **Шаг 3: Реализация.** Кэш — `Map<string, SettingValue>`, прогрев в `onModuleInit`,
      запись через `INSERT … ON CONFLICT DO UPDATE`, секреты не попадают в `public()`,
      `readOnly` читаются из `process.env` в момент вызова. Засев: если таблица пуста —
      пройтись по каталогу, взять `spec.env` и разобрать значение тем же кодом, что и
      сегодняшний парсер (`parseRetention` для ретенции, число/флаг для остальных).

- [ ] **Шаг 4: Прогнать — зелёные, коммит**

```bash
git add apps/api/src/settings apps/api/src/app.module.ts
git commit -m "feat(admin): settings live in the database, env only seeds them"
```

---

### Задача 4: Настройки начинают действовать — политика хранения и файлов

**Файлы:**

- Изменить: `apps/api/src/db/retention.service.ts`, `apps/api/src/uploads.ts`,
  `apps/api/src/upload.guard.ts`, `apps/api/src/config.controller.ts`
- Тест: соответствующие `*.test.ts` (дописать случаи)

**Что меняется:** сегодня эти места читают `process.env` при старте. Теперь они спрашивают
`SettingsService` в момент дела — иначе смена ретенции в панели не значила бы ничего до
перезапуска.

- [ ] **Шаг 1: Тесты**

```ts
it('ретенция берёт срок из настроек и подхватывает его смену', async () => {
  await settings.set('messages.retentionDays', 1, owner);
  // Сообщение суточной давности уходит, вчерашнее — остаётся.
});

it('размер загрузки ограничен настройкой, а не константой', async () => {
  await settings.set('files.maxUploadBytes', 1024, owner);
  expect(guard.allows({ size: 2048 })).toBe(false);
});

it('выключенные загрузки отвергают запрос целиком', async () => { /* … */ });

it('запрещённый вид файла не проходит', async () => {
  await settings.set('files.allowedKinds', ['image'], owner);
  expect(guard.allows({ mime: 'audio/mpeg' })).toBe(false);
});

it('/api/config отдаёт срок хранения из настроек', async () => { /* … */ });
```

- [ ] **Шаг 2: Прогнать — упасть.**
- [ ] **Шаг 3: Реализация** — внедрить `SettingsService` в четыре места, `process.env`
      оставить только там, где параметр помечен `readOnly`.
- [ ] **Шаг 4: Прогнать весь api — зелёные.**
- [ ] **Шаг 5: Коммит**

```bash
git commit -m "feat(admin): retention and upload limits obey the panel"
```

---

### Задача 5: Настройки начинают действовать — периметр, чат, ЛС, обслуживание

**Файлы:**

- Изменить: `apps/api/src/gateway/perimeter.ts` (лимитер, гости, режим обслуживания),
  `apps/api/src/gateway/chat.handlers.ts` (длина, правка, удаление, стоп-слова, только
  чтение), `apps/api/src/gateway/dm.handlers.ts` (`direct.*`),
  `apps/api/src/gateway/registry.handlers.ts` (квоты серверов и каналов)
- Тест: `perimeter.test.ts`, `chat.service.test.ts`, `dm.handlers.test.ts`,
  `directory.servers.test.ts` (дописать случаи)

- [ ] **Шаг 1: Тесты**

```ts
it('режим обслуживания пускает владельца и отвергает остальных', async () => { /* … */ });
it('«только чтение» не принимает реплику, но не рвёт сокет', async () => { /* … */ });
it('стоп-слово блокирует сообщение и говорит об этом автору', async () => { /* … */ });
it('выключенные ЛС отвечают forbidden на dm-open', async () => { /* … */ });
it('«кто может писать первым: никто» не даёт завести новую переписку, но не мешает старой', async () => { /* … */ });
it('квота серверов на личность считается по настройке', async () => { /* … */ });
it('лимитер сообщений берёт скорость и всплеск из настроек', async () => { /* … */ });
```

- [ ] **Шаг 2: Прогнать — упасть.**
- [ ] **Шаг 3: Реализация.** Ключевое: **умолчания дают сегодняшнее поведение** — тесты,
      которые ничего не настраивают, обязаны остаться зелёными без правок.
- [ ] **Шаг 4: Прогнать весь api.**
- [ ] **Шаг 5: Коммит**

```bash
git commit -m "feat(admin): perimeter, chat and direct messages obey the panel"
```

---

### Задача 6: Журнал

**Файлы:**

- Создать: `apps/api/src/settings/audit.service.ts`, `audit.service.test.ts`
- Изменить: `apps/api/src/settings/settings.service.ts` (писать в журнал при записи),
  `apps/api/src/identity/roles.service.ts` (бан и разбан), `apps/api/src/identity/owner.service.ts`
  (взятие власти и перевыпуск ссылки)

**Интерфейсы:**

```ts
export type AuditAction = 'setting-changed' | 'settings-reset' | 'ban' | 'unban' | 'owner-claimed' | 'owner-link-issued' | 'password-changed' | 'retention-run' | 'files-swept' | 'sessions-revoked' | 'device-revoked' | 'settings-imported';
class AuditService {
  write(entry: { actor: string | null; actorNick: string; action: AuditAction; target?: string; detail?: Record<string, unknown> }): Promise<void>;
  page(cursor?: { at: number; id: string }, limit?: number): Promise<{ entries: AuditEntry[]; more: boolean }>;
}
```

- [ ] **Шаг 1: Тест**

```ts
it('пишет изменение параметра со «стало» и «было»', async () => { /* … */ });
it('не пишет значение секрета', async () => {
  await settings.set('access.sitePasswordSet', 'тайна', owner);
  const { entries } = await audit.page();
  expect(JSON.stringify(entries)).not.toContain('тайна');
  expect(entries[0].action).toBe('password-changed');
});
it('страницы идут от свежих к старым и не теряют записи на границе', async () => { /* … */ });
it('помнит, кто действовал, даже если личность потом исчезла', async () => { /* … */ });
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит**

```bash
git commit -m "feat(admin): an audit trail for everything the owner does"
```

---

### Задача 7: Протокол панели и обработчики

**Файлы:**

- Создать: `packages/shared/src/admin.ts`, `apps/api/src/gateway/admin.handlers.ts`,
  `apps/api/src/gateway/admin.handlers.test.ts`, `apps/api/src/settings/overview.service.ts`
- Изменить: `apps/api/src/gateway/signaling.gateway.ts`, `gateway.testkit.ts`,
  `packages/shared/src/index.ts`, `docs/protocol.md`

**Интерфейсы:**

События клиент → сервер (все с ack, все только для владельца):

```ts
'admin-state': (cb: (res: AdminStateResult) => void) => void;          // каталог + значения + сводка
'admin-set': (payload: { key: string; value: unknown }, cb: (res: AdminSetResult) => void) => void;
'admin-reset': (payload: { group: SettingGroup }, cb: (res: AdminResetResult) => void) => void;
'admin-people': (payload: { query?: string; cursor?: string }, cb: (res: AdminPeopleResult) => void) => void;
'admin-bans': (cb: (res: AdminBansResult) => void) => void;
'admin-audit': (payload: { cursor?: { at: number; id: string } }, cb: (res: AdminAuditResult) => void) => void;
'admin-action': (payload: { action: AdminAction; target?: string }, cb: (res: AdminActionResult) => void) => void;
```

Сервер → клиент: `admin-changed` (параметр изменили из другой сессии владельца).

`AdminAction` = `'owner-link'` | `'retention-run'` | `'files-sweep'` | `'revoke-sessions'` |
`'revoke-device'` | `'export'` | `'import'`.

- [ ] **Шаг 1: Тест**

```ts
describe('дверь', () => {
  it('не владельцу отвечает forbidden на каждое событие панели', async () => {
    const plain = await connectAs(gw, server, (await personCookie('никто')).cookie);
    expect(await gw.handleAdminState(asSocket(plain))).toEqual({ ok: false, error: 'forbidden' });
    expect(await gw.handleAdminSet(asSocket(plain), { key: 'direct.enabled', value: false })).toEqual({ ok: false, error: 'forbidden' });
    expect(await gw.handleAdminAction(asSocket(plain), { action: 'owner-link' })).toEqual({ ok: false, error: 'forbidden' });
  });

  it('бывшему владельцу отказывает сразу после потери власти', async () => { /* … */ });
});

describe('состояние', () => {
  it('отдаёт каталог, значения и сводку одним ответом', async () => { /* … */ });
  it('не отдаёт значения секретов', async () => { /* … */ });
});

describe('запись', () => {
  it('пишет, отвечает и уведомляет вторую сессию владельца', async () => { /* … */ });
  it('на негодном значении отвечает причиной из каталога', async () => { /* … */ });
});

describe('люди', () => {
  it('отдаёт лицо, ник, отпечаток, устройства и статус', async () => { /* … */ });
  it('банит и разбанивает по отпечатку', async () => { /* … */ });
  it('не даёт забанить самого владельца', async () => { /* … */ });
});

describe('действия', () => {
  it('перевыпуск ссылки владельца отдаёт ключ ровно один раз', async () => { /* … */ });
  it('экспорт настроек не содержит секретов', async () => { /* … */ });
  it('импорт применяет годное и перечисляет отвергнутое', async () => { /* … */ });
});
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные** (весь `src/gateway` + `src/settings`).
- [ ] **Шаг 5: Документация** — раздел «Админ-панель» в `docs/protocol.md`.
- [ ] **Шаг 6: Коммит**

```bash
git commit -m "feat(admin): owner-only protocol for the panel"
```

---

### Задача 8: Пароль инсталляции меняется из панели

**Файлы:**

- Изменить: `apps/api/src/auth/auth.ts` (проверка пароля через настройки),
  `apps/api/src/auth/auth.controller.ts`, `apps/api/src/settings/settings.service.ts`
  (хэш scrypt для `access.sitePasswordSet`), `apps/api/src/http-gate.ts`
- Тест: `apps/api/src/auth/auth.test.ts`, `settings.service.test.ts`

**Почему отдельно:** это единственный параметр, который одновременно секрет, хэшируется и
отзывает всё выданное. Смешивать его с общей записью значило бы протащить scrypt и отзыв кук
в код, который меняет число в поле.

- [ ] **Шаг 1: Тест**

```ts
it('пароль из панели заменяет пароль из окружения', async () => { /* … */ });
it('смена пароля отзывает все выданные куки', async () => { /* … */ });
it('пустой пароль означает «сайт открыт», и панель говорит об этом прямо', async () => { /* … */ });
it('старый пароль перестаёт пускать сразу, без перезапуска', async () => { /* … */ });
it('хэш пароля не уходит наружу ни одним событием', async () => { /* … */ });
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит**

```bash
git commit -m "feat(admin): the installation password changes from the panel"
```

---

### Задача 9: Веб — стор панели

**Файлы:**

- Создать: `apps/web/stores/admin.ts`, `apps/web/stores/admin.test.ts`
- Изменить: `apps/web/stores/ui.ts` (`adminOpen`), `components/providers/SocketProvider.tsx`

**Интерфейсы:**

```ts
interface AdminState {
  loaded: boolean;
  values: Record<string, SettingValue>;
  overview: AdminOverview | null;
  /** Ключи, чья запись сейчас в полёте: поле показывает это, а не «сохранено». */
  saving: string[];
  /** Отказ по ключу — подпись под полем. */
  errors: Record<string, string>;
  load: () => Promise<void>;
  set: (key: string, value: SettingValue) => Promise<void>;
  applyRemote: (key: string, value: SettingValue) => void;
  resetGroup: (group: SettingGroup) => Promise<void>;
}
```

- [ ] **Шаг 1: Тест**

```ts
it('оптимистично показывает новое значение и откатывает при отказе', async () => { /* … */ });
it('чужая правка из другой сессии владельца приезжает в поле', () => { /* … */ });
it('две правки одного поля подряд не оставляют его в «сохраняется»', async () => { /* … */ });
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(admin): panel store`

---

### Задача 10: Веб — каркас панели и поля из каталога

**Файлы:**

- Создать: `apps/web/components/admin/AdminDialog.tsx`, `SettingField.tsx`,
  `admin-fields.test.tsx`
- Изменить: `apps/web/components/layout/Toolbar.tsx` (цель Admin оживает),
  `components/layout/AppShell.tsx`, `lib/i18n/messages/*.json`

**Ключевое:** `SettingField` рисует контрол **по виду параметра из каталога**, а не по
имени: `boolean` → переключатель, `number`/`bytes` → поле с границами и подписью единиц,
`select` → селект, `list` → набор чипов, `text`/`multiline` → поле и textarea, `secret` →
«задано / не задано» с кнопкой «сменить», `readOnly` → значение и подпись «правится в .env».

- [ ] **Шаг 1: Тест**

```tsx
it('флаг рисуется переключателем, число — полем с границами', () => { /* … */ });
it('секрет не показывает значение', () => { /* … */ });
it('параметр из окружения выключен и объясняет почему', () => { /* … */ });
it('опасный параметр просит подтверждения перед записью', async () => { /* … */ });
it('под полем видно, когда изменение подействует', () => { /* … */ });
it('каждая группа каталога получила вкладку', () => {
  render(<AdminDialog open />);
  for (const group of SETTING_GROUPS) expect(screen.getByTestId(`admin-tab-${group}`)).toBeTruthy();
});
```

- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: i18n** — по ключу на параметр (`settings.key.<key>.label`, `.hint`) и по
      ключу на группу. Их около двухсот; генерировать их скриптом нельзя (перевод —
      человеческий текст), но и терять нельзя: `messages.test.ts` следит, чтобы обе локали
      были полными.
- [ ] **Шаг 6: Коммит** — `feat(admin): the panel renders itself from the catalogue`

---

### Задача 11: Веб — люди и баны

**Файлы:** `components/admin/PeopleTab.tsx`, `BansTab.tsx`, тест, i18n.

- [ ] **Шаг 1: Тест** — таблица рисует лицо, ник, отпечаток, устройства, статус; поиск;
      «бан» просит подтверждения и говорит, что это значит; владельца забанить нельзя
      (кнопки нет); разбан возвращает человека в список без перезагрузки панели.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(admin): identities and bans`

---

### Задача 12: Веб — обзор, журнал, обслуживание

**Файлы:** `components/admin/OverviewTab.tsx`, `AuditTab.tsx`, `MaintenanceTab.tsx`, тесты,
i18n.

- [ ] **Шаг 1: Тест** — плитки сводки (cpu, память, диск, аптайм, люди, сообщения, версия);
      журнал листается и не теряет записи на границе страницы; каждое действие обслуживания
      просит подтверждение и показывает исход; ссылка владельца показывается один раз и
      копируется.
- [ ] **Шаг 2–4: упасть → реализовать → зелёные.**
- [ ] **Шаг 5: Коммит** — `feat(admin): overview, audit log and maintenance actions`

---

### Задача 13: Мобилка, i18n и e2e

**Файлы:** `components/admin/AdminDialog.tsx` (две строки вкладок на 375),
`e2e/tests/admin.spec.ts`, `docs/plans/relay-2.0.md`, `README.md` + `README.ru.md` (раздел про
панель), `.env.example` (пометить, какие переменные теперь только засевают).

- [ ] **Шаг 1: e2e**

```ts
test('владелец меняет параметр, и он действует без перезапуска', async ({ browser }) => {
  // ретенция → 1 день, проверить ответ /api/config
});
test('не владельцу панель не открывается и события отвергаются', async ({ browser }) => { /* … */ });
test('режим обслуживания закрывает вход всем, кроме владельца', async ({ browser }) => { /* … */ });
```

- [ ] **Шаг 2: Прогнать e2e — упасть → починить → зелёные.**
- [ ] **Шаг 3: Две строки вкладок на 375** (в одну строку не влезают, горизонтальный скроллер
      прячет последнюю — кадр `2h` референса).
- [ ] **Шаг 4: Полный гейт**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

- [ ] **Шаг 5: Коммит** — `feat(admin): mobile layout, docs and the e2e run`

---

## Готово, когда

- Владелец открывает панель из тулбара; никто другой её не открывает и не может позвать ни
  одно её событие.
- Все 97 параметров каталога видны, правятся (кроме помеченных `env`) и переживают
  перезапуск.
- Инсталляция, где панель не открывали, ведёт себя ровно как до этапа — тест на умолчания
  зелёный.
- Смена ретенции, лимита загрузки, лимитера сообщений, политики ЛС и режима обслуживания
  действует без перезапуска.
- Ни один секрет не уходит наружу ни одним событием — включая экспорт настроек.
- Каждое изменение и каждое действие видно в журнале с автором и временем.
- Панель работает на 375 и 1280, в обеих темах и обеих локалях.

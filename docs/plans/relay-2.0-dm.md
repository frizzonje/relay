# Этап A: личные сообщения — план реализации

> **Для исполнителя:** ОБЯЗАТЕЛЬНЫЙ СУБ-НАВЫК: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans` — задача за задачей. Шаги помечены
> чекбоксами (`- [ ]`) для отметки прогресса.

**Цель:** двое, вошедшие на инсталляцию, пишут друг другу вне серверов и каналов; история
переживает рестарт и живёт по общей ретенции.

**Архитектура:** беседа — это канал типа `dm` без сервера. Всё, что уже умеет текстовый
канал (лента, курсор, вложения, реакции, правки, поиск, ретенция, каскады), достаётся ЛС
даром, потому что `messages.channel_id` продолжает указывать на строку `channels`. Меняется
ровно одна вещь — **дверь**: в обычный канал сокет входит по слагу из реестра, в беседу — по
отпечатку собеседника, а членство проверяется по таблице `conversations`. Реестр (то, что
рассылается всем) беседы не видит вовсе.

**Стек:** NestJS 11 + socket.io 4 + TypeORM 0.3 + Postgres (api), Next.js 15 / React 19 /
Zustand 5 / Tailwind v4 / Framer Motion (web), vitest 2 (юнит), Playwright 1.55 (e2e).

**Спека:** [docs/plans/relay-2.0.md](relay-2.0.md) (продуктовое решение) +
[reference/direct-messages/README.md](../../reference/direct-messages/README.md) (дизайн-референс,
интерактивный HTML рядом с ним).

## Глобальные ограничения

- **Всё в Docker.** Хостовые `pnpm`/`node` не трогаем, даже если они на PATH. Образ —
  `node:20-alpine`, монорепо монтируется в `/mono`.
- **Тесты api ходят в настоящий Postgres.** `TEST_DATABASE_URL` обязателен, подделки в памяти
  запрещены (`apps/api/src/db/testing.ts`).
- **Порог покрытия api:** statements 90 / branches 85 / functions 90 / lines 90. Новый сервис
  без тестов уронит прогон целиком.
- **Контракт — в двух местах сразу:** `packages/shared/src/index.ts` (типы для клиента) и
  `apps/api/src/gateway/protocol.ts` (валидаторы для сервера). Разъезд между ними — баг.
- **Комментарии и UI — на русском**, в тон существующему коду; нейтральная лексика.
- **Коммиты — на английском**, Conventional Commits (`feat(dm): …`, `fix(dm): …`).
- **Токены дизайна новые не заводим.** Всё из `@theme` в `apps/web/app/globals.css`.
- **i18n:** база — `en.json`, перевод — `ru.json`. Ключ, добавленный только в одну, ломает
  `lib/i18n/messages.test.ts`.
- **Гость по инвайту в ЛС не участвует** ни одной стороной: его личность живёт внутри одного
  приглашения.
- **Честная строка про приватность обязательна:** ЛС читаемы владельцем инсталляции, и это
  сказано в интерфейсе, а не только в документации.

### Команды прогона

Поднять базу (один раз на сессию):

```bash
docker compose -f infra/docker-compose.dev.yml up -d db
```

Тесты api (файл или весь пакет):

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/dm.service.test.ts'
```

Тесты веба и общего пакета:

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/web exec vitest run stores/dm.test.ts'
```

Полный гейт перед сдачей этапа:

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

---

## Карта файлов

**Создаются (api):**

| Файл | За что отвечает |
|---|---|
| `apps/api/src/db/migrations/1760000000000-DirectMessages.ts` | `server_id` становится необязательным, появляется таблица `conversations` |
| `apps/api/src/gateway/dm.service.ts` | адрес пары, открытие беседы, членство, список переписок |
| `apps/api/src/gateway/dm.service.test.ts` | тесты того же |
| `apps/api/src/gateway/dm.handlers.ts` | обработчики `dm-open` / `dm-list` / `dm-join` / `dm-people` |
| `apps/api/src/gateway/dm.handlers.test.ts` | тесты того же, поверх стенда гейтвея |

**Правятся (api):**

| Файл | Что меняется |
|---|---|
| `apps/api/src/db/entities.ts` | `ChannelRow.serverId` → `string \| null`, новый `ConversationRow`, `ENTITIES` |
| `apps/api/src/db/testing.ts` | `conversations` в списке TRUNCATE |
| `apps/api/src/db/migrations/index.ts` | новая миграция в списке |
| `apps/api/src/gateway/registry.service.ts` | реестр читает и подметает только `text`/`voice` |
| `apps/api/src/gateway/chat.service.ts` | `channelId`/`slugOf`/`lastTs` знают про беседы |
| `apps/api/src/gateway/chat.handlers.ts` | активность беседы уходит двоим, а не всем; закрепление в ЛС запрещено |
| `apps/api/src/gateway/personal.handlers.ts` | отметки чтения бесед доезжают до клиента |
| `apps/api/src/gateway/protocol.ts` | валидаторы полезной нагрузки ЛС |
| `apps/api/src/gateway/signaling.gateway.ts` | проводка `DmHandlers`, `@SubscribeMessage` |
| `apps/api/src/gateway/gateway.testkit.ts` | стенд собирает `DmService` |
| `apps/api/src/app.module.ts` | `DmService` в провайдерах |

**Создаются (web):**

| Файл | За что отвечает |
|---|---|
| `apps/web/stores/dm.ts` | список переписок, открытая беседа, непрочитанное по людям |
| `apps/web/stores/dm.test.ts` | тесты стора |
| `apps/web/components/layout/Toolbar.tsx` | рейка (десктоп) и полоса (мобилка) с целями Direct/Call/Admin |
| `apps/web/components/dm/DmList.tsx` | список переписок вместо сайдбара |
| `apps/web/components/dm/DmThread.tsx` | сцена переписки |
| `apps/web/components/dm/DmPeerCard.tsx` | правая колонка: собеседник, присутствие, «Call» |
| `apps/web/components/dm/PeoplePicker.tsx` | выбор собеседника (панель на десктопе, bottom sheet на мобиле) |
| `e2e/tests/dm.spec.ts` | двое переписываются, история переживает перезагрузку |

**Правятся (web):**

| Файл | Что меняется |
|---|---|
| `apps/web/components/ui/icon.tsx` | контуры `phone`, `message-square`, `shield` |
| `apps/web/stores/ui.ts` | `view: 'dm'`, `dmPeer`, `openDm`, `leaveDm` |
| `apps/web/components/layout/AppShell.tsx` | тулбар в каркасе, подмена сайдбара и колонки состава в режиме ЛС |
| `apps/web/components/stage/Stage.tsx` | сцена `dm` |
| `apps/web/components/layout/MobileNav.tsx` | заголовок и контекстное действие для ЛС |
| `apps/web/components/providers/SocketProvider.tsx` | подписка на `dm-activity`, вход в беседу при смене сцены |
| `apps/web/lib/i18n/messages/en.json`, `ru.json` | ключи раздела `dm.*` |

---

## Решения, принятые заранее

Их не надо пересматривать по ходу — но надо понимать, иначе задачи выглядят произвольными.

1. **Беседа — строка в `channels` с `type='dm'` и `server_id = NULL`.** Так ЛС бесплатно
   получают ленту, курсор, вложения, реакции, правки, поиск, ретенцию и каскадное удаление.
   Цена — две ловушки в реестре (чтение и подметание), обе закрываются в задаче 1.
2. **Адрес беседы детерминирован:** `dm-` + первые 24 знака sha256 от двух id личностей,
   отсортированных лексикографически. Двое, открывшие переписку одновременно, приходят к
   одной строке, а не к двум (гонка гасится ещё и уникальным ключом по паре).
3. **Собеседник называется отпечатком, а не ником.** Ники не уникальны; отпечаток и есть
   адрес.
4. **Писать реплики в беседу нечем новым.** После `dm-join` сокет сидит в комнате беседы, и
   работают ровно те же `chat-message` / `chat-edit` / `chat-delete` / `chat-react` /
   `chat-typing` / `chat-history-more`. Новых обработчиков сообщений в этом этапе нет.
5. **Закреплений в ЛС нет, счётчика упоминаний нет, поиск — только по самой беседе.**
   Закрепление — право модератора сервера, которого у беседы не существует; `@`-упоминание в
   переписке двоих не несёт смысла.
6. **Список людей — те, кого инсталляция уже видела** (строки `identities`), кроме себя и
   забаненных на инсталляции.
7. **Тулбар — вторая узкая рейка рядом с рейкой серверов** (вариант `1b` референса): план 2.0
   говорит «отдельный раздел рядом с рейкой серверов», и панель выбора собеседника на 330px
   ложится туда же. Вариант `1a` (палитра ⌘K справа) не берём.
8. **Цель `Call` и цель `Admin` в тулбаре рисуются сразу, но в этом этапе выключены**
   (приглушены, тултип «скоро»). Двигать каркас дважды дороже, чем нарисовать две мёртвые
   кнопки; включит их этап B и этап C.

---

### Задача 1: Схема — беседа как канал без сервера

**Файлы:**

- Создать: `apps/api/src/db/migrations/1760000000000-DirectMessages.ts`
- Изменить: `apps/api/src/db/entities.ts` (`ChannelRow.serverId`, новый `ConversationRow`, `ENTITIES`)
- Изменить: `apps/api/src/db/migrations/index.ts`
- Изменить: `apps/api/src/db/testing.ts` (список TRUNCATE)
- Изменить: `apps/api/src/gateway/registry.service.ts` (`load`, `deleteMissing`)
- Тест: `apps/api/src/db/schema.test.ts` (существующий, должен остаться зелёным),
  `apps/api/src/gateway/registry.service.test.ts` (новый случай)

**Интерфейсы:**

- Отдаёт дальше: таблицу `conversations (id uuid pk, channel_id text unique, a uuid, b uuid,
  created_at timestamptz)` с уникальным ключом по паре `(a, b)`; `ChannelRow.serverId: string | null`;
  экспорт `ConversationRow` из `db/entities.ts`.

- [ ] **Шаг 1: Тест — реестр не видит бесед и не подметает их**

В `apps/api/src/gateway/registry.service.test.ts` дописать (стенд файла уже есть — смотреть
его шапку и повторить способ получения `db`/`registry`):

```ts
it('беседа не попадает в реестр и переживает его перезапись', async () => {
  const channelId = 'dm-0123456789abcdef01234567';
  await db.getRepository(ChannelRow).insert({
    id: channelId,
    serverId: null,
    type: 'dm',
    name: 'беседа',
    slug: channelId,
    removable: true,
    mode: null,
    creatorId: null,
    creatorIdentityId: null,
    position: 0,
  });

  await registry.load();

  // В реестре её нет: реестр рассылается всем, а беседа — двоих.
  expect(registry.channels.some((c) => c.id === channelId)).toBe(false);
  // И полная перезапись реестра её не снесла вместе с историей.
  await registry.persist();
  await registry.flush();
  expect(await db.getRepository(ChannelRow).countBy({ id: channelId })).toBe(1);
});
```

- [ ] **Шаг 2: Прогнать — тест обязан упасть**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/registry.service.test.ts'
```

Ожидаемо: падение на `insert` — `null value in column "server_id" violates not-null constraint`.

- [ ] **Шаг 3: Миграция**

`apps/api/src/db/migrations/1760000000000-DirectMessages.ts`:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Личные сообщения: беседа — это канал без сервера.
 *
 * Отдельной таблицы сообщений у ЛС нет и не будет. Всё, что уже умеет
 * текстовый канал — курсор ленты, вложения, реакции, поиск, ретенция,
 * каскадное удаление, — держится на `messages.channel_id`, и повторять это
 * второй раз ради двух собеседников значило бы завести вторую ленту с теми же
 * граблями и своим набором ошибок.
 *
 * Поэтому `server_id` становится необязательным: у беседы сервера нет. Кто в
 * ней участвует, знает `conversations` — и только она: реестр, который
 * рассылается всем, о беседах не знает вовсе.
 */
export class DirectMessages1760000000000 implements MigrationInterface {
  name = 'DirectMessages1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "channels" ALTER COLUMN "server_id" DROP NOT NULL`);
    await q.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL,
        "channel_id" text NOT NULL,
        "a" uuid NOT NULL,
        "b" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversations_channel" UNIQUE ("channel_id"),
        CONSTRAINT "FK_conversations_channel" FOREIGN KEY ("channel_id")
          REFERENCES "channels"("id") ON DELETE CASCADE
      )
    `);
    // Пара уникальна. Порядок внутри пары нормализован (a < b) кодом, а не
    // базой: иначе одна и та же переписка завелась бы дважды — по строке на
    // того, кто написал первым.
    await q.query(`CREATE UNIQUE INDEX "conversations_pair_key" ON "conversations" ("a", "b")`);
    // «Мои переписки» — запрос на каждый вход в раздел, и он идёт по обеим
    // колонкам: своя сторона у человека то первая, то вторая.
    await q.query(`CREATE INDEX "conversations_a_idx" ON "conversations" ("a")`);
    await q.query(`CREATE INDEX "conversations_b_idx" ON "conversations" ("b")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "conversations"`);
    await q.query(`DELETE FROM "channels" WHERE "server_id" IS NULL`);
    await q.query(`ALTER TABLE "channels" ALTER COLUMN "server_id" SET NOT NULL`);
  }
}
```

Добавить в `apps/api/src/db/migrations/index.ts` импорт и строку
`DirectMessages1760000000000,` в конец `MIGRATIONS`.

- [ ] **Шаг 4: Сущности**

В `apps/api/src/db/entities.ts`:

1. У `ChannelRow` заменить объявление `serverId` на:

```ts
  /**
   * Сервер, которому канал принадлежит. Пусто — у канала сервера нет, и такой
   * канал сегодня ровно один по смыслу: беседа двоих (`type = 'dm'`). Кто в
   * ней участвует, знает `conversations`.
   */
  @Column({ type: 'text', name: 'server_id', nullable: true })
  serverId!: string | null;

  @ManyToOne(() => ServerRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'server_id' })
  server!: ServerRow | null;
```

2. Перед `ENTITIES` добавить сущность:

```ts
/**
 * Беседа двоих. Строка появляется в момент, когда переписку открыли, а не
 * когда в неё написали: список «с кем я говорю» обязан помнить и пустой
 * разговор, иначе открытая и закрытая беседа исчезала бы из раздела.
 *
 * Пара нормализована (`a < b` лексикографически) — тем же порядком считается и
 * адрес канала, поэтому «я открыл переписку» и «он открыл переписку» приводят
 * к одной строке, а не к двум.
 *
 * Внешний ключ здесь есть (в отличие от соседей по слою 3) и он намеренный:
 * беседа без канала — это переписка без ленты, состояние, которого не должно
 * существовать ни мгновения. Личности внешним ключом не связаны по общей
 * причине: строка личности не должна запирать чужую переписку.
 */
@Entity('conversations')
@Index('conversations_pair_key', ['a', 'b'], { unique: true })
@Index('conversations_a_idx', ['a'])
@Index('conversations_b_idx', ['b'])
export class ConversationRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Канал беседы: `type = 'dm'`, `server_id = null`, слаг равен id. */
  @Column({ type: 'text', name: 'channel_id', unique: true })
  channelId!: string;

  @ManyToOne(() => ChannelRow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel!: ChannelRow;

  /** Меньшая из двух личностей. */
  @Column({ type: 'uuid' })
  a!: string;

  /** Большая из двух. */
  @Column({ type: 'uuid' })
  b!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
```

3. Дописать `ConversationRow` в массив `ENTITIES`.

4. В `apps/api/src/db/testing.ts` добавить `conversations` в список TRUNCATE (перед `pins`).

- [ ] **Шаг 5: Реестр не видит и не подметает беседы**

В `apps/api/src/gateway/registry.service.ts`:

1. Импорт: `import { DataSource, In, type EntityManager } from 'typeorm';`
2. В `load()` заменить чтение каналов на:

```ts
      // Только то, чем владеет реестр. Беседы (`dm`) — тоже строки в
      // `channels`, но они принадлежат двоим, а реестр рассылается всем: попав
      // сюда, беседа уехала бы в чужой сайдбар одним своим существованием.
      this.db.getRepository(ChannelRow).find({
        where: { type: In(REGISTRY_CHANNEL_TYPES) },
        order: { position: 'ASC' },
      }),
```

3. Рядом с `MAIN_SERVER_ID` объявить:

```ts
/** Типы каналов, которыми распоряжается реестр. Беседы (`dm`) — не его дело. */
export const REGISTRY_CHANNEL_TYPES = ['text', 'voice'];
```

4. Починить подметание — иначе первая же запись реестра снесёт все беседы вместе с историей:

```ts
async function deleteMissing(
  m: EntityManager,
  entity: typeof ServerRow | typeof ChannelRow,
  keep: string[],
): Promise<void> {
  const qb = m.createQueryBuilder().delete().from(entity);
  // Реестр пишется полным снимком, и «чего нет в снимке — удалить» верно
  // ровно для того, чем реестр владеет. Беседы в снимке нет никогда, и без
  // этой оговорки первая же перезапись реестра унесла бы всю переписку
  // инсталляции — молча и каскадом.
  if (entity === ChannelRow) {
    qb.where('type IN (:...types)', { types: REGISTRY_CHANNEL_TYPES });
    if (keep.length) qb.andWhere('id NOT IN (:...keep)', { keep });
  } else if (keep.length) {
    qb.where('id NOT IN (:...keep)', { keep });
  }
  await qb.execute();
}
```

- [ ] **Шаг 6: Прогнать — схема и реестр**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/db/schema.test.ts src/gateway/registry.service.test.ts'
```

Ожидаемо: обе зелёные. `schema.test.ts` сверяет, что TypeORM после миграций ничего не хочет
дописать, — если он ругается, разъехались миграция и `entities.ts`.

- [ ] **Шаг 7: Коммит**

```bash
git add apps/api/src/db/migrations/1760000000000-DirectMessages.ts apps/api/src/db/migrations/index.ts apps/api/src/db/entities.ts apps/api/src/db/testing.ts apps/api/src/gateway/registry.service.ts apps/api/src/gateway/registry.service.test.ts
git commit -m "feat(dm): a conversation is a channel without a server"
```

---

### Задача 2: DmService — адрес пары, открытие беседы, список

**Файлы:**

- Создать: `apps/api/src/gateway/dm.service.ts`
- Создать: `apps/api/src/gateway/dm.service.test.ts`
- Изменить: `apps/api/src/app.module.ts` (провайдер)

**Интерфейсы:**

- Берёт: `ConversationRow`, `ChannelRow`, `IdentityRow`, `MessageRow` из `db/entities.ts`;
  `RolesService.rightsOf` не нужен — бан проверяет вызывающий.
- Отдаёт дальше (этим пользуются задачи 3, 5, 6):

```ts
export interface DmPeerView { fingerprint: string; nick: string }
export interface DmConversationView {
  slug: string;
  peer: DmPeerView;
  lastTs: number;
  preview: string;
  previewMine: boolean;
}
export type DmOpenFailure = 'unknown' | 'self';

class DmService {
  onModuleInit(): Promise<void>;
  /** Адрес беседы двоих — одинаковый с обеих сторон. */
  static address(aId: string, bId: string): string;
  /** Открыть (или найти) беседу с этим отпечатком. */
  open(meId: string, peerFingerprint: string): Promise<{ ok: true; view: DmConversationView } | { ok: false; reason: DmOpenFailure }>;
  /** Это адрес беседы? Синхронно, без базы: спрашивается на каждой реплике. */
  isDm(slug: string): boolean;
  /** Id канала беседы (он же слаг) — или undefined, если такой беседы нет. */
  channelIdOf(slug: string): string | undefined;
  /** Участники беседы: два id личностей. Пусто — беседы нет. */
  membersOf(slug: string): [string, string] | undefined;
  /** Этот человек — сторона беседы? */
  isMember(slug: string, identityId: string): boolean;
  /** Мои переписки, свежие сверху. */
  list(meId: string): Promise<DmConversationView[]>;
  /** Кого инсталляция уже видела (кроме себя и забаненных). */
  people(meId: string, query: string, limit: number): Promise<Array<DmPeerView & { lastSeenTs: number }>>;
  /** Адреса моих бесед — по памяти, без базы (нужно отметкам чтения). */
  slugsOf(identityId: string): string[];
  /** Как показать эту личность собеседнику: лицо и подпись. */
  peerView(identityId: string): DmPeerView | undefined;
  /** Человек переименовался — подпись в списке переписок обязана это узнать. */
  rememberNick(identityId: string, nick: string): void;
}
```

Последние три нужны задаче 6, но объявлены здесь: тест на них пишется вместе со всем
остальным сервисом, а не потом.

```ts
it('перечисляет мои беседы по памяти', async () => {
  const me = await person('я');
  const you = await person('ты');
  const res = await dm.open(me.id, you.fingerprint);
  expect(dm.slugsOf(me.id)).toEqual([res.ok ? res.view.slug : '']);
  expect(dm.slugsOf('11111111-1111-1111-1111-111111111111')).toEqual([]);
});

it('помнит ник для подписи и обновляет его при переименовании', async () => {
  const me = await person('я');
  expect(dm.peerView(me.id)?.nick).toBe('я');
  dm.rememberNick(me.id, 'я, но иначе');
  expect(dm.peerView(me.id)?.nick).toBe('я, но иначе');
});
```

Внутри: `private readonly nicks = new Map<string, DmPeerView>()`, заполняется в
`onModuleInit` одним `SELECT id, fingerprint, nick FROM identities` и дописывается в `open()`.

- [ ] **Шаг 1: Тест**

`apps/api/src/gateway/dm.service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { IdentityRow, RoleRow } from '../db/entities';
import { resetDatabase, testDatabase } from '../db/testing';
import { DmService } from './dm.service';

let db: DataSource;
let dm: DmService;

/** Личность в базе: ЛС адресуются отпечатком, поэтому он и возвращается. */
async function person(nick: string): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID();
  const fingerprint = `fp-${id.slice(0, 8)}`;
  await db.getRepository(IdentityRow).insert({
    id,
    publicKey: `key-${id}`,
    fingerprint,
    nick,
    createdAt: new Date(),
    lastSeenAt: new Date(),
  });
  return { id, fingerprint };
}

beforeEach(async () => {
  db = await testDatabase();
  await resetDatabase(db);
  dm = new DmService(db);
  await dm.onModuleInit();
});

describe('адрес беседы', () => {
  it('одинаков с обеих сторон', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(DmService.address(a, b)).toBe(DmService.address(b, a));
  });

  it('начинается с dm- и не содержит id личностей', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    const address = DmService.address(a, b);
    expect(address.startsWith('dm-')).toBe(true);
    expect(address).not.toContain('1111');
  });
});

describe('открытие', () => {
  it('заводит канал и беседу, второй раз возвращает ту же', async () => {
    const me = await person('я');
    const you = await person('ты');

    const first = await dm.open(me.id, you.fingerprint);
    expect(first.ok).toBe(true);
    const slug = first.ok ? first.view.slug : '';

    // Открыл он — та же самая переписка, а не вторая.
    const second = await dm.open(you.id, me.fingerprint);
    expect(second.ok && second.view.slug).toBe(slug);
    expect(await db.query('SELECT count(*)::int AS n FROM conversations')).toEqual([{ n: 1 }]);
  });

  it('называет собеседника по его отпечатку и нику', async () => {
    const me = await person('я');
    const you = await person('ты');
    const res = await dm.open(me.id, you.fingerprint);
    expect(res.ok && res.view.peer).toEqual({ fingerprint: you.fingerprint, nick: 'ты' });
  });

  it('отказывает на незнакомом отпечатке', async () => {
    const me = await person('я');
    const res = await dm.open(me.id, 'fp-никого');
    expect(res).toEqual({ ok: false, reason: 'unknown' });
  });

  it('не даёт открыть переписку с самим собой', async () => {
    const me = await person('я');
    const res = await dm.open(me.id, me.fingerprint);
    expect(res).toEqual({ ok: false, reason: 'self' });
  });
});

describe('членство', () => {
  it('знает своих и не пускает чужого', async () => {
    const me = await person('я');
    const you = await person('ты');
    const third = await person('третий');
    const res = await dm.open(me.id, you.fingerprint);
    const slug = res.ok ? res.view.slug : '';

    expect(dm.isDm(slug)).toBe(true);
    expect(dm.isDm('lounge')).toBe(false);
    expect(dm.isMember(slug, me.id)).toBe(true);
    expect(dm.isMember(slug, you.id)).toBe(true);
    expect(dm.isMember(slug, third.id)).toBe(false);
    expect(dm.membersOf(slug)).toEqual([me.id, you.id].sort());
  });

  it('помнит беседы, заведённые до перезапуска', async () => {
    const me = await person('я');
    const you = await person('ты');
    const res = await dm.open(me.id, you.fingerprint);
    const slug = res.ok ? res.view.slug : '';

    const fresh = new DmService(db);
    await fresh.onModuleInit();
    expect(fresh.isMember(slug, me.id)).toBe(true);
  });
});

describe('список', () => {
  it('пуст, пока никого не открывали', async () => {
    const me = await person('я');
    expect(await dm.list(me.id)).toEqual([]);
  });

  it('показывает открытую переписку без единой реплики', async () => {
    const me = await person('я');
    const you = await person('ты');
    await dm.open(me.id, you.fingerprint);
    const list = await dm.list(me.id);
    expect(list).toHaveLength(1);
    expect(list[0].peer.nick).toBe('ты');
    expect(list[0].lastTs).toBe(0);
    expect(list[0].preview).toBe('');
  });
});

describe('люди', () => {
  it('не показывает меня самого и забаненного', async () => {
    const me = await person('я');
    const you = await person('ты');
    const bad = await person('изгнанный');
    await db.getRepository(RoleRow).insert({
      id: randomUUID(),
      identityId: bad.id,
      serverId: null,
      role: 'banned',
      grantedBy: me.id,
      createdAt: new Date(),
    });

    const people = await dm.people(me.id, '', 20);
    expect(people.map((p) => p.nick)).toEqual(['ты']);
    expect(people[0].fingerprint).toBe(you.fingerprint);
  });

  it('ищет по нику и по отпечатку', async () => {
    const me = await person('я');
    const you = await person('Нина');
    expect((await dm.people(me.id, 'нин', 20)).map((p) => p.nick)).toEqual(['Нина']);
    expect((await dm.people(me.id, you.fingerprint.slice(0, 6), 20))).toHaveLength(1);
    expect(await dm.people(me.id, 'никого', 20)).toEqual([]);
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть на отсутствии модуля**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/dm.service.test.ts'
```

Ожидаемо: `Failed to resolve import "./dm.service"`.

- [ ] **Шаг 3: Реализация**

`apps/api/src/gateway/dm.service.ts`:

```ts
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ChannelRow, ConversationRow, IdentityRow, MessageRow } from '../db/entities';

/** Адрес беседы всегда начинается с этого — по нему её и узнают в ленте. */
export const DM_PREFIX = 'dm-';

/** Сколько знаков хэша в адресе. 24 знака шестнадцатеричных — 96 бит. */
const ADDRESS_LEN = 24;

/** Докуда обрезается превью последней реплики в списке переписок. */
export const DM_PREVIEW_LIMIT = 120;

export interface DmPeerView {
  fingerprint: string;
  nick: string;
}

export interface DmConversationView {
  /** Адрес беседы — он же слаг и id её канала. */
  slug: string;
  peer: DmPeerView;
  /** Время последней реплики; 0 — переписки ещё не было. */
  lastTs: number;
  preview: string;
  /** Последняя реплика — моя. По ней список рисует «вы: …». */
  previewMine: boolean;
}

export type DmOpenFailure = 'unknown' | 'self';

/** Беседа так, как её держит память: без похода в базу на каждую реплику. */
interface Known {
  a: string;
  b: string;
}

/**
 * Личные сообщения: кто с кем говорит.
 *
 * Хранение реплик сюда не переезжает — оно в `chat.service.ts` и одинаково для
 * канала и для беседы. Здесь ровно то, чего у канала нет: **адрес пары и
 * членство**. Канал видно из реестра, и вход в него решается видимостью; беседу
 * не видно ниоткуда, и вход в неё решается вопросом «ты одна из двух сторон?».
 *
 * Ответ на этот вопрос лежит в памяти, а не спрашивается у базы: его задают на
 * каждой реплике, на каждой правке и на каждом «печатает…», то есть в самом
 * горячем месте гейтвея. Карта заполняется на старте и растёт по одной строке
 * при каждом открытии — беседы не удаляются, поэтому расхождения с базой у неё
 * взяться неоткуда.
 */
@Injectable()
export class DmService implements OnModuleInit {
  private readonly logger = new Logger('dm');

  /** адрес → пара личностей. Заполняется на старте, растёт при открытии. */
  private readonly known = new Map<string, Known>();

  constructor(private readonly db: DataSource) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.db.getRepository(ConversationRow).find();
    for (const row of rows) this.known.set(row.channelId, { a: row.a, b: row.b });
    this.logger.log(`бесед в памяти: ${this.known.size}`);
  }

  /**
   * Адрес беседы двоих. Считается из двух id и только из них, поэтому обе
   * стороны приходят к одному адресу, ни о чём не договариваясь, — и поэтому
   * же открытие беседы не гонка: второй insert упирается в уникальный ключ.
   *
   * Хэш, а не «id через дефис»: адрес виден в протоколе и в отладочных логах, а
   * id личности — внутренний ключ, которому там делать нечего.
   */
  static address(aId: string, bId: string): string {
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    const hash = createHash('sha256').update(`${a}:${b}`).digest('hex');
    return DM_PREFIX + hash.slice(0, ADDRESS_LEN);
  }

  /**
   * Открыть беседу с этим отпечатком. Идемпотентно: второй вызов (и вызов с
   * другой стороны) возвращает ту же беседу, а не заводит вторую.
   */
  async open(
    meId: string,
    peerFingerprint: string,
  ): Promise<{ ok: true; view: DmConversationView } | { ok: false; reason: DmOpenFailure }> {
    const peer = await this.db
      .getRepository(IdentityRow)
      .findOne({ where: { fingerprint: peerFingerprint } });
    if (!peer) return { ok: false, reason: 'unknown' };
    if (peer.id === meId) return { ok: false, reason: 'self' };

    const slug = DmService.address(meId, peer.id);
    if (!this.known.has(slug)) await this.create(slug, meId, peer.id);

    const [last] = await this.previews([slug], meId);
    return {
      ok: true,
      view: {
        slug,
        peer: { fingerprint: peer.fingerprint, nick: peer.nick },
        lastTs: last?.lastTs ?? 0,
        preview: last?.preview ?? '',
        previewMine: last?.previewMine ?? false,
      },
    };
  }

  isDm(slug: string): boolean {
    return this.known.has(slug);
  }

  channelIdOf(slug: string): string | undefined {
    return this.known.has(slug) ? slug : undefined;
  }

  membersOf(slug: string): [string, string] | undefined {
    const pair = this.known.get(slug);
    return pair ? [pair.a, pair.b] : undefined;
  }

  isMember(slug: string, identityId: string): boolean {
    const pair = this.known.get(slug);
    return !!pair && (pair.a === identityId || pair.b === identityId);
  }

  /**
   * Мои переписки, свежие сверху. Пустые (открыл и не написал) остаются в
   * списке: закрытая переписка не должна исчезать из раздела оттого, что в ней
   * пока нечего показать.
   */
  async list(meId: string): Promise<DmConversationView[]> {
    const rows: Array<{ channel_id: string; peer_fingerprint: string; peer_nick: string }> =
      await this.db.query(
        `SELECT c.channel_id,
                i.fingerprint AS peer_fingerprint,
                i.nick        AS peer_nick
           FROM conversations c
           JOIN identities i ON i.id = CASE WHEN c.a = $1 THEN c.b ELSE c.a END
          WHERE c.a = $1 OR c.b = $1`,
        [meId],
      );
    if (!rows.length) return [];

    const previews = new Map(
      (await this.previews(rows.map((r) => r.channel_id), meId)).map((p) => [p.slug, p]),
    );
    return rows
      .map((row) => {
        const p = previews.get(row.channel_id);
        return {
          slug: row.channel_id,
          peer: { fingerprint: row.peer_fingerprint, nick: row.peer_nick },
          lastTs: p?.lastTs ?? 0,
          preview: p?.preview ?? '',
          previewMine: p?.previewMine ?? false,
        };
      })
      .sort((x, y) => y.lastTs - x.lastTs);
  }

  /**
   * Кого инсталляция уже видела. Забаненных на всю инсталляцию не показываем:
   * им всё равно не доставить, а строка в списке выглядела бы как живой
   * человек.
   */
  async people(
    meId: string,
    query: string,
    limit: number,
  ): Promise<Array<DmPeerView & { lastSeenTs: number }>> {
    const like = `%${query.trim().toLowerCase()}%`;
    const rows: Array<{ fingerprint: string; nick: string; last_seen_at: Date | null }> =
      await this.db.query(
        `SELECT i.fingerprint, i.nick, i.last_seen_at
           FROM identities i
          WHERE i.id <> $1
            AND NOT EXISTS (
                  SELECT 1 FROM roles r
                   WHERE r.identity_id = i.id AND r.server_id IS NULL AND r.role = 'banned')
            AND ($2 = '%%' OR lower(i.nick) LIKE $2 OR lower(i.fingerprint) LIKE $2)
          ORDER BY i.last_seen_at DESC NULLS LAST, i.nick ASC
          LIMIT $3`,
        [meId, like, limit],
      );
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      nick: r.nick,
      lastSeenTs: r.last_seen_at ? r.last_seen_at.getTime() : 0,
    }));
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  /**
   * Канал беседы и сама беседа — одной транзакцией. Слаг канала равен его id и
   * адресу: три имени одному и тому же, чтобы `chat.service` мог перевести
   * комнату в канал не спрашивая никого.
   */
  private async create(slug: string, meId: string, peerId: string): Promise<void> {
    const [a, b] = meId < peerId ? [meId, peerId] : [peerId, meId];
    await this.db.transaction(async (m) => {
      await m
        .getRepository(ChannelRow)
        .createQueryBuilder()
        .insert()
        .values({
          id: slug,
          serverId: null,
          type: 'dm',
          name: slug,
          slug,
          removable: true,
          mode: null,
          creatorId: null,
          creatorIdentityId: null,
          position: 0,
        })
        .orIgnore()
        .execute();
      await m
        .getRepository(ConversationRow)
        .createQueryBuilder()
        .insert()
        .values({ id: randomUUID(), channelId: slug, a, b, createdAt: new Date() })
        .orIgnore()
        .execute();
    });
    this.known.set(slug, { a, b });
  }

  /**
   * Последняя реплика каждой из бесед — одним запросом на весь список.
   * Отдельным запросом на переписку это была бы та же лента, прочитанная
   * тридцать раз ради тридцати строк превью.
   */
  private async previews(
    slugs: string[],
    meId: string,
  ): Promise<Array<{ slug: string; lastTs: number; preview: string; previewMine: boolean }>> {
    if (!slugs.length) return [];
    const rows: Array<{
      channel_id: string;
      text: string;
      created_at: Date;
      author_identity_id: string | null;
    }> = await this.db.query(
      `SELECT DISTINCT ON (m.channel_id)
              m.channel_id, m.text, m.created_at, m.author_identity_id
         FROM messages m
        WHERE m.channel_id = ANY($1)
        ORDER BY m.channel_id, m.created_at DESC, m.id DESC`,
      [slugs],
    );
    return rows.map((r) => ({
      slug: r.channel_id,
      lastTs: r.created_at.getTime(),
      preview: r.text.slice(0, DM_PREVIEW_LIMIT),
      previewMine: r.author_identity_id === meId,
    }));
  }
}
```

Импорт `MessageRow` в этом файле не нужен — убрать из шапки, если редактор его подставил.

- [ ] **Шаг 4: Провайдер**

В `apps/api/src/app.module.ts` добавить `DmService` в `providers` (рядом с `ChatService`) и в
экспорт, если модуль что-то экспортирует.

- [ ] **Шаг 5: Прогнать — зелёные**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/dm.service.test.ts'
```

- [ ] **Шаг 6: Коммит**

```bash
git add apps/api/src/gateway/dm.service.ts apps/api/src/gateway/dm.service.test.ts apps/api/src/app.module.ts
git commit -m "feat(dm): pair addressing, membership and conversation list"
```

---

### Задача 3: ChatService понимает адрес беседы

**Файлы:**

- Изменить: `apps/api/src/gateway/chat.service.ts` (конструктор, `channelId`, `slugOf`)
- Изменить: `apps/api/src/gateway/gateway.testkit.ts` (стенд собирает `DmService`)
- Тест: `apps/api/src/gateway/chat.service.test.ts` (дописать случай)

**Интерфейсы:**

- Берёт: `DmService.channelIdOf(slug)`, `DmService.isDm(slug)` из задачи 2.
- Отдаёт дальше: `new ChatService(db, registry, dm)` — третий аргумент обязателен; все
  существующие вызовы (`gateway.testkit.ts`, `app.module.ts`) обязаны его передать.

- [ ] **Шаг 1: Тест**

Дописать в `apps/api/src/gateway/chat.service.test.ts` (стенд файла уже есть):

```ts
it('ведёт ленту беседы так же, как ленту канала', async () => {
  const me = await person('я');
  const you = await person('ты');
  const opened = await dm.open(me.id, you.fingerprint);
  const slug = opened.ok ? opened.view.slug : '';

  const msg = await chat.add(slug, { name: 'я', identityId: me.id, text: 'привет' });
  expect(msg?.text).toBe('привет');

  const page = await chat.history(slug);
  expect(page.messages.map((m) => m.text)).toEqual(['привет']);
  expect(chat.lastTs(slug)).toBe(msg?.ts);
});
```

Стенд файла придётся дополнить: рядом с созданием `ChatService` завести `DmService` и
хелпер `person` (скопировать из `dm.service.test.ts` — тот же способ завести личность).

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/chat.service.test.ts'
```

Ожидаемо: `chat.add` вернул `undefined` — `channelId(slug)` ищет только среди текстовых
каналов реестра и беседу не находит.

- [ ] **Шаг 3: Реализация**

В `apps/api/src/gateway/chat.service.ts`:

1. Конструктор:

```ts
  constructor(
    private readonly db: DataSource,
    private readonly registry: RegistryService,
    private readonly dm: DmService,
  ) {}
```

2. Перевод слага в канал:

```ts
  /**
   * Канал с таким слагом. Сперва реестр (текстовые каналы, самый частый
   * случай), затем беседы: они тоже строки в `channels`, но реестр о них не
   * знает намеренно (см. `dm.service`), и без второго вопроса ЛС оставались бы
   * лентой, в которую нельзя написать.
   */
  private channelId(slug: string): string | undefined {
    return (
      this.registry.channels.find((c) => c.type === 'text' && c.slug === slug)?.id ??
      this.dm.channelIdOf(slug)
    );
  }

  /**
   * Обратный ход: слаг по id канала. У беседы они совпадают, поэтому вопрос
   * второй раз задавать не приходится.
   */
  private slugOf(channelId: string): string | undefined {
    return this.registry.channels.find((c) => c.id === channelId)?.slug ?? this.dm.channelIdOf(channelId);
  }
```

3. В `gateway.testkit.ts` завести сервис и передать его: `const dmService = new DmService(db);
await dmService.onModuleInit(); const chat = new ChatService(db, registry, dmService);` — и
вернуть `dm: dmService` из `makeGateway` (он понадобится задаче 5).

4. В `app.module.ts` `ChatService` уже собирается Nest'ом — добавленный в задаче 2 провайдер
подставится сам.

- [ ] **Шаг 4: Прогнать — зелёные**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway'
```

Весь гейтвей: конструктор `ChatService` менялся, и упасть могли соседи.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/api/src/gateway/chat.service.ts apps/api/src/gateway/chat.service.test.ts apps/api/src/gateway/gateway.testkit.ts
git commit -m "feat(dm): the feed resolves conversation addresses too"
```

---

### Задача 4: Контракт ЛС

**Файлы:**

- Изменить: `packages/shared/src/index.ts` (типы, события)
- Изменить: `apps/api/src/gateway/protocol.ts` (валидаторы)
- Изменить: `docs/protocol.md` (описание событий)
- Тест: `packages/shared/src/index.test.ts` (дописать)

**Интерфейсы:**

- Отдаёт дальше (этим пользуются задачи 5, 6, 9–12):

```ts
export const DM_PREFIX = 'dm-';
export const DM_PREVIEW_LIMIT = 120;
export const DM_PEOPLE_LIMIT = 30;
export interface DmPeer { fingerprint: string; nick: string }
export interface DmConversation { slug: string; peer: DmPeer; lastTs: number; preview: string; previewMine: boolean }
export interface DmPerson extends DmPeer { lastSeenTs: number }
export interface DmOpenPayload { fingerprint: string }
export type DmOpenResult = { ok: true; conversation: DmConversation } | { ok: false; error: 'unknown' | 'self' | 'forbidden' };
export interface DmJoinPayload { slug: string }
export type DmJoinResult = { ok: true } | { ok: false; error: 'unknown' | 'forbidden' };
export type DmListResult = { ok: true; conversations: DmConversation[] } | { ok: false; error: 'forbidden' };
export interface DmPeoplePayload { query?: string }
export type DmPeopleResult = { ok: true; people: DmPerson[] } | { ok: false; error: 'forbidden' };
export interface DmActivityRelay { slug: string; ts: number; preview: string; previewMine: boolean; peer: DmPeer }
export function isDmSlug(slug: string): boolean;
```

События: `dm-open`, `dm-list`, `dm-join`, `dm-people` (клиент → сервер, все с ack),
`dm-activity` (сервер → клиент).

- [ ] **Шаг 1: Тест**

В `packages/shared/src/index.test.ts`:

```ts
import { DM_PREFIX, isDmSlug } from './index';

describe('адрес беседы', () => {
  it('узнаётся по префиксу', () => {
    expect(isDmSlug(`${DM_PREFIX}0123456789abcdef01234567`)).toBe(true);
  });

  it('не путается с каналом, чьё имя начинается так же', () => {
    // Канал «dm-обсуждение» — законное имя, и лента у него обычная.
    expect(isDmSlug('dm-obsuzhdenie')).toBe(false);
    expect(isDmSlug('lounge')).toBe(false);
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/shared exec vitest run src/index.test.ts'
```

- [ ] **Шаг 3: Реализация в shared**

В конец раздела чата `packages/shared/src/index.ts`:

```ts
// ─────────────────────────────────────────────────────────────────────────
// Личные сообщения
// ─────────────────────────────────────────────────────────────────────────

/** С этого начинается адрес беседы. Дальше — 24 знака шестнадцатеричных. */
export const DM_PREFIX = 'dm-';

/** Докуда обрезана последняя реплика в списке переписок. */
export const DM_PREVIEW_LIMIT = 120;

/** Сколько людей отдаётся на один запрос выбора собеседника. */
export const DM_PEOPLE_LIMIT = 30;

/**
 * Беседа это или обычный канал. Проверяем не только префикс, но и форму
 * хвоста: «dm-обсуждение» — законное имя текстового канала, и спутать их
 * значило бы отдать его ленту под правила ЛС.
 */
export function isDmSlug(slug: string): boolean {
  return /^dm-[0-9a-f]{24}$/.test(slug);
}

/** Собеседник: лицо рисуется по отпечатку, подпись — ником. */
export interface DmPeer {
  fingerprint: string;
  nick: string;
}

/** Человек в списке выбора: тот же собеседник плюс «когда его видели». */
export interface DmPerson extends DmPeer {
  /** 0 — не видели ни разу. */
  lastSeenTs: number;
}

/** Строка раздела ЛС. */
export interface DmConversation {
  /** Адрес беседы: он же слаг ленты, в которую входит `dm-join`. */
  slug: string;
  peer: DmPeer;
  /** Время последней реплики; 0 — переписки ещё не было. */
  lastTs: number;
  /** Последняя реплика, обрезанная до DM_PREVIEW_LIMIT. */
  preview: string;
  previewMine: boolean;
}

export interface DmOpenPayload {
  /** Кому пишем. Именно отпечаток: ники не уникальны. */
  fingerprint: string;
}

export type DmOpenResult =
  | { ok: true; conversation: DmConversation }
  /** `unknown` — такой личности инсталляция не знает; `forbidden` — ЛС не для тебя (гость, бан). */
  | { ok: false; error: 'unknown' | 'self' | 'forbidden' };

export interface DmJoinPayload {
  slug: string;
}

export type DmJoinResult = { ok: true } | { ok: false; error: 'unknown' | 'forbidden' };

export type DmListResult =
  | { ok: true; conversations: DmConversation[] }
  | { ok: false; error: 'forbidden' };

export interface DmPeoplePayload {
  /** Поиск по нику или отпечатку. Пусто — просто список. */
  query?: string;
}

export type DmPeopleResult = { ok: true; people: DmPerson[] } | { ok: false; error: 'forbidden' };

/**
 * В беседе написали. Летит ДВОИМ участникам, а не всем, — тем и отличается от
 * `chat-activity`, который рассылается по инсталляции. Превью здесь есть
 * намеренно: список переписок рисует последнюю реплику, и второй запрос ради
 * неё был бы запросом на каждое сообщение.
 */
export interface DmActivityRelay {
  slug: string;
  ts: number;
  preview: string;
  previewMine: boolean;
  peer: DmPeer;
}
```

В `ClientToServerEvents` добавить:

```ts
  /** Открыть (или найти) переписку с этим отпечатком. */
  'dm-open': (payload: DmOpenPayload, cb: (res: DmOpenResult) => void) => void;
  /** Мои переписки — спрашивается при входе в раздел. */
  'dm-list': (cb: (res: DmListResult) => void) => void;
  /**
   * Сесть в ленту беседы. Отдельная дверь от `chat-join`: канал пускает по
   * видимости в реестре, беседа — по членству в паре.
   */
  'dm-join': (payload: DmJoinPayload, cb: (res: DmJoinResult) => void) => void;
  /** Кого инсталляция видела — список для выбора собеседника. */
  'dm-people': (payload: DmPeoplePayload, cb: (res: DmPeopleResult) => void) => void;
```

В `ServerToClientEvents`:

```ts
  /** В одной из моих переписок написали. Только двоим участникам. */
  'dm-activity': (payload: DmActivityRelay) => void;
```

- [ ] **Шаг 4: Валидаторы на сервере**

В `apps/api/src/gateway/protocol.ts` рядом с прочими:

```ts
export interface DmOpenPayload {
  fingerprint?: unknown;
}

export interface DmJoinPayload {
  slug?: unknown;
}

export interface DmPeoplePayload {
  query?: unknown;
}
```

и в `LIMIT` добавить `dmQuery: 64` (длина строки поиска; отпечаток и ник короче).

- [ ] **Шаг 5: Документация протокола**

В `docs/protocol.md` — раздел «Личные сообщения» с четырьмя событиями клиента и одним
серверным, теми же словами, что в комментариях выше. Обязательно отметить, что реплики в
беседе ходят обычными `chat-*` событиями.

- [ ] **Шаг 6: Прогнать и закоммитить**

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/shared exec vitest run && pnpm --filter @relay/shared exec tsc -p tsconfig.json --noEmit'
```

```bash
git add packages/shared/src/index.ts packages/shared/src/index.test.ts apps/api/src/gateway/protocol.ts docs/protocol.md
git commit -m "feat(dm): protocol for conversations, people picker and activity"
```

---

### Задача 5: DmHandlers и проводка гейтвея

**Файлы:**

- Создать: `apps/api/src/gateway/dm.handlers.ts`
- Создать: `apps/api/src/gateway/dm.handlers.test.ts`
- Изменить: `apps/api/src/gateway/signaling.gateway.ts` (поле `dmHandlers`, четыре
  `@SubscribeMessage`, конструктор принимает `DmService`)
- Изменить: `apps/api/src/gateway/gateway.testkit.ts` (передать `DmService` в гейтвей)

**Интерфейсы:**

- Берёт: `DmService` (задача 2), `Perimeter.allow/isGuest/speaker`, `ChatSessions.enter/leave`,
  `ChatService.room/history/slug`.
- Отдаёт дальше:

```ts
class DmHandlers {
  open(client: AppSocket, payload: DmOpenPayload): Promise<DmOpenResult>;
  list(client: AppSocket): Promise<DmListResult>;
  join(client: AppSocket, payload: DmJoinPayload): Promise<DmJoinResult>;
  people(client: AppSocket, payload: DmPeoplePayload): Promise<DmPeopleResult>;
}
```

и методы гейтвея `handleDmOpen`, `handleDmList`, `handleDmJoin`, `handleDmPeople` — их зовут
тесты.

- [ ] **Шаг 1: Тест**

`apps/api/src/gateway/dm.handlers.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { asSocket } from './testkit';
import {
  connect,
  connectAs,
  makeGateway,
  personCookie,
  useGatewayStand,
} from './gateway.testkit';
import type { SignalingGateway } from './signaling.gateway';
import type { FakeServer } from './testkit';

useGatewayStand();

let gw: SignalingGateway;
let server: FakeServer;

beforeEach(async () => {
  ({ gw, server } = await makeGateway());
});

describe('открытие переписки', () => {
  it('двое приходят к одной беседе', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);

    const a = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const b = await gw.handleDmOpen(asSocket(yours), { fingerprint: me.fingerprint });

    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.conversation.slug).toBe(b.ok ? b.conversation.slug : '');
    expect(a.ok && a.conversation.peer.nick).toBe('ты');
  });

  it('гостю по инвайту ЛС не положены', async () => {
    const guest = connect(gw, server, { guest: 'токен' });
    const you = await personCookie('ты');
    const res = await gw.handleDmOpen(asSocket(guest), { fingerprint: you.fingerprint });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('без личности ЛС не положены', async () => {
    const anon = connect(gw, server, { clientId: 'устройство' });
    const you = await personCookie('ты');
    const res = await gw.handleDmOpen(asSocket(anon), { fingerprint: you.fingerprint });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('вход в беседу', () => {
  it('пускает сторону и отдаёт ей ленту', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';

    mine.clear();
    const res = await gw.handleDmJoin(asSocket(mine), { slug });

    expect(res).toEqual({ ok: true });
    expect(mine.got('chat-history')).toBe(true);
    expect((mine.last('chat-history') as { slug: string }).slug).toBe(slug);
  });

  it('не пускает третьего', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const third = await personCookie('третий');
    const mine = await connectAs(gw, server, me.cookie);
    const theirs = await connectAs(gw, server, third.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';

    const res = await gw.handleDmJoin(asSocket(theirs), { slug });

    expect(res).toEqual({ ok: false, error: 'forbidden' });
    expect(theirs.got('chat-history')).toBe(false);
  });

  it('отвечает «нет такой» на выдуманный адрес', async () => {
    const me = await personCookie('я');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmJoin(asSocket(mine), {
      slug: 'dm-ffffffffffffffffffffffff',
    });
    expect(res).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('переписка после входа', () => {
  it('реплика доходит до второй стороны обычным chat-message', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    await gw.handleDmJoin(asSocket(yours), { slug });
    yours.clear();

    await gw.handleChatMessage(asSocket(mine), { text: 'привет' });

    expect((yours.last('chat') as { text: string }).text).toBe('привет');
  });
});

describe('список и люди', () => {
  it('переписка появляется в списке обеих сторон', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });

    const forMe = await gw.handleDmList(asSocket(mine));
    const forYou = await gw.handleDmList(asSocket(yours));

    expect(forMe.ok && forMe.conversations[0].peer.nick).toBe('ты');
    expect(forYou.ok && forYou.conversations[0].peer.nick).toBe('я');
  });

  it('в списке людей нет меня самого', async () => {
    const me = await personCookie('я');
    await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const res = await gw.handleDmPeople(asSocket(mine), {});
    expect(res.ok && res.people.map((p) => p.nick)).toEqual(['ты']);
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/dm.handlers.test.ts'
```

- [ ] **Шаг 3: Реализация обработчиков**

`apps/api/src/gateway/dm.handlers.ts`:

```ts
import type { AppSocket } from './socket-data';
import type { ChatSessions } from './chat-sessions';
import type { ChatService } from './chat.service';
import type { DmService } from './dm.service';
import type { Perimeter } from './perimeter';
import { LIMIT, str, trimmed, type DmJoinPayload, type DmOpenPayload, type DmPeoplePayload } from './protocol';
import { DM_PEOPLE_LIMIT, type DmJoinResult, type DmListResult, type DmOpenResult, type DmPeopleResult } from '@relay/shared';

/**
 * Дверь в личную переписку.
 *
 * Обработчиков реплик здесь нет и не будет: сев в комнату беседы, сокет пишет
 * теми же `chat-message` / `chat-edit` / `chat-react`, что и в канале, — лента
 * у них одна на двоих (см. `chat.service`). Здесь ровно то, чем беседа от
 * канала отличается: **как в неё попасть**.
 *
 * Отличие в одном вопросе. Канал пускает по видимости в реестре: он существует
 * для всех, кому виден. Беседа не видна никому, кроме двоих, и вопрос к ней
 * другой — «ты одна из сторон?». Спутать эти два вопроса значило бы либо отдать
 * чужую переписку тому, кто угадал адрес, либо не пустить в свою собственную.
 */
export class DmHandlers {
  constructor(
    private readonly dm: DmService,
    private readonly chat: ChatService,
    private readonly chats: ChatSessions,
    private readonly perimeter: Perimeter,
  ) {}

  /**
   * Кто вправе пользоваться ЛС. Полноценная личность, и только она: у гостя по
   * инвайту личность живёт внутри одного приглашения, адресовать её потом
   * некому и незачем.
   */
  private me(client: AppSocket): string | undefined {
    if (!this.perimeter.allow(client) || this.perimeter.isGuest(client)) return undefined;
    return this.perimeter.speaker(client)?.id;
  }

  async open(client: AppSocket, payload: DmOpenPayload): Promise<DmOpenResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const fingerprint = trimmed(payload?.fingerprint, LIMIT.dmQuery);
    if (!fingerprint) return { ok: false, error: 'unknown' };

    const res = await this.dm.open(meId, fingerprint);
    if (!res.ok) return { ok: false, error: res.reason };
    return { ok: true, conversation: res.view };
  }

  async list(client: AppSocket): Promise<DmListResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    return { ok: true, conversations: await this.dm.list(meId) };
  }

  /**
   * Сесть в ленту беседы. Из прежней ленты выходим только после проверки: не
   * пустивший вход не должен выкидывать человека оттуда, где он уже сидел, —
   * ровно как в `chat-join`.
   */
  async join(client: AppSocket, payload: DmJoinPayload): Promise<DmJoinResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const slug = str(payload?.slug);
    if (!slug || !this.dm.isDm(slug)) return { ok: false, error: 'unknown' };
    if (!this.dm.isMember(slug, meId)) return { ok: false, error: 'forbidden' };

    this.chats.leave(client);
    const room = this.chat.room(slug);
    this.chats.enter(client, room, this.perimeter.nameFor(client, undefined));

    // Ленту отдаём тем же событием, что и каналу: клиент отличает беседу от
    // канала по адресу, а не по форме страницы. Закреплений в ЛС нет (см.
    // задачу 7), поэтому их счётчик всегда ноль.
    const page = await this.chat.history(slug);
    client.emit('chat-history', { slug, ...page, pins: 0 });
    this.chats.emitRoster(room);
    return { ok: true };
  }

  async people(client: AppSocket, payload: DmPeoplePayload): Promise<DmPeopleResult> {
    const meId = this.me(client);
    if (!meId) return { ok: false, error: 'forbidden' };
    const query = trimmed(payload?.query, LIMIT.dmQuery);
    return { ok: true, people: await this.dm.people(meId, query, DM_PEOPLE_LIMIT) };
  }
}
```

- [ ] **Шаг 4: Проводка в гейтвее**

В `apps/api/src/gateway/signaling.gateway.ts`:

1. `DmService` девятым параметром конструктора (`private readonly dm: DmService`).
2. Рядом с прочими наборами обработчиков:

```ts
  private readonly dmHandlers = new DmHandlers(this.dm, this.chat, this.chats, this.perimeter);
```

3. Четыре подписки (рядом с чатовыми):

```ts
  @SubscribeMessage('dm-open')
  handleDmOpen(client: AppSocket, payload: DmOpenPayload): Promise<DmOpenResult> {
    return this.dmHandlers.open(client, payload);
  }

  @SubscribeMessage('dm-list')
  handleDmList(client: AppSocket): Promise<DmListResult> {
    return this.dmHandlers.list(client);
  }

  @SubscribeMessage('dm-join')
  handleDmJoin(client: AppSocket, payload: DmJoinPayload): Promise<DmJoinResult> {
    return this.dmHandlers.join(client, payload);
  }

  @SubscribeMessage('dm-people')
  handleDmPeople(client: AppSocket, payload: DmPeoplePayload): Promise<DmPeopleResult> {
    return this.dmHandlers.people(client, payload);
  }
```

4. В `gateway.testkit.ts` передать `dmService` девятым аргументом `new SignalingGateway(...)`.

- [ ] **Шаг 5: Прогнать — зелёные**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway'
```

- [ ] **Шаг 6: Коммит**

```bash
git add apps/api/src/gateway/dm.handlers.ts apps/api/src/gateway/dm.handlers.test.ts apps/api/src/gateway/signaling.gateway.ts apps/api/src/gateway/gateway.testkit.ts
git commit -m "feat(dm): open, list, join and people handlers"
```

---

### Задача 6: Активность беседы — двоим, а не всем

**Файлы:**

- Изменить: `apps/api/src/gateway/chat.handlers.ts` (`message`, `queueChatActivity`, конструктор)
- Изменить: `apps/api/src/gateway/personal.handlers.ts` (`marksBySlug`, конструктор)
- Изменить: `apps/api/src/gateway/signaling.gateway.ts` (передать `DmService` обоим)
- Тест: `apps/api/src/gateway/dm.handlers.test.ts` (дописать), `apps/api/src/gateway/perimeter.test.ts` не трогать

**Интерфейсы:**

- Берёт: `DmService.isDm`, `DmService.membersOf`, `Perimeter.socketsOf(identityId)`.
- Отдаёт дальше: событие `dm-activity` с полезной нагрузкой `DmActivityRelay`; отметки чтения
  бесед приезжают в снимке `reads` наравне с каналами.

**Почему это отдельная задача:** сегодня `queueChatActivity` рассылает слаг канала **всем**
сокетам инсталляции. Слаг беседы, уехавший этим путём, — это «двое переписываются» на весь
дом, вместе с адресом их переписки.

- [ ] **Шаг 1: Тест**

Дописать в `apps/api/src/gateway/dm.handlers.test.ts`:

```ts
describe('активность беседы', () => {
  it('уходит двоим и не уходит третьему', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const third = await personCookie('третий');
    const mine = await connectAs(gw, server, me.cookie);
    const yours = await connectAs(gw, server, you.cookie);
    const theirs = await connectAs(gw, server, third.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    yours.clear();
    theirs.clear();

    await gw.handleChatMessage(asSocket(mine), { text: 'привет' });
    settle();

    const relay = yours.last('dm-activity') as { slug: string; preview: string; previewMine: boolean };
    expect(relay.slug).toBe(slug);
    expect(relay.preview).toBe('привет');
    // Для второй стороны реплика не «моя».
    expect(relay.previewMine).toBe(false);
    // Никакой глобальной активности с адресом беседы.
    expect(theirs.got('dm-activity')).toBe(false);
    expect(theirs.got('chat-activity')).toBe(false);
    expect(mine.all('chat-activity')).toEqual([]);
  });
});

describe('отметки чтения', () => {
  it('беседа дочитывается и отметка возвращается на другое устройство', async () => {
    const me = await personCookie('я');
    const you = await personCookie('ты');
    const mine = await connectAs(gw, server, me.cookie);
    const opened = await gw.handleDmOpen(asSocket(mine), { fingerprint: you.fingerprint });
    const slug = opened.ok ? opened.conversation.slug : '';
    await gw.handleDmJoin(asSocket(mine), { slug });
    const msg = (await gw.handleChatMessage(asSocket(mine), { text: 'привет' }), mine.last('chat')) as { ts: number };

    gw.handleReadMark(asSocket(mine), { slug, ts: msg.ts });
    await until(() => true);

    const second = await connectAs(gw, server, me.cookie, { id: 'второе', keep: true });
    const reads = second.last('reads') as { marks: Record<string, number> };
    expect(reads.marks[slug]).toBe(msg.ts);
  });
});
```

Импорты `settle` и `until` — из `./gateway.testkit`.

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway/dm.handlers.test.ts'
```

Ожидаемо: третий получил `chat-activity` с адресом беседы, `dm-activity` не приходил вовсе,
а отметка чтения беседы не доехала до второго устройства.

- [ ] **Шаг 3: Реализация — активность**

В `apps/api/src/gateway/chat.handlers.ts`:

1. Конструктор принимает `private readonly dm: DmService,` (перед `serverOf`).
2. В конце `message()` заменить блок рассылки активности на:

```ts
    const slug = this.chat.slug(room);
    // Беседа — не канал: её активность знать посторонним неоткуда, и адрес
    // переписки в общей рассылке был бы ровно тем, чего в ЛС быть не должно.
    if (this.dm.isDm(slug)) {
      this.dmActivity(slug, msg, this.perimeter.speaker(client)?.id);
      return;
    }
    const channel = this.registry.channels.find((c) => c.type === 'text' && c.slug === slug);
    const srv = channel ? this.registry.servers.find((s) => s.id === channel.serverId) : undefined;
    this.queueChatActivity(slug, msg.ts, srv?.passwordHash ? srv.id : null);
```

3. Рядом с `queueChatActivity` добавить:

```ts
  /**
   * «В твоей переписке написали» — обеим сторонам и никому больше. Без
   * коалесцирования: адресатов ровно двое, и копить тут нечего.
   *
   * Превью едет в самом событии. Иначе список переписок ходил бы за последней
   * репликой отдельным запросом — по запросу на каждое сообщение, то есть чаще
   * всего остального вместе взятого.
   */
  private dmActivity(slug: string, msg: { text: string; ts: number }, authorId: string | undefined): void {
    const members = this.dm.membersOf(slug);
    if (!members) return;
    const preview = msg.text.slice(0, DM_PREVIEW_LIMIT);
    for (const identityId of members) {
      const peerId = members.find((id) => id !== identityId) ?? identityId;
      const peer = this.dm.peerView(peerId);
      if (!peer) continue;
      for (const sock of this.perimeter.socketsOf(identityId)) {
        sock.emit('dm-activity', {
          slug,
          ts: msg.ts,
          preview,
          previewMine: authorId === identityId,
          peer,
        });
      }
    }
  }
```

4. `DmService.peerView` и `rememberNick` уже есть (задача 2). Осталось позвать второй из
   них в `PersonalHandlers.rename`: человек переименовался — подпись в чужом списке
   переписок обязана это узнать, иначе она останется прежней до перезапуска api.

- [ ] **Шаг 4: Реализация — отметки чтения**

В `apps/api/src/gateway/personal.handlers.ts`:

1. Конструктор принимает `private readonly dm: DmService,`.
2. `marksBySlug` дополняется беседами:

```ts
  private marksBySlug(marks: Map<string, number>, meId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const channel of this.registry.channels) {
      const ts = marks.get(channel.id);
      if (ts) out[channel.slug] = ts;
    }
    // У беседы id канала и слаг — одно и то же, но пройтись по ним всё равно
    // надо здесь: реестр бесед не знает, а без этой петли «прочитано на
    // десктопе» не доезжало бы до телефона ровно в личной переписке.
    for (const slug of this.dm.slugsOf(meId)) {
      const ts = marks.get(slug);
      if (ts) out[slug] = ts;
    }
    return out;
  }
```

`DmService.slugsOf` — из задачи 2, обход карты `known` с фильтром по паре.

3. В `read-mark` перевод слага в id канала: сегодня он ищет канал в реестре — добавить
`?? (this.dm.isDm(slug) ? slug : undefined)`.

- [ ] **Шаг 5: Прогнать — зелёные**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/api exec vitest run src/gateway'
```

- [ ] **Шаг 6: Коммит**

```bash
git add apps/api/src/gateway/chat.handlers.ts apps/api/src/gateway/personal.handlers.ts apps/api/src/gateway/dm.service.ts apps/api/src/gateway/dm.service.test.ts apps/api/src/gateway/dm.handlers.test.ts apps/api/src/gateway/signaling.gateway.ts
git commit -m "feat(dm): conversation activity reaches the two, not the house"
```

---

### Задача 7: Чего в беседе нет

**Файлы:**

- Изменить: `apps/api/src/gateway/chat.handlers.ts` (`pin`, `pins`, `search`)
- Изменить: `apps/api/src/gateway/mentions.ts` (`ping` — молчать в беседе)
- Тест: `apps/api/src/gateway/dm.handlers.test.ts` (дописать)

**Интерфейсы:**

- Отдаёт дальше: `chat-pin` в беседе отвечает `{ ok: false, error: 'forbidden' }`;
  `chat-search` в беседе ищет только по ней, независимо от `scope`.

- [ ] **Шаг 1: Тест**

```ts
describe('чего в беседе нет', () => {
  it('закрепить нельзя', async () => {
    const { slug, mine, id } = await conversationWithMessage();
    const res = await gw.handleChatPin(asSocket(mine), { id, pinned: true });
    expect(res).toEqual({ ok: false, error: 'forbidden' });
  });

  it('поиск не выходит за пределы переписки', async () => {
    const { slug, mine } = await conversationWithMessage();
    // На сервере есть канал с тем же словом — он не должен попасть в выдачу.
    const res = await gw.handleChatSearch(asSocket(mine), { query: 'привет', scope: 'server' });
    expect(res.ok && res.hits.every((h) => h.slug === slug)).toBe(true);
  });

  it('упоминание в беседе не растит счётчик', async () => {
    const { mine, yours } = await conversationWithMessage();
    yours.clear();
    await gw.handleChatMessage(asSocket(mine), { text: 'эй @ты' });
    expect(yours.got('mention')).toBe(false);
  });
});
```

`conversationWithMessage()` — локальный хелпер файла: заводит двоих, открывает беседу,
входит обеими сторонами, говорит «привет» и возвращает `{ slug, mine, yours, id }`.

- [ ] **Шаг 2: Прогнать — упасть**, тем же вызовом vitest для `dm.handlers.test.ts`.

- [ ] **Шаг 3: Реализация**

В `chat.handlers.ts`:

```ts
  async pin(client: AppSocket, payload: ChatPinPayload): Promise<ChatPinResult> {
    const room = this.chats.roomOf(client);
    // Закрепление — право модератора сервера. У беседы двоих сервера нет, а
    // значит нет и того, кто был бы вправе закрепить в ней чужую реплику.
    if (room && this.dm.isDm(this.chat.slug(room))) return { ok: false, error: 'forbidden' };
    // …дальше существующее тело без изменений
  }
```

`pins` — то же самое, отвечает `{ ok: true, slug, pins: [] }`.

В `search`: перед разбором `scope` добавить

```ts
    const slug = this.chat.slug(room);
    // В беседе «по серверу» означать нечего: сервера у неё нет, а расширять
    // поиск на каналы значило бы отдавать по запросу из ЛС то, что к ЛС
    // отношения не имеет.
    const channelIds = this.dm.isDm(slug) ? [slug] : this.searchScope(client, payload?.scope);
```

(существующий расчёт списка каналов вынести в `private searchScope(...)` — тело не меняется).

В `mentions.ts` метод `ping` начинается с проверки:

```ts
    // В переписке двоих упоминание не адресует: адресат и так один, и счётчик
    // «тебя звали» дублировал бы непрочитанное.
    if (this.dm.isDm(slug)) return;
```

`Mentions` получает `DmService` в конструкторе; проводка — в `signaling.gateway.ts`.

- [ ] **Шаг 4: Прогнать — зелёные** (весь `src/gateway`).

- [ ] **Шаг 5: Коммит**

```bash
git add apps/api/src/gateway/chat.handlers.ts apps/api/src/gateway/mentions.ts apps/api/src/gateway/signaling.gateway.ts apps/api/src/gateway/dm.handlers.test.ts
git commit -m "feat(dm): no pins, no mention counters, search stays inside the conversation"
```

---

### Задача 8: Веб — иконки, тулбар, вид «ЛС» в ui-сторе

**Файлы:**

- Изменить: `apps/web/components/ui/icon.tsx`
- Изменить: `apps/web/stores/ui.ts`
- Создать: `apps/web/components/layout/Toolbar.tsx`
- Изменить: `apps/web/components/layout/AppShell.tsx`
- Тест: `apps/web/stores/ui.test.ts` (создать, если нет — сейчас `stores/stores.test.ts` общий)

**Интерфейсы:**

- Отдаёт дальше:

```ts
// stores/ui.ts
export type ShellView = 'lobby' | 'voice' | 'text' | 'dm';
interface UiState {
  /** Открытая беседа: отпечаток собеседника. null — раздел открыт без переписки. */
  dmPeer: string | null;
  /** Адрес открытой беседы; null — переписка ещё не выбрана. */
  dmRoom: string | null;
  /** Раздел ЛС открыт (сайдбар подменён списком переписок). */
  dmSection: boolean;
  openDmSection: () => void;
  openDm: (slug: string, peer: string, label: string) => void;
  leaveDm: () => void;
}
```

- [ ] **Шаг 1: Тест**

`apps/web/stores/ui.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui';

beforeEach(() => {
  useUiStore.setState({
    view: 'lobby',
    textRoom: null,
    textLabel: '',
    pendingScene: null,
    stageLive: false,
    dmSection: false,
    dmRoom: null,
    dmPeer: null,
  });
});

describe('раздел ЛС', () => {
  it('открывается без выбранной переписки', () => {
    useUiStore.getState().openDmSection();
    expect(useUiStore.getState().dmSection).toBe(true);
    expect(useUiStore.getState().dmRoom).toBe(null);
    // Сцена пока прежняя: раздел открыт, переписка не выбрана.
    expect(useUiStore.getState().view).toBe('lobby');
  });

  it('переписка становится сценой', () => {
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    const s = useUiStore.getState();
    expect(s.view).toBe('dm');
    expect(s.dmRoom).toBe('dm-0123456789abcdef01234567');
    expect(s.dmPeer).toBe('fp-ты');
    expect(s.textLabel).toBe('ты');
    expect(s.mobilePanel).toBe('stage');
  });

  it('выход из раздела возвращает в лобби и забывает переписку', () => {
    useUiStore.getState().openDm('dm-0123456789abcdef01234567', 'fp-ты', 'ты');
    useUiStore.getState().leaveDm();
    const s = useUiStore.getState();
    expect(s.dmSection).toBe(false);
    expect(s.dmRoom).toBe(null);
    expect(s.view).toBe('lobby');
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть**

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/web exec vitest run stores/ui.test.ts'
```

- [ ] **Шаг 3: Реализация — стор**

В `apps/web/stores/ui.ts`:

1. `export type ShellView = 'lobby' | 'voice' | 'text' | 'dm';`
2. В `Scene` добавить `dmRoom: string | null; dmPeer: string | null;` и учесть их в
   `sameScene` (две разные переписки — две разные сцены, ровно как два канала).
3. Поля и действия:

```ts
  /**
   * Раздел ЛС открыт: сайдбар подменён списком переписок. Отдельно от сцены —
   * список остаётся на месте, пока человек ходит по перепискам, и не гаснет
   * вместе с ними.
   */
  dmSection: boolean,
  openDmSection: () => set({ dmSection: true, mobilePanel: 'nav' }),
  openDm: (slug, peer, label) => {
    set({ dmSection: true, mobilePanel: 'stage' });
    get().goScene({ view: 'dm', textRoom: null, textLabel: label, dmRoom: slug, dmPeer: peer });
  },
  leaveDm: () => {
    set({ dmSection: false });
    const { textRoom, textLabel } = sceneTarget(get());
    get().goScene({
      view: get().voiceRoom ? 'voice' : textRoom ? 'text' : 'lobby',
      textRoom,
      textLabel,
      dmRoom: null,
      dmPeer: null,
    });
  },
```

Все существующие вызовы `goScene` дополнить `dmRoom: null, dmPeer: null` — иначе переход в
канал оставит сцену ЛС висеть.

- [ ] **Шаг 4: Реализация — иконки**

В `apps/web/components/ui/icon.tsx` в `GLYPHS` (по алфавиту, рядом с `phone-off`):

```tsx
  phone: (
    <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
  ),
  'message-square': <path d="M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />,
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
```

- [ ] **Шаг 5: Реализация — тулбар**

`apps/web/components/layout/Toolbar.tsx`: рейка 64px (десктоп) / полоса из трёх целей 70px
(мобилка) с целями Direct (бейдж непрочитанного), Call, Admin; разделитель; внизу — стек лиц
«кто в сети» (пока пустой: присутствие приезжает в этапе B, и до тех пор блок не рисуется).
Цели Call и Admin — `disabled`, с тултипом `dm.soon`. Разметка и размеры — из
`reference/direct-messages/direct-messages-reference.html`, фрейм `1b`.

В `AppShell.tsx` тулбар встаёт между `ServerRail` и `Sidebar`; в режиме `dmSection` вместо
`Sidebar` рисуется `DmList` (задача 10), вместо `Members`/`OnlineMembers` — `DmPeerCard`
(задача 11).

- [ ] **Шаг 6: Прогнать — зелёные + typecheck**

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm --filter @relay/web exec vitest run && pnpm --filter @relay/web exec tsc --noEmit'
```

- [ ] **Шаг 7: Коммит**

```bash
git add apps/web/components/ui/icon.tsx apps/web/stores/ui.ts apps/web/stores/ui.test.ts apps/web/components/layout/Toolbar.tsx apps/web/components/layout/AppShell.tsx
git commit -m "feat(dm): toolbar rail and the direct messages view"
```

---

### Задача 9: Веб — стор ЛС и проводка сокета

**Файлы:**

- Создать: `apps/web/stores/dm.ts`
- Создать: `apps/web/stores/dm.test.ts`
- Изменить: `apps/web/components/providers/SocketProvider.tsx`

**Интерфейсы:**

- Отдаёт дальше (этим пользуются задачи 10–12):

```ts
interface DmState {
  conversations: DmConversation[];
  /** Непрочитанное по беседам: адрес → время последней реплики. */
  activity: Record<string, number>;
  loading: boolean;
  setConversations: (list: DmConversation[]) => void;
  /** Пришла реплика: поднять беседу наверх, обновить превью и активность. */
  applyActivity: (relay: DmActivityRelay) => void;
  /** Переписку открыли — добавить, если её ещё нет в списке. */
  remember: (conversation: DmConversation) => void;
  setLoading: (value: boolean) => void;
  reset: () => void;
}
export const useDmStore: UseBoundStore<StoreApi<DmState>>;
/** Есть ли непрочитанное в этой беседе (сверяется с отметками чтения). */
export function unreadIn(slug: string): boolean;
```

- [ ] **Шаг 1: Тест**

`apps/web/stores/dm.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useDmStore } from './dm';

const peer = { fingerprint: 'fp-ты', nick: 'ты' };
const slug = 'dm-0123456789abcdef01234567';

beforeEach(() => useDmStore.getState().reset());

describe('список переписок', () => {
  it('свежая реплика поднимает беседу наверх', () => {
    useDmStore.getState().setConversations([
      { slug: 'dm-aaaaaaaaaaaaaaaaaaaaaaaa', peer: { fingerprint: 'fp-a', nick: 'а' }, lastTs: 200, preview: 'ага', previewMine: false },
      { slug, peer, lastTs: 100, preview: 'привет', previewMine: false },
    ]);

    useDmStore.getState().applyActivity({ slug, ts: 300, preview: 'ты тут?', previewMine: false, peer });

    const list = useDmStore.getState().conversations;
    expect(list.map((c) => c.slug)).toEqual([slug, 'dm-aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(list[0].preview).toBe('ты тут?');
    expect(useDmStore.getState().activity[slug]).toBe(300);
  });

  it('реплика из беседы, которой нет в списке, заводит её', () => {
    useDmStore.getState().applyActivity({ slug, ts: 42, preview: 'привет', previewMine: false, peer });
    expect(useDmStore.getState().conversations).toHaveLength(1);
    expect(useDmStore.getState().conversations[0].peer.nick).toBe('ты');
  });

  it('открытая переписка не дублируется', () => {
    const conversation = { slug, peer, lastTs: 0, preview: '', previewMine: false };
    useDmStore.getState().remember(conversation);
    useDmStore.getState().remember(conversation);
    expect(useDmStore.getState().conversations).toHaveLength(1);
  });

  it('старая реплика не двигает список', () => {
    useDmStore.getState().setConversations([{ slug, peer, lastTs: 500, preview: 'позже', previewMine: false }]);
    useDmStore.getState().applyActivity({ slug, ts: 100, preview: 'раньше', previewMine: false, peer });
    expect(useDmStore.getState().conversations[0].preview).toBe('позже');
  });
});
```

- [ ] **Шаг 2: Прогнать — упасть.**

- [ ] **Шаг 3: Реализация стора** — по интерфейсу выше; сортировка по `lastTs` убыванием,
      `applyActivity` игнорирует `ts` не новее известного (последний случай теста).

- [ ] **Шаг 4: Проводка сокета**

В `SocketProvider.tsx`:

```ts
    socket.on('dm-activity', (relay) => {
      useDmStore.getState().applyActivity(relay);
      // Звук и заголовок вкладки — тем же путём, что и упоминание в канале:
      // личная реплика ничем не тише той, где тебя назвали.
      notifyDirect(relay);
    });
```

и эффект: при `dmSection === true` — `socket.emit('dm-list', cb)`; при смене `dmRoom` —
`socket.emit('dm-join', { slug }, cb)` (по образцу существующего эффекта на `textRoom`).
На `connect` список запрашивается заново, если раздел открыт.

- [ ] **Шаг 5: Прогнать — зелёные, коммит**

```bash
git add apps/web/stores/dm.ts apps/web/stores/dm.test.ts apps/web/components/providers/SocketProvider.tsx
git commit -m "feat(dm): conversation store and socket wiring"
```

---

### Задача 10: Веб — список переписок и выбор собеседника

**Файлы:**

- Создать: `apps/web/components/dm/DmList.tsx`
- Создать: `apps/web/components/dm/PeoplePicker.tsx`
- Создать: `apps/web/components/dm/dm-list.test.tsx`
- Изменить: `apps/web/lib/i18n/messages/en.json`, `ru.json`

**Интерфейсы:**

- Берёт: `useDmStore`, `useUiStore.openDm`, `Identicon`, `getSocket`.
- Отдаёт дальше: `DmList` рисуется на месте `Sidebar`, `PeoplePicker` открывается кнопкой «+»
  в его шапке.

- [ ] **Шаг 1: Тест**

`apps/web/components/dm/dm-list.test.tsx` (`// @vitest-environment jsdom` первой строкой):

```tsx
it('рисует лицо, ник, превью и счётчик непрочитанного', async () => {
  useDmStore.getState().setConversations([
    { slug, peer: { fingerprint: 'fp-ты', nick: 'ты' }, lastTs: 1000, preview: 'привет', previewMine: false },
  ]);
  useUnreadStore.setState({ lastRead: {}, activity: { [slug]: 1000 } });

  render(<DmList />);

  expect(screen.getByText('ты')).toBeTruthy();
  expect(screen.getByText('привет')).toBeTruthy();
  expect(screen.getByTestId('dm-unread')).toBeTruthy();
});

it('пустое состояние говорит, что здесь пока никого', () => {
  useDmStore.getState().reset();
  render(<DmList />);
  expect(screen.getByText(/пока никого|no one here yet/i)).toBeTruthy();
});
```

Способ рендера — как в существующем `components/layout/members-face.test.tsx`.

- [ ] **Шаг 2: Прогнать — упасть.**

- [ ] **Шаг 3: Реализация `DmList`** — строка 34px лицо + ник + превью + время + счётчик,
      шапка с заголовком и «+», пустое состояние, скролл; активная строка подсвечена по
      `dmRoom`. Разметка — фрейм `1b` референса.

- [ ] **Шаг 4: Реализация `PeoplePicker`** — панель 330px справа (десктоп) и bottom sheet с
      ручкой-полоской (мобилка): поиск, строки 60px (лицо, ник, короткий отпечаток, статус),
      пустой результат, `↵` открывает переписку. Данные — `dm-people`; выбор зовёт `dm-open`,
      затем `useDmStore.remember` и `useUiStore.openDm`.

- [ ] **Шаг 5: Ключи i18n** — `dm.title`, `dm.empty.title`, `dm.empty.body`, `dm.new`,
      `dm.search.placeholder`, `dm.search.empty`, `dm.you`, `dm.soon` в обе локали.

- [ ] **Шаг 6: Прогнать — зелёные, коммит**

```bash
git add apps/web/components/dm apps/web/lib/i18n/messages/en.json apps/web/lib/i18n/messages/ru.json
git commit -m "feat(dm): conversation list and people picker"
```

---

### Задача 11: Веб — переписка и карточка собеседника

**Файлы:**

- Создать: `apps/web/components/dm/DmThread.tsx`
- Создать: `apps/web/components/dm/DmPeerCard.tsx`
- Изменить: `apps/web/components/stage/Stage.tsx` (ветка `view === 'dm'`)
- Изменить: `apps/web/components/layout/Topbar.tsx` (шапка беседы)
- Изменить: `apps/web/lib/i18n/messages/*.json`

**Интерфейсы:**

- Берёт: `ChatPanel` — лента, композер, вложения, реакции и правки переиспользуются целиком;
  `DmThread` — обёртка, которая даёт ей шапку беседы и честную строку внизу.
- Отдаёт дальше: сцена `dm` в `Stage`.

**Важно:** второй ленты не заводим. `ChatPanel` уже читает `useChatStore`, а он наполняется
теми же `chat-history` / `chat` событиями, которые приходят и в беседе. Если по ходу
выяснится, что `ChatPanel` завязан на реестр каналов (ищет `Channel` по слагу ради заголовка
или прав), — это правится параметром «канал или беседа», а не копией компонента.

- [ ] **Шаг 1: Тест**

```tsx
it('шапка беседы показывает лицо, ник и короткий отпечаток', () => { /* … */ });
it('внизу сказано, что переписку видит владелец сервера', () => {
  render(<DmThread />);
  expect(screen.getByText(/владел|owner/i)).toBeTruthy();
});
```

- [ ] **Шаг 2: Прогнать — упасть.**

- [ ] **Шаг 3: Реализация `DmThread`** — шапка (лицо 34px, ник, короткий отпечаток, статус),
      `ChatPanel` внутри, под композером строка `dm.privacy` — та самая честная фраза.

- [ ] **Шаг 4: Реализация `DmPeerCard`** — правая колонка 232px: лицо 64px, ник, отпечаток,
      присутствие (в этапе A — «неизвестно», приедет в B), кнопка «Call» выключена с
      тултипом `dm.soon`.

- [ ] **Шаг 5: Ключи i18n** — `dm.privacy` («Личные сообщения адресованы одному человеку, но
      не скрыты от владельца инсталляции»), `dm.header.status.unknown`.

- [ ] **Шаг 6: Прогнать, коммит**

```bash
git add apps/web/components/dm apps/web/components/stage/Stage.tsx apps/web/components/layout/Topbar.tsx apps/web/lib/i18n/messages
git commit -m "feat(dm): the conversation scene and the peer card"
```

---

### Задача 12: Мобилка, реакция на события и e2e

**Файлы:**

- Изменить: `apps/web/components/layout/MobileNav.tsx`
- Изменить: `apps/web/components/layout/AppShell.tsx`
- Создать: `e2e/tests/dm.spec.ts`
- Изменить: `docs/plans/relay-2.0.md` (отметить этап 1 сделанным)

- [ ] **Шаг 1: e2e-тест**

`e2e/tests/dm.spec.ts` — по образцу `e2e/tests/personal.spec.ts` (два контекста браузера,
свежий Chromium ради Ed25519):

```ts
test('двое переписываются, история переживает перезагрузку', async ({ browser }) => {
  const { page: alice, fingerprint: aliceFp } = await signIn(browser, 'Алиса');
  const { page: bob, fingerprint: bobFp } = await signIn(browser, 'Боб');

  await alice.getByTestId('toolbar-direct').click();
  await alice.getByTestId('dm-new').click();
  await alice.getByPlaceholder(/search people|поиск/i).fill(bobFp.slice(0, 6));
  await alice.getByText('Боб').click();
  await alice.getByTestId('chat-composer').fill('привет');
  await alice.keyboard.press('Enter');

  await bob.getByTestId('toolbar-direct').click();
  await expect(bob.getByText('привет')).toBeVisible();

  await bob.reload();
  await bob.getByTestId('toolbar-direct').click();
  await bob.getByText('Алиса').click();
  await expect(bob.getByText('привет')).toBeVisible();
});

test('третий адрес беседы не открывает', async ({ browser }) => {
  // Карла знает адрес (подсмотрела) — и всё равно получает отказ.
});
```

- [ ] **Шаг 2: Прогнать e2e — упасть** (по схеме `infra/docker-compose.e2e.yml`, обязательно
      со своим `-p`, чтобы `down -v` не снёс тома локальной установки).

- [ ] **Шаг 3: Мобильные экраны** — полоса тулбара под именем сервера на экране каналов,
      шапка 52px с шевроном и контекстным действием, bottom sheet выбора собеседника, цели
      ≥44px. Кадры `2a`–`2d` референса.

- [ ] **Шаг 4: Прогнать e2e и юнит — зелёные.**

- [ ] **Шаг 5: Полный гейт**

```bash
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

- [ ] **Шаг 6: Коммит**

```bash
git add apps/web/components/layout/MobileNav.tsx apps/web/components/layout/AppShell.tsx e2e/tests/dm.spec.ts docs/plans/relay-2.0.md
git commit -m "feat(dm): mobile screens and the two-people e2e run"
```

---

## Готово, когда

- Двое переписываются, история переживает рестарт стека (этап 1 плана 2.0).
- Третий, знающий адрес беседы, получает отказ — и в `dm-join`, и в ленте.
- Адрес беседы не появляется ни в одной рассылке «на всех»: ни в `channels`, ни в
  `chat-activity`.
- Полная перезапись реестра не удаляет ни одной беседы.
- Ретенция подметает беседы наравне с каналами (общий срок, без отдельной машинерии).
- Раздел ЛС работает на 375 и на 1280, в обеих темах и обеих локалях.
- Честная строка про владельца инсталляции стоит в переписке, а не только в документации.

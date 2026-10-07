# Архитектурная расчистка — план

> **Для исполнителя-агента:** обязательный навык — superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans. Шаги — чекбоксы `- [ ]`.

**Цель:** убрать три места, по которым ревьюер первым делом сочтёт архитектуру
слабой: продублированный контракт, гейтвей-композицию в обход DI и голосовой
клиент на глобальных переменных модуля.

**Подход:** три фазы, каждая сливается в `main` отдельно и оставляет систему
рабочей. Фаза 1 расписана до шага. Фазы 2 и 3 — до задачи с файлами и критерием
приёмки; **перед стартом каждой пишется свой детальный план** (тем же навыком),
потому что её точная нарезка зависит от того, как ляжет фаза 1.

**Стек:** pnpm 9 + turbo, NestJS 11 (CommonJS, `tsc`), Next 15, vitest 2,
Postgres 18, mediasoup.

## Глобальные ограничения

- Всё — через Docker (`node:20-alpine`, репозиторий смонтирован в `/mono`).
  Хостовые `pnpm`/`node` не запускать. `pnpm install` в bind-mount виснет —
  ставить зависимости в слой образа (`relay-mono-deps`) или `--lockfile-only`.
- Протокол на проводе не меняется: `PROTOCOL_VERSION` остаётся `1`, имена
  событий и формы тел — те же. Нативные клиенты и десктоп 2.0.x продолжают
  работать с сервером после каждой фазы.
- Коммиты — на английском, conventional commits, по одному на задачу.
  Стейджить явные пути, не каталоги.
- Без релиза: фазы сливаются в `main`, версии не поднимаются (см. правила
  релиза, ловушка `:latest`).
- `pnpm lint`, `pnpm format:check`, `pnpm docs:check`,
  `pnpm turbo run typecheck test build` — зелёные после каждой задачи.
- `clients/ios` не трогаем.

### Как гонять проверки

```bash
# всё сразу, как в CI (база для тестов api — отдельным контейнером)
docker run -d --name relay-pg -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay -e POSTGRES_DB=relay_test -p 5432:5432 postgres:18-alpine
docker run --rm -v "$PWD":/mono -w /mono -e TEST_DATABASE_URL=postgresql://relay:relay@host.docker.internal:5432/relay_test relay-mono-deps:latest sh -c 'pnpm turbo run typecheck test build'
```

Пакетно, быстрее: `-w /mono/apps/api` и `sh -c './node_modules/.bin/vitest run <файл>'`.

---

## Фаза 1 — один контракт ✅

> **Сделано** в ветке `refactor/one-contract` (2026-10-07). Отличия от плана:
> протокол SFU стал картой запросов `SfuRequests` (событие → тело, ответ), и
> `ask()` веба типизирован по ней; `Untrusted<T>` переехал в shared — им
> пользуются оба сервера; `turbo.json` не упростился, а починился: тесты
> shared законно читают api и web, и web во входах задачи не было.
>
> **Найдено по дороге** (в следующие фазы):
> - тесты api не проходят `tsc` вовсе — `tsconfig.json` их исключает, и
>   ошибок типов в них накопилось много (`directory.channels.test.ts`,
>   `chat.service.test.ts`, `import.meta` в CommonJS). Нужен
>   `tsconfig.test.json` и шаг в CI;
> - сервер socket.io в api не типизирован (`AppServer` на `DefaultEventsMap`),
>   хотя `ClientToServerEvents`/`ServerToClientEvents` в контракте есть.
>   Типизировать — естественный первый шаг фазы 2: после него `emit` с не
>   тем именем или телом не соберётся.

**Проблема.** api не импортирует `@relay/shared`, потому что пакет отдаётся
сырым ESM-TypeScript (`main: ./src/index.ts`), а api — CommonJS под `tsc` с
`rootDir: ./src`. Поэтому у api копии: `gateway/protocol.ts` (1107 строк),
`settings/catalog.ts` (1558), `gateway/ring-machine.ts` (207),
`identity/crypto.ts` (189). Сверяют их тесты, читающие исходники api как текст
регулярками ([index.test.ts](../../packages/shared/src/index.test.ts)), а turbo
ради них держит особые `inputs`. Протокол SFU — третья копия:
`apps/sfu` ↔ `apps/web/lib/voice/sfu/protocol.ts`.

**Результат.** shared собирается в CommonJS + `.d.ts`; api и sfu импортируют
его как обычную зависимость; копии удалены; текстовые сверки удалены — их
работу делает компилятор.

**Что остаётся раздельным намеренно:** `auth` (у api секрет инсталляции,
синхронная проверка на `node:crypto`, адресная дверь; у shared — асинхронный
Web Crypto для Edge-middleware Next). Это две реализации одного формата, а не
копия. Их текстовую сверку меняем на поведенческую: токен, выпущенный одной,
проверяется другой.

### Карта файлов

| Файл | Что с ним |
|---|---|
| `packages/shared/package.json` | `exports` с условиями, `files`, сборка CJS |
| `packages/shared/tsconfig.build.json` | новый: CJS + декларации в `dist/` |
| `apps/api/package.json`, `apps/sfu/package.json` | `"@relay/shared": "workspace:*"` |
| `apps/api/Dockerfile`, `apps/sfu/Dockerfile` | собирать shared до сервиса, класть `dist` в runtime |
| `apps/api/src/gateway/protocol.ts` | остаются только разборщики тел (`str`, `trimmed`, `optional`) и серверные константы; типы и `LIMIT` — реэкспорт из shared |
| `apps/api/src/settings/catalog.ts` | удалить, импорт из shared |
| `apps/api/src/gateway/ring-machine.ts` | удалить, импорт из shared |
| `apps/api/src/identity/crypto.ts` | оставить только проверку подписи на `node:crypto`; кодирование и отпечаток — из shared |
| `packages/shared/src/sfu.ts` | новый: протокол медиасервера |
| `apps/web/lib/voice/sfu/protocol.ts` | реэкспорт из shared + клиентские пресеты кодеков |
| `packages/shared/src/*.test.ts` | удалить текстовые сверки с api |
| `turbo.json` | удалить `@relay/shared#test` с `inputs` на api |
| `docs/architecture.md`, `docs/backend.md`, `docs/protocol.md` | раздел «Контракт и его копии» → «Контракт» |

### Task 1.1: shared собирается в CommonJS и подключается к api

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.build.json`
- Modify: `apps/api/package.json`, `apps/api/Dockerfile`
- Create: `apps/api/src/shared-link.test.ts`

**Produces:** `require('@relay/shared')` работает из api в рантайме и в `tsc`;
web продолжает брать исходник через `transpilePackages`.

- [ ] **Step 1: Тест-канарейка в api**

```ts
// apps/api/src/shared-link.test.ts
import { describe, expect, it } from 'vitest';
import { APP_NAME, PROTOCOL_VERSION } from '@relay/shared';
import { PROTOCOL_VERSION as API_PROTOCOL } from './gateway/protocol';

describe('@relay/shared из api', () => {
  it('пакет резолвится и отдаёт контракт', () => {
    expect(APP_NAME).toBe('relay');
    expect(PROTOCOL_VERSION).toBe(API_PROTOCOL);
  });
});
```

- [ ] **Step 2: Убедиться, что падает** — `vitest run src/shared-link.test.ts`
  в `apps/api`: `Cannot find package '@relay/shared'`.

- [ ] **Step 3: Сборка shared**

```json
// packages/shared/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "./dist",
    "declaration": true,
    "isolatedModules": false
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

В `packages/shared/package.json`:

```json
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"files": ["dist", "src"],
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "require": "./dist/index.js",
    "import": "./src/index.ts",
    "default": "./src/index.ts"
  }
},
"scripts": {
  "build": "tsc -p tsconfig.build.json",
  ...
}
```

Удалить `"type": "module"` — иначе `.js` в `dist` будет читаться как ESM.
Проверить, что тесты shared (vitest) и web (`transpilePackages`, vitest)
по-прежнему берут `src` через условие `import`.

- [ ] **Step 4: Зависимость api.** В `apps/api/package.json` →
  `"@relay/shared": "workspace:*"`; обновить lockfile в контейнере:
  `pnpm install --lockfile-only`; пересобрать `relay-mono-deps`.

- [ ] **Step 5: Dockerfile api.** В стадии `builder`:
  `RUN pnpm --filter "@relay/api..." build` (с зависимостями). В стадии
  `pruner` до `pnpm deploy`:
  `COPY --from=builder /mono/packages/shared/dist ./packages/shared/dist`.

- [ ] **Step 6: Проверка** — тест-канарейка зелёный; `typecheck` и `build` api
  зелёные; `docker build -f apps/api/Dockerfile -t relay-api:check .` и
  `docker run --rm --entrypoint node relay-api:check -e "console.log(require('@relay/shared').APP_NAME)"`
  печатает `relay`.

- [ ] **Step 7: Commit** —
  `build(shared): ship CommonJS build and consume it from api`.

### Task 1.2: протокол api — из shared

**Files:**
- Modify: `apps/api/src/gateway/protocol.ts`, все его импортёры (`grep -rl "from './protocol'" apps/api/src`)
- Modify: `packages/shared/src/index.test.ts`

**Consumes:** Task 1.1. **Produces:** `protocol.ts` содержит только
`str`, `trimmed`, `optional`, `ANON_NAME`, `SYSTEM_ACTOR_NICK`,
`UNKNOWN_ACTOR_NICK` и реэкспорт.

- [ ] **Step 1:** В начало `protocol.ts` — `export * from '@relay/shared';`.
  Затем удалять продублированные блоки **по одному** (типы ответов, причины
  отказов, `LIMIT`, `PROTOCOL_VERSION`), после каждого — `tsc --noEmit` в api.
  Ошибка типа означает настоящее расхождение копий: чинить в shared (это
  источник правды для клиентов), записывая находку в сообщение коммита.
- [ ] **Step 2:** Если в shared нет чего-то, что было в копии api и уходит
  клиенту, — перенести в shared, а не оставлять в api.
- [ ] **Step 3:** Удалить из `index.test.ts` тесты, читающие `apiSource(...)`;
  оставить тесты поведения самого shared.
- [ ] **Step 4:** Полный прогон api + shared. Тесты гейтвея
  (`*.handlers.test.ts`, `signaling.gateway.test.ts`) — главная гарантия, что
  провод не поменялся.
- [ ] **Step 5: Commit** — `refactor(api): take the wire contract from @relay/shared`.

### Task 1.3: каталог настроек, машина вызова, крипто личности

**Files:**
- Delete: `apps/api/src/settings/catalog.ts`, `apps/api/src/gateway/ring-machine.ts`
- Modify: `apps/api/src/identity/crypto.ts`, импортёры удалённых файлов
- Modify: `packages/shared/src/settings.test.ts`, `ring.test.ts`, `consumers.test.ts`

- [ ] **Step 1:** Перед удалением `catalog.ts` — убедиться, что он совпадает с
  `shared/settings.ts` по смыслу: `diff <(sed 's/^ *//' apps/api/src/settings/catalog.ts) <(sed 's/^ *//' packages/shared/src/settings.ts)`.
  Серверные отличия (если есть: `env`, `SEEDED_FROM_ENV`) переносятся в shared
  как поля спецификации — каталог один.
- [ ] **Step 2:** Импортёров перевести на `@relay/shared`, удалить файл, `tsc`.
- [ ] **Step 3:** То же для `ring-machine.ts`.
- [ ] **Step 4:** `identity/crypto.ts`: кодирование base64url, отпечаток и
  текст подписываемого сообщения — из shared (в Node 20 есть глобальные
  `crypto.subtle` и `btoa`). Оставить только `verify` на `webcrypto`.
  Существующие тесты `identity.service.test.ts` и `devices.test.ts` должны
  пройти без правок — они и есть доказательство, что байты те же.
- [ ] **Step 5:** `consumers.test.ts` читает исходники api, чтобы найти
  читателя каждого параметра, — эта проверка законна (она про использование,
  а не про копию), оставить.
- [ ] **Step 6:** Текстовые сверки в `settings.test.ts`/`ring.test.ts` удалить.
- [ ] **Step 7: Commit** — `refactor(api): drop settings catalog, ring machine and crypto copies`.

### Task 1.4: auth — поведенческая сверка вместо текстовой

**Files:**
- Create: `apps/api/src/auth/auth-compat.test.ts`
- Modify: `packages/shared/src/auth.test.ts` (удалить сверку текста с api, если есть)

- [ ] **Step 1: Тест**

```ts
// apps/api/src/auth/auth-compat.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import * as edge from '@relay/shared';
import { issueToken, verifyToken, resetSiteSecret, useSiteSecret } from './auth';

// Next проверяет куку на Edge кодом shared, api — своим. Формат один:
// выпущенное одной стороной обязано приниматься другой.
describe('relay_pass: api ↔ edge', () => {
  afterEach(() => resetSiteSecret());

  it('токен api принимается edge-проверкой', async () => {
    useSiteSecret(() => ({ kind: 'plain', value: 'pw' }));
    const { value } = issueToken();
    expect(await edge.verifyToken(value, 'pw')).toBe(true);
  });

  it('токен edge принимается api', async () => {
    useSiteSecret(() => ({ kind: 'plain', value: 'pw' }));
    const { value } = await edge.issueToken('pw');
    expect(verifyToken(value)).toBe(true);
  });
});
```

Добавить такую же пару для гостевого токена (`issueGuestToken`/`verifyGuestToken`). Секрет вида `{ kind: 'hash' }` (пароль из панели) проверить отдельно: какую строку получает edge-middleware в этом случае — см. `apps/web/middleware.ts`.

- [ ] **Step 2:** Прогнать — должен пройти сразу (формат уже совместим). Если
  падает — это найденная ошибка совместимости, чинить до продолжения.
- [ ] **Step 3: Commit** — `test(auth): check api and edge tokens against each other`.

### Task 1.5: протокол SFU в shared

**Files:**
- Create: `packages/shared/src/sfu.ts`
- Modify: `packages/shared/src/index.ts` (`export * from './sfu'`)
- Modify: `apps/web/lib/voice/sfu/protocol.ts`, `apps/sfu/src/gateway/sfu.gateway.ts`, `apps/sfu/package.json`, `apps/sfu/Dockerfile`

- [ ] **Step 1:** В `sfu.ts` — только провод: `Source`, `ProducerInfo`,
  `PeerSnapshot`, `WelcomePayload`, `ConsumerPayload`, `ConsumerLayers`, `Ack`,
  имена событий. Типы mediasoup в shared не тащить: где нужны
  `RtpParameters`, объявить структурный тип `unknown`-полями или дженериком.
  Пресеты кодеков (`CAM_ENCODINGS`, `MIC_CODEC_OPTIONS`, …) — клиентские,
  остаются в web.
- [ ] **Step 2:** web: `protocol.ts` реэкспортирует провод из shared.
- [ ] **Step 3:** sfu: зависимость `workspace:*`, Dockerfile по образцу Task 1.1
  Step 5, гейтвей типизирует тела событий типами shared.
- [ ] **Step 4:** `sfu.gateway.test.ts`, `apps/web/lib/voice/sfu/*.test.ts`,
  сборка и смоук образа sfu (как в CI) — зелёные.
- [ ] **Step 5: Commit** — `refactor(sfu): share the media-server protocol with web`.

### Task 1.6: turbo и документация

- [ ] Удалить из `turbo.json` блок `@relay/shared#test` с `inputs` на api
  вместе с комментарием.
- [ ] `docs/architecture.md`: раздел «Контракт и его копии» переписать —
  shared импортируют web, api и sfu; раздельно только `auth`, и почему.
  Диаграмму поправить.
- [ ] `docs/backend.md` «Как добавить событие»: убрать шаг «копию ответа — в
  `gateway/protocol.ts`».
- [ ] `pnpm docs:check`, полный прогон, `docker build` всех трёх образов,
  e2e-стек (`docker compose -f docker-compose.yml -f infra/docker-compose.e2e.yml up -d --build` + Playwright).
- [ ] **Commit** — `docs: one contract package for web, api and sfu`.

**Приёмка фазы 1:** `grep -rn "apiSource\|readFileSync" packages/shared/src/*.test.ts`
находит только `consumers.test.ts`; файлов `catalog.ts` и `ring-machine.ts` в
api нет; e2e зелёный.

---

## Фаза 2 — гейтвей на модулях Nest

**Проблема.** [`signaling.gateway.ts`](../../apps/api/src/gateway/signaling.gateway.ts)
(1148 строк) получает 13 сервисов через DI и вручную в полях строит ещё ~15
объектов (`Perimeter`, `Directory`, `ChatSessions`, `VoiceSessions`,
`Presence`, `Rings`, `Mentions`, `Moderation`, 8 наборов `*Handlers`).
Порядок полей = порядок инициализации; замыкания ссылаются на поля, объявленные
ниже. Nest используется ради декораторов, а не ради DI.

**Результат.** Владельцы состояния и обработчики — провайдеры Nest в
модулях по доменам; гейтвеи — тонкие роутеры `@SubscribeMessage → handler`;
граф зависимостей виден в `*.module.ts`, а не в порядке полей.

### Ключевое решение: как раздать `server`

Сейчас все получают `() => this.server`. Вводим провайдер:

```ts
// apps/api/src/gateway/socket-server.ts
@Injectable()
export class SocketServer {
  private io?: AppServer;
  attach(io: AppServer): void { this.io = io; }
  get(): AppServer {
    if (!this.io) throw new Error('socket.io server is not attached yet');
    return this.io;
  }
}
```

Гейтвей в `afterInit(io)` делает `socketServer.attach(io)`. Все, кто брал
`() => this.server`, берут `SocketServer` через DI и зовут `.get()` — то есть
семантика «спросить в момент использования» сохраняется.

### Целевая раскладка

```
gateway/
  core.module.ts        SocketServer, Perimeter, Directory, BackgroundWork
  chat/chat.module.ts   ChatSessions, ChatHandlers, Mentions
  voice/voice.module.ts VoiceSessions, VoiceHandlers, Presence
  calls/calls.module.ts Rings, RingHandlers
  dm/dm.module.ts       DmHandlers (+ DmService)
  moderation/…          Moderation, ModerationHandlers, GuestHandlers
  admin/…               AdminHandlers
  registry/…            RegistryHandlers (+ RegistryService)
  signaling.gateway.ts  подключение/отключение + маршруты
```

Циклы, которые сейчас разрешает порядок полей (`Rings.markMissed → ChatHandlers`,
`VoiceSessions.onGraceExpired → ChatSessions`, `onVoiceChanged → Presence`),
переводятся на события: внутренняя шина (`@nestjs/event-emitter` или свой
`EventEmitter`-провайдер) с типизированными событиями `voice.left`,
`voice.changed`, `call.missed`. Это и разрывает цикл, и делает связь видимой.

### Задачи (детальный план пишется перед стартом)

1. **`SocketServer` + `CoreModule`.** Перевести `Perimeter` и `Directory` в
   провайдеры. Критерий: `gateway.testkit.ts` собирает их через
   `Test.createTestingModule`, все тесты гейтвея зелёные без правок ожиданий.
2. **Внутренняя шина событий.** Три события выше, типы в одном файле.
   Критерий: в конструкторах владельцев нет колбэков на соседей.
3. **Модули по доменам** — по одному на коммит, в порядке: registry → chat →
   dm → voice → calls → moderation → admin. Критерий для каждого: модуль
   импортируется в `AppModule`, гейтвей получает его обработчики через DI,
   тесты домена зелёные.
4. **Гейтвей-роутер.** Критерий: в `signaling.gateway.ts` нет `new`, файл
   < 400 строк, каждый `@SubscribeMessage` — одна строка делегирования.
5. **Документация** `docs/backend.md`: раздел про гейтвей описывает модули, а
   не порядок полей.

**Риски.** Тесты гейтвея завязаны на `gateway.testkit.ts` — если он строит
гейтвей через `new SignalingGateway(...)`, его переписывают первым (задача 1)
и дальше не трогают. Поведение `connectionStateRecovery` и грейса выхода
проверяется существующими `voice-sessions.test.ts` — их нельзя ослаблять.

---

## Фаза 3 — голосовая сессия как машина состояний

**Проблема.** [`lib/voice.ts`](../../apps/web/lib/voice.ts) (1155 строк) держит
~25 изменяемых переменных модуля (`room`, `transport`, `roomMode`,
`sfuMisses`, `sfuOutage`, `migration`, `splitHandled`, `settleUntil`,
`serverLostTimer`, …) — неявный автомат, переходы которого нигде не названы.
Так же устроены `voice/mic.ts`, `voice/camera.ts`, `voice/output.ts`. Именно
здесь жили гонки переключения mesh↔SFU.

**Результат.** `VoiceSession` — класс с явным состоянием и таблицей
переходов, один экземпляр на вход в комнату; UI читает состояние из
`stores/voice` через подписку; переменных уровня модуля в `lib/voice*` нет,
кроме ссылки на текущую сессию.

### Состояния

```
idle ─join→ joining ─ok→ live(mesh|sfu) ─split/outage→ migrating ─ok→ live(…)
  ▲            │fail            │leave/kick              │fail
  └────────────┴────────────────┴──────→ leaving ─done→ idle
                                 server-lost → reconnecting ─ok→ live / ─timeout→ leaving
```

Образец стиля — уже существующая `packages/shared/src/ring.ts`: чистая функция
`next(state, event) → { state, effects }`, эффекты исполняет оболочка.

### Задачи (детальный план пишется перед стартом)

1. **Чистая машина** `apps/web/lib/voice/session-machine.ts`: состояния,
   события, `next()`. Таблица переходов покрыта тестами, включая сценарии
   из `voice-switching.test.ts` и `voice-fallback.test.ts` (переносятся как
   последовательности событий). Без DOM и сокета.
2. **`VoiceSession`** — оболочка: исполняет эффекты (`openTransport`,
   `closeTransport`, `emit`, таймеры), владеет таймерами и транспортами.
   Таймеры — через инъектируемые часы, чтобы тесты не спали.
3. **Перевод `voice.ts` на `VoiceSession`** при неизменных экспортах
   (`joinVoice`, `leaveVoice`, `toggleMic`, …) — компоненты не меняются.
   Критерий: unit-тесты web и e2e (`e2e/tests`, сценарии звонка двумя людьми
   и переключения на SFU) зелёные.
4. **`mic`/`camera`/`output`** — то же, по одному на коммит: состояние в
   экземпляре, принадлежащем сессии.
5. **Живой прогон** звонка web↔web и web↔десктоп через SFU и mesh на стенде
   (e2e-стек), включая моргание сети — то, что юнитами не ловится.

**Риски.** Это код с самой богатой историей ловушек (см. `docs/media.md`).
Переписывание без изменения поведения: каждая заплатка с комментарием «почему»
в старом коде должна найти себе переход или эффект в машине — список
сверяется перед удалением старого файла.

---

## Порядок и объём

| Фаза | Зависит от | Оценка |
|---|---|---|
| 1. Один контракт | — | 1–2 дня |
| 2. Модули Nest | 1 (типы из shared) | 3–4 дня |
| 3. Машина голоса | — (можно параллельно с 2) | 4–6 дней |

Остальные пункты ревью (конфиг через `env.ts` с валидацией, разбор
`SocketProvider` по сторам, удаление переезда 0.x, `ANON_NAME` на сервере,
dev-compose с горячей перезагрузкой) — мелкие, делаются отдельными
задачами после фаз или попутно, если фаза их задевает.

# Участие в разработке relay

Спасибо за интерес к проекту! Ниже — как поднять окружение, что проверять перед
PR и каких соглашений придерживаться.

## Окружение

JS-часть — монорепо **pnpm workspaces + Turborepo**. Локальный Node не обязателен:
все сервисы работают в Docker.

```bash
# Dev-стек (hot-reload, self-signed TLS) → https://localhost
docker compose -f infra/docker-compose.dev.yml up
```

Если предпочитаете локальный тулчейн — нужен Node ≥ 20 и pnpm 9
(`corepack enable && pnpm install`).

## Проверки перед PR

Прогоните тот же набор, что и CI (`typecheck → unit → build`). Тесты api
работают с настоящей базой — с 1.0 хранилище и есть проверяемое поведение
(курсор ленты, каскады, ретенция), и подделка в памяти проверяла бы подделку:

```bash
docker compose -f infra/docker-compose.dev.yml up -d db
docker run --rm --network relay-dev_default -v "$PWD":/mono -w /mono \
  -e TEST_DATABASE_URL=postgresql://relay:relay@db:5432/relay_test node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

Второй прогон подряд может упасть россыпью `TS6053: File
'.next/types/…' not found` — это не ваша правка. `typecheck` веба включает
`.next/types/**`, а идущий рядом `build` эту папку пересоздаёт: список файлов
успевает устареть. В CI не воспроизводится (там чекаут чистый, `.next` нет);
локально лечится `rm -rf apps/web/.next` перед прогоном или запуском `build`
отдельной командой.

E2e (Playwright) гоняются в CI на каждый push; локально — по схеме из
`infra/docker-compose.e2e.yml`. Учтите: проект compose называется `relay`, тот
же, что и у прод-стека из корневого `docker-compose.yml`, — то есть `down -v`
после e2e сносит тома `relay_uploads` и `relay_caddy_data` вашей локальной
установки. Если она вам нужна, гоняйте e2e с отдельным `-p`.

Документация проверяется отдельно: ссылки из `docs/` и README на файлы
репозитория должны существовать, а каждое socket-событие — быть описано в
[docs/protocol.md](docs/protocol.md) или [docs/media.md](docs/media.md):

```bash
node tools/check-docs.mjs   # или pnpm docs:check
```

Форматирование и линт:

```bash
pnpm format:check   # prettier
pnpm lint           # eslint
```

Зависимости — отдельным гейтом, он тоже стоит в CI:

```bash
pnpm audit --prod --audit-level=high
```

`--prod` намеренно: плохая dev-зависимость — испорченный вечер, плохая
рантайм-зависимость уезжает на чужой сервер. Гейт может стать красным без
вашей правки — совет опубликовали против кода, который не менялся; чинится это
подъёмом версии. Когда исправление выше по дереву, за пином, который мы не
контролируем, — `pnpm.overrides` в корневом `package.json` (сейчас там два:
`postcss` и `sharp`, оба зажаты пинами Next; почему — в
[docs/plans/old/pre-1.0-audit.md](docs/plans/old/pre-1.0-audit.md), раздел B6). Когда
патча нет вовсе — `pnpm.auditConfig.ignoreCves`, но это решение, которое видно
в диффе.

## Стиль и соглашения

- **Контракт клиент↔сервер** живёт в `packages/shared` (типы, socket-события,
  токены, каталог настроек). api его не импортирует и держит копии
  (`gateway/protocol.ts`, `settings/catalog.ts`, `gateway/ring-machine.ts`,
  `identity/crypto.ts`) — совпадение сверяют тесты `packages/shared`. Меняете
  формат сообщений — правьте обе половины и [docs/protocol.md](docs/protocol.md),
  держите web-клиент эталонной реализацией. Подробно —
  [docs/architecture.md](docs/architecture.md#контракт-и-его-копии).
- **Сиды серверов/каналов** дублируются во фронте (`apps/web/lib/constants.ts`) и
  в реестре api (`apps/api/src/gateway/registry.service.ts`) — id и slug обязаны
  совпадать байт-в-байт.
- Комментарии и UI — на русском, в тон существующему коду; нейтральная лексика,
  без внутренних шуток.
- Коммиты — в стиле Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`).

## Pull request

1. Ветку от `main`, изменения по одной теме.
2. Зелёные `typecheck`/`test`/`build` (см. выше).
3. Описание: что и зачем; если менялся протокол — отметьте это явно.

## Лицензия

Отправляя PR, вы соглашаетесь, что ваш вклад распространяется под лицензией
[MIT](LICENSE).

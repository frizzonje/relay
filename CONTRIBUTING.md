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

Прогоните тот же набор, что и CI (`typecheck → unit → build`):

```bash
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

E2e (Playwright) гоняются в CI на каждый push; локально — по схеме из
`infra/docker-compose.e2e.yml`.

Форматирование и линт:

```bash
pnpm format:check   # prettier
pnpm lint           # eslint
```

## Стиль и соглашения

- **Контракт клиент↔сервер** живёт в `packages/shared` (типы, socket-события,
  HMAC-auth) и в [docs/protocol.md](docs/protocol.md). Меняете формат сообщений —
  правьте оба места и держите web-клиент референс-реализацией.
- **Сиды серверов/каналов** дублируются во фронте (`apps/web/lib/constants.ts`) и
  в gateway (`apps/api/src/gateway/signaling.gateway.ts`) — id и slug обязаны
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

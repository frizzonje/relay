# relay

🇬🇧 [Read this in English](README.md)

Self-hosted платформа для приватной голосовой, видео- и текстовой связи небольшой группы. Mesh-WebRTC звонки без медиасервера, текстовые каналы с вложениями и реакциями, доступ по общему паролю, TLS из коробки.

## Возможности

- **Голос и видео** — mesh-WebRTC (P2P, до ~6–7 участников), камера, демонстрация экрана, индикаторы mute/deafen
- **Текстовые каналы** — история сообщений, вложения до 25 МБ, реакции
- **Серверы и каналы** — создание/удаление на лету, опциональный пароль на сервер, общий реестр для всех участников
- **Закрытый контур** — единый пароль входа (HMAC-кука), один origin за Caddy, автоматический TLS
- **TURN-профиль** — coturn для звонков через строгие NAT (мобильные сети, CGNAT)

## Структура репозитория

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand)
  api/        NestJS 10 + Socket.io (сигналинг, чат, реестр, загрузки)
packages/
  shared/     @relay/shared — общий контракт: типы, socket-события, HMAC-auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2 (каркас)
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework (каркас)
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright-тесты
docs/         архитектура, фронтенд, бэкенд, протокол
docker-compose.yml   прод-стек (точка входа)
```

JS-часть — монорепо **pnpm workspaces + Turborepo**; все сервисы работают в Docker, локальный Node не обязателен. Нативные клиенты живут в `clients/` со своими тулчейнами и говорят с сервером по единому протоколу — [docs/protocol.md](docs/protocol.md).

## Быстрый старт

**Dev** (hot-reload, self-signed TLS):

```bash
docker compose -f infra/docker-compose.dev.yml up
# → https://localhost
```

**Прод:**

```bash
cp .env.example .env   # задайте SITE_PASSWORD и DOMAIN
docker compose up --build

# с TURN-ретранслятором (строгие NAT / мобильный интернет):
docker compose --profile turn up --build
```

## Конфигурация (`.env`)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SITE_PASSWORD` | _(пусто)_ | Пароль входа. Общий для api и web. Пусто → авторизация выключена |
| `DOMAIN` | `localhost` | Домен для Caddy. `localhost` → self-signed CA, реальный домен → Let's Encrypt |
| `SERVER_HOST` | `localhost` | Хост для ICE-конфига и realm coturn |
| `TURN_CREDENTIAL` | _(пусто)_ | Пароль TURN-сервера. Обязателен при `--profile turn` |
| `TURN_EXTERNAL_IP` | _(пусто)_ | Публичный IP за 1:1 NAT (облачные VM) |
| `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` | — | Переопределение ICE-серверов |

## Тесты

```bash
# unit (Vitest) + typecheck + build всех пакетов
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

CI (`.github/workflows/ci.yml`): typecheck → unit → docker build → e2e (Playwright) на каждый push.

## Документация

- [Архитектура](docs/architecture.md) — сервисы, трафик, auth, сигналинг
- [Фронтенд](docs/frontend.md) — компоненты, сторы, WebRTC-клиент
- [Бэкенд](docs/backend.md) — NestJS, Socket.io gateway, REST
- [Протокол](docs/protocol.md) — спецификация API для клиентов (web / iOS / desktop)
- [План SFU](docs/sfu-plan.md) — масштабирование видео через LiveKit

## Участие

Баг-репорты и pull request'ы приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[MIT](LICENSE).

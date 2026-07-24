# relay

🇬🇧 [Read this in English](README.md)

Self-hosted платформа для приватной голосовой, видео- и текстовой связи небольшой группы. Два транспорта WebRTC — p2p-mesh для небольших звонков и медиасервер mediasoup для больших, — текстовые каналы с вложениями и реакциями, доступ по общему паролю, TLS из коробки.

## ⚡ Быстрый старт

Поднять свой relay на чистом сервере **Debian/Ubuntu** одной командой:

```bash
curl -fsSL https://raw.githubusercontent.com/frizzonje/relay/main/install.sh | bash
```

Поставит Docker, спросит домен, пароль входа, TURN и медиасервер, скачает готовые образы, откроет порты в фаерволе и запустит всё — а затем даст CLI `relay` (`relay update`, `relay logs`, `relay config`, `relay backup`). Стек лежит в `/opt/relay`.

> [!TIP]
> Не любите слепой `curl | bash`? Скачайте и прочитайте сперва:
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/frizzonje/relay/main/install.sh
> less install.sh && bash install.sh
> ```

Хотите запустить локально или собрать из исходников? См. [Запуск из исходников](#запуск-из-исходников).

## Возможности

- **Голос и видео** — камера, демонстрация экрана (со звуком системы на Windows), push-to-talk, детектор голосовой активности, индикаторы mute/deafen, микшер громкости по участнику (0–300 %) с памятью
- **Два транспорта звонка** — p2p-mesh и медиасервер mediasoup, выбираются на уровне голосового канала; см. [Топология звонка](#топология-звонка)
- **Текстовые каналы** — история сообщений, ответы, редактирование, удаление, индикатор набора, реакции, вложения до 25 МБ
- **Серверы и каналы** — создание/удаление на лету, опциональный пароль на сервер, общий реестр для всех участников, ссылки-приглашения с гостевыми токенами
- **Закрытый контур** — единый пароль входа (HMAC-кука), один origin за Caddy, автоматический TLS через Let's Encrypt
- **TURN-профиль** — coturn для звонков через строгие NAT (мобильные сети, CGNAT), в том числе TURN over TLS на 5349
- **Нативные клиенты** — десктоп (Tauri) с треем, глобальным хоткеем push-to-talk и автообновлением; iOS в работе

## Топология звонка

У каждого голосового канала есть режим `mode`, который выбирает владелец. Оба транспорта равноправны — ни один не легаси.

| | `p2p` (mesh, по умолчанию) | `sfu` (медиасервер) |
|---|---|---|
| Путь медиа | напрямую между участниками | через сервис `sfu` |
| Аплинк участника | растёт с комнатой (N−1 потоков) | константа (1 поток) |
| Оптимум | 2–3 с видео, до ~6–7 только голосом | 4+ с видео |
| Нагрузка на сервер | нет (только сигналинг) | CPU и RTC-порты |
| Требует | ничего | `--profile sfu` + `SFU_SECRET` |

Медиасервер опционален по замыслу: инсталляция без него остаётся полнофункциональной. Если SFU выключен или лежит, каналы `sfu` автоматически откатываются на p2p и предупреждают об этом в интерфейсе. Подробности и обоснование разделения — [docs/sfu-plan.md](docs/sfu-plan.md).

## Клиенты

| Платформа | Каталог | Стек | Статус |
|---|---|---|---|
| Web | [`apps/web`](apps/web) | Next.js 15 / React 19 | референс-клиент |
| Windows / Linux / macOS | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + системный webview) | выпускается — MSI/NSIS, AppImage/deb/rpm, dmg, AUR |
| iOS | [`clients/ios`](clients/ios) | Swift / SwiftUI + WebRTC.xcframework | в работе — логин, чат и аудиозвонки по p2p-mesh |
| Android | — | Kotlin / Compose | не начат |

Нативные клиенты реализуют один контракт — [docs/protocol.md](docs/protocol.md) — и не импортируют код друг друга.

## Структура репозитория

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand)
  api/        NestJS 10 + Socket.io (сигналинг, чат, реестр, загрузки)
  sfu/        NestJS 10 + mediasoup (опциональный медиасервер для больших звонков)
packages/
  shared/     @relay/shared — общий контракт: типы, socket-события, HMAC-auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright-тесты
docs/         архитектура, фронтенд, бэкенд, протокол, SFU
docker-compose.yml        прод-стек из исходников (точка входа)
docker-compose.prod.yml   тот же стек на готовых образах GHCR
install.sh                инсталлятор в одну команду
```

JS-часть — монорепо **pnpm workspaces + Turborepo**; все сервисы работают в Docker, локальный Node не обязателен. Нативные клиенты живут в `clients/` со своими тулчейнами и своими CI-джобами.

## Запуск из исходников

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

# с медиасервером (звонки на 4+ с видео); нужен SFU_SECRET в .env:
docker compose --profile sfu up --build
```

Развернуть без сборки — тянуть готовые образы из GHCR (именно это делает
инсталлятор под капотом):

```bash
docker compose -f docker-compose.prod.yml up -d          # добавьте --profile turn / --profile sfu
```

## Конфигурация (`.env`)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SITE_PASSWORD` | _(пусто)_ | Пароль входа. Общий для api и web. Пусто → авторизация выключена |
| `DOMAIN` | `localhost` | Домен для Caddy. `localhost` → self-signed CA, реальный домен → Let's Encrypt |
| `SERVER_HOST` | `localhost` | Хост для ICE-конфига и realm coturn |
| `TURN_USERNAME` | `webrtc` | Пользователь TURN |
| `TURN_CREDENTIAL` | _(пусто)_ | Пароль TURN-сервера. Обязателен при `--profile turn` |
| `TURN_EXTERNAL_IP` | _(пусто)_ | Публичный IP за 1:1 NAT (облачные VM) |
| `STUN_URLS` / `TURN_URLS` | — | Переопределение ICE-серверов, выдаваемых клиентам |
| `SFU_SECRET` | _(пусто)_ | Ключ подписи пропусков, общий для api и sfu. Пусто → режим SFU выключен |
| `SFU_ANNOUNCED_IP` | `TURN_EXTERNAL_IP` | Публичный IP в ICE-кандидатах медиасервера (1:1 NAT) |
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | `40000` / `40100` | Диапазон медиапортов |

### Фаервол

| Порт | Протокол | Зачем |
|---|---|---|
| `80`, `443` | tcp | Caddy: веб-интерфейс, API, ACME |
| `3478` | udp + tcp | coturn (`--profile turn`) |
| `5349` | tcp | TURN over TLS |
| `49160–49200` | udp | relay-диапазон coturn |
| `40000–40100` | udp + tcp | медиадиапазон SFU (`--profile sfu`) |

Инсталлятор открывает их сам. Порт сигналинга SFU (`3100`) наружу не выставляется — Caddy проксирует его на `/sfu/`.

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
- [SFU](docs/sfu-plan.md) — масштабирование видео через медиасервер mediasoup

## Участие

Баг-репорты и pull request'ы приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[MIT](LICENSE).

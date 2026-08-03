# relay

🇬🇧 [Read this in English](README.md)

Self-hosted платформа для приватной голосовой, видео- и текстовой связи небольшой группы. Два транспорта WebRTC — p2p-mesh для небольших звонков и медиасервер mediasoup для больших, — текстовые каналы с вложениями и реакциями, доступ по общему паролю, TLS из коробки.

## ⚡ Быстрый старт

Поднять свой relay на чистом сервере **Debian/Ubuntu** одной командой:

```bash
curl -fsSL https://raw.githubusercontent.com/frizzonje/relay/main/install.sh | bash
```

Поставит Docker, спросит домен, пароль входа, TURN и медиасервер, скачает готовые образы, откроет порты в фаерволе и запустит всё — а затем даст CLI `relay` (`relay update`, `relay logs`, `relay config`, `relay backup`). Стек лежит в `/opt/relay`.

**Нет домена?** Так и ответьте — инсталлятор возьмёт сертификат Let's Encrypt прямо на IP сервера: настоящий HTTPS по адресу `https://<ваш-ip>`, без предупреждений браузера и без покупки домена. Такие сертификаты по правилам живут шесть дней, поэтому Caddy сам продлевает их раз в пару дней. Если выпустить не удалось (закрыт 80-й порт, адрес за NAT), стек всё равно поднимется — с самоподписанным сертификатом.

> [!TIP]
> Не любите слепой `curl | bash`? Скачайте и прочитайте сперва:
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/frizzonje/relay/main/install.sh
> less install.sh && bash install.sh
> ```

Хотите собрать из исходников или поковыряться в коде? См. [Запуск из исходников](#запуск-из-исходников) и [Локальный запуск и тесты](#локальный-запуск-и-тесты).

## Возможности

- **Голос и видео** — камера, демонстрация экрана (звук вкладки/системы через браузер; на Windows десктоп-клиент снимает системный звук нативно), push-to-talk, детектор голосовой активности, индикаторы mute/deafen, микшер громкости по участнику (0–300 %) с памятью
- **Два транспорта звонка** — p2p-mesh и медиасервер mediasoup, выбираются на уровне голосового канала; см. [Топология звонка](#топология-звонка)
- **Текстовые каналы** — ответы, редактирование, удаление, индикатор набора, реакции, вложения до 25 МБ. Чат эфемерный: api держит в памяти последние 50 сообщений на канал — см. [Данные и хранение](#данные-и-хранение)
- **Серверы и каналы** — создание/удаление на лету, опциональный пароль на сервер, общий реестр для всех участников, ссылки-приглашения с гостевыми токенами
- **Закрытый контур** — единый пароль входа (HMAC-кука), один origin за Caddy, автоматический TLS через Let's Encrypt
- **Интерфейс на английском и русском** — язык определяется на сервере по `Accept-Language` при первом заходе (первый кадр сразу на нужном языке), запоминается в куке, меняется в «Настройки → Внешний вид». Новый язык — это один JSON-файл, см. [Локализацию](#локализация)
- **TURN-профиль** — coturn для звонков через строгие NAT (мобильные сети, CGNAT), в том числе TURN over TLS на 5349
- **Нативные клиенты** — десктоп (Tauri) с треем, глобальным хоткеем push-to-talk и автообновлением на Windows и macOS (на Linux оболочка умеет только чат — см. [Клиенты](#клиенты)); iOS в работе

## Топология звонка

У голосовых каналов, созданных участниками, есть режим `mode` — переключить его может любой участник из сайдбара (каналы, которые заводятся вместе с сервером, всегда `p2p`). Оба транспорта равноправны — ни один не легаси.

| | `p2p` (mesh, по умолчанию) | `sfu` (медиасервер) |
|---|---|---|
| Путь медиа | напрямую между участниками | через сервис `sfu` |
| Аплинк участника | растёт с комнатой (N−1 потоков) | константа (1 поток) |
| Оптимум | 2–3 с видео, до ~6–7 только голосом | 4+ с видео |
| Нагрузка на сервер | нет (только сигналинг) | CPU и RTC-порты |
| Требует | ничего | `--profile sfu` + `SFU_SECRET` |

Медиасервер опционален по замыслу: инсталляция без него остаётся полнофункциональной. Если SFU выключен или лежит, каналы `sfu` автоматически откатываются на p2p и предупреждают об этом в интерфейсе. Обоснование разделения — [docs/plans/old/sfu.md](docs/plans/old/sfu.md).

## Клиенты

| Платформа | Каталог | Стек | Статус |
|---|---|---|---|
| Web | [`apps/web`](apps/web) | Next.js 15 / React 19 | референс-клиент — полный набор возможностей на любой ОС |
| Windows / macOS | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + системный webview) | выпускается — MSI/NSIS, dmg; трей, глобальный хоткей push-to-talk, автообновление |
| Linux | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + системный webview) | AppImage/deb/rpm — **только чат, без звонков** (см. ниже) |
| iOS | [`clients/ios`](clients/ios) | Swift / SwiftUI + WebRTC.xcframework | в работе — логин, чат и аудиозвонки по p2p-mesh |
| Android | — | Kotlin / Compose | не начат |

**Скачать:** [Releases](https://github.com/frizzonje/relay/releases) (теги `desktop-v*`; `nightly` — пре-релиз с `main`). Установщики пока не подписаны, поэтому Windows SmartScreen и macOS Gatekeeper ругаются при первом запуске. PKGBUILD-ы для Arch лежат в [`clients/desktop/packaging/arch`](clients/desktop/packaging/arch), но в AUR ещё не опубликованы — собирайте из репозитория.

> [!IMPORTANT]
> **Десктоп-оболочка на Linux не умеет звонить.** Дистрибутивные сборки WebKitGTK идут с `-DENABLE_WEB_RTC=OFF`, поэтому `RTCPeerConnection` в webview просто нет, и правками нашего кода это не лечится. Чат, вложения и уведомления работают; для голоса и видео на Linux используйте web-клиент в Chromium или Firefox. Подробности и доказательства — [clients/desktop/README.md](clients/desktop/README.md).

Нативные клиенты реализуют один контракт — [docs/protocol.md](docs/protocol.md) — и не импортируют код друг друга.

## Структура репозитория

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand, i18n en/ru)
  api/        NestJS 10 + Socket.io (сигналинг, чат, реестр, загрузки)
  sfu/        NestJS 10 + mediasoup (опциональный медиасервер для больших звонков)
packages/
  shared/     @relay/shared — общий контракт: типы, socket-события, HMAC-auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright-тесты
docs/         архитектура, фронтенд, бэкенд, протокол, plans/
docker-compose.yml        прод-стек из исходников (точка входа)
docker-compose.prod.yml   тот же стек на готовых образах GHCR
install.sh                инсталлятор в одну команду
```

JS-часть — монорепо **pnpm workspaces + Turborepo**; все сервисы работают в Docker, локальный Node не обязателен. Нативные клиенты живут в `clients/` со своими тулчейнами и своими CI-джобами.

## Запуск из исходников

**Прод** (образы собираются локально):

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

Зафиксировать версию можно через `RELAY_VERSION` (по умолчанию `latest`); опубликованные теги — на странице [GHCR packages](https://github.com/frizzonje?tab=packages&repo_name=relay).

## Локальный запуск и тесты

Единственное требование — Docker с плагином Compose. Локальный Node и pnpm не нужны.

### Dev-стек (hot-reload)

```bash
docker compose -f infra/docker-compose.dev.yml up
# → https://localhost
```

Что поднимается: `api` (NestJS в watch-режиме) и `web` (Next.js на Turbopack) за одним origin Caddy на `:443`, оба подхватывают правки из рабочей копии. Первый запуск ставит зависимости в именованные тома и занимает несколько минут, последующие стартуют за секунды. `--profile sfu` дополнительно поднимает медиасервер (собирается из `apps/sfu/Dockerfile`).

Что полезно знать до первого запуска:

- **Dev-стек не читает корневой `.env`.** Compose ищет `.env` рядом с compose-файлом, то есть для `infra/docker-compose.dev.yml` — это `infra/.env`. Чтобы скормить ему корневой файл, укажите его явно:
  ```bash
  docker compose --env-file .env -f infra/docker-compose.dev.yml up
  ```
  Без этого все переменные берут дефолты, зашитые в compose-файл, — для обычной локальной работы именно то, что нужно.
- **Пароля по умолчанию нет.** В деве `SITE_PASSWORD` пустой → гейт выключен, `https://localhost` открывается сразу в приложение. Задавайте его (`SITE_PASSWORD=… docker compose …`), только когда проверяете сам гейт; значение обязано совпадать у `api` и `web`, иначе кука `relay_pass` не пройдёт проверку.
- **Сертификат самоподписанный** (внутренний CA Caddy) — браузер один раз ругнётся, примите. TLS тут не формальность: `getUserMedia` и захват экрана работают только в secure context.
- **Порты 80 и 443 должны быть свободны.** Если рядом уже крутится прод-стек из этого же репозитория, сначала погасите его — они занимают те же порты.

### Проверить звонок

Откройте `https://localhost` в двух вкладках (или двух профилях браузера), возьмите разные `@`-теги и зайдите в один голосовой канал — для mesh-звонка вдвоём больше ничего не нужно. Если второго микрофона нет, помогает `--use-fake-device-for-media-stream` у Chromium. Для режима `sfu` поднимите стек с `--profile sfu` и непустым `SFU_SECRET`, создайте свой голосовой канал и переключите бейдж `P2P`/`SFU` в сайдбаре — у каналов, заведённых вместе с сервером, режим не меняется. При пустом секрете бейдж неактивен и все каналы работают по p2p.

Звонок между двумя машинами требует общего имени хоста: задайте `DOMAIN` и `SERVER_HOST` равными LAN-адресу хоста и ждите предупреждения о сертификате на второй машине.

### Тесты и проверки

```bash
# unit (Vitest) + typecheck + build всех пакетов — тот же набор, что в CI
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'

# линт и форматирование — CI падает на обоих
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm lint && pnpm format:check'
```

E2e (Playwright) гоняются против прод-стека, не против dev:

```bash
SITE_PASSWORD=testpass123 docker compose -f docker-compose.yml -f infra/docker-compose.e2e.yml up -d --build
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' relay-caddy-1)
docker run --rm --network relay_default --add-host "relay.test:$CADDY_IP" \
  -v "$PWD":/work -w /work/e2e \
  -e BASE_URL=https://relay.test -e SITE_PASSWORD=testpass123 \
  mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c 'npm install --no-save @playwright/test@1.49.0 && npx playwright test'
docker compose -f docker-compose.yml -f infra/docker-compose.e2e.yml down -v
```

CI (`.github/workflows/ci.yml`) гоняет те же три группы на push в `main`/`refactor/**` и на каждый pull request: lint + format + typecheck + unit + build, сборка прод-образов api/web/sfu, затем e2e. У десктоп-клиента свой workflow (`desktop.yml`).

## Конфигурация (`.env`)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SITE_PASSWORD` | _(пусто)_ | Пароль входа. Общий для api и web. Пусто → авторизация выключена |
| `DOMAIN` | `localhost` | Хост для Caddy. `localhost` → self-signed CA, реальный домен → Let's Encrypt. Публичный IP тоже получает сертификат Let's Encrypt, но требует issuer-блока, который `install.sh` пишет в `tls-mode.caddy` |
| `SERVER_HOST` | `localhost` | Хост для ICE-конфига и realm coturn |
| `TURN_USERNAME` | `webrtc` | Пользователь TURN |
| `TURN_CREDENTIAL` | _(пусто)_ | Пароль TURN-сервера. Обязателен при `--profile turn` |
| `TURN_EXTERNAL_IP` | _(пусто)_ | Публичный IP за 1:1 NAT (облачные VM) |
| `STUN_URLS` / `TURN_URLS` | — | Переопределение ICE-серверов, выдаваемых клиентам |
| `SFU_SECRET` | _(пусто)_ | Ключ подписи пропусков, общий для api и sfu. Пусто → режим SFU выключен |
| `SFU_ANNOUNCED_IP` | `TURN_EXTERNAL_IP` | Публичный IP в ICE-кандидатах медиасервера (1:1 NAT) |
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | `40000` / `40100` | Диапазон медиапортов |
| `SFU_URL` | `/` | Публичный адрес сигналинга SFU для клиентов. `/` = «тот же origin, путь `/sfu/`» |
| `SFU_INTERNAL_URL` | `http://host.docker.internal:3100` | Куда api ходит health-чеком к SFU изнутри сети (в деве — `http://sfu:3100`) |
| `PORT` | `3000` | Порт NestJS-приложения внутри контейнера |
| `RELAY_VERSION` | `latest` | Тег образов для `docker-compose.prod.yml` |

### Фаервол

| Порт | Протокол | Зачем |
|---|---|---|
| `80`, `443` | tcp | Caddy: веб-интерфейс, API, ACME |
| `3478` | udp + tcp | coturn (`--profile turn`) |
| `5349` | tcp | TURN over TLS |
| `49160–49200` | udp | relay-диапазон coturn |
| `40000–40100` | udp + tcp | медиадиапазон SFU (`--profile sfu`) |

Инсталлятор открывает их сам. Порт сигналинга SFU (`3100`) наружу не выставляется — Caddy проксирует его на `/sfu/`.

## Данные и хранение

Базы данных нет. Что переживает рестарт, а что нет:

| Данные | Где | Переживает рестарт? |
|---|---|---|
| Серверы и каналы | `registry.json` на томе `uploads` (`DATA_DIR`) | да |
| Загруженные вложения | том `uploads` | да |
| TLS-сертификаты | том `caddy_data` | да |
| Сообщения чата | память процесса api — последние 50 на канал, максимум 200 каналов | **нет** |
| Свой `@`-тег, громкости, непрочитанное | `localStorage` браузера | да, в пределах браузера |

То есть `relay update`, `docker compose up` и любой рестарт api стирают историю сообщений, оставляя серверы, каналы и файлы. `relay backup` снимает тома `uploads` и `caddy_data` — ровно всё, что вообще хранится. Аккаунтов тоже нет: доступ — один общий `SITE_PASSWORD`, а личность — `@`-тег, который посетитель выбирает после входа.

## Локализация

Web-клиент идёт на английском и русском; `en` — референсный словарь, остальные локали падают на него по ключам. Десктоп-клиент встраивает тот же интерфейс и получает переводы бесплатно, а его собственный экран «адрес вашей инсталляции» несёт те же два языка и выбирает их по языку системы. iOS-клиент пока только на русском.

Добавить язык — две правки и ни строчки кода:

1. положить `apps/web/lib/i18n/messages/<tag>.json` рядом с `en.json`;
2. дописать тег и подпись в `LOCALES` / `LOCALE_LABELS` в [`apps/web/lib/i18n/config.ts`](apps/web/lib/i18n/config.ts).

Дальше `messages.test.ts` роняет сборку на любом расхождении с `en.json`: пропал ключ, потерялся `{placeholder}`, не хватает формы множественного числа. Всё остальное — определение языка, кука, переключатель — уже готово.

## Документация

Документация и комментарии в коде — на русском; англоязычная точка входа — два README.

- [Архитектура](docs/architecture.md) — сервисы, трафик, auth, сигналинг
- [Фронтенд](docs/frontend.md) — компоненты, сторы, WebRTC-клиент
- [Бэкенд](docs/backend.md) — NestJS, Socket.io gateway, REST
- [Протокол](docs/protocol.md) — спецификация API для клиентов (web / iOS / desktop)
- [SFU](docs/plans/old/sfu.md) — проектная записка о масштабировании видео через медиасервер mediasoup
- [1.0](docs/plans/relay-1.0.md) — что несёт следующий мажор: идентичность, история на Postgres, углубление основ
- [2.0](docs/plans/relay-2.0.md) — личные сообщения и звонок один на один, следующий за ним релиз

## Участие

Баг-репорты и pull request'ы приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[MIT](LICENSE).

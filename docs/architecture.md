# Архитектура

С чего начать, если вы впервые открыли репозиторий. Здесь — из каких частей
состоит relay, как они разговаривают и где что лежит. Детали — в
[protocol.md](protocol.md) (контракт), [media.md](media.md) (звонки),
[backend.md](backend.md), [frontend.md](frontend.md) и
[self-hosting.md](self-hosting.md).

## Сервисы

```mermaid
flowchart LR
  B["Браузер / десктоп / iOS"]
  subgraph host["Сервер (docker compose)"]
    C["caddy<br/>:80 :443"]
    W["web<br/>Next.js :3001"]
    A["api<br/>NestJS + Socket.io :3000"]
    D[("db<br/>Postgres 18")]
    U[("том uploads")]
    S["sfu<br/>mediasoup :3100<br/>profile sfu"]
    T["coturn<br/>:3478 :5349<br/>profile turn"]
  end
  B -- "HTTPS / WSS" --> C
  C -- "/*" --> W
  C -- "/api /socket.io /uploads" --> A
  C -- "/sfu" --> S
  A --> D
  A --> U
  A -. "health-чек, общий SFU_SECRET" .-> S
  B <-. "SRTP (sfu-канал)" .-> S
  B <-. "SRTP через relay (строгий NAT)" .-> T
```

| Сервис | Код | Что делает | Состояние |
|---|---|---|---|
| **caddy** | [`infra/Caddyfile`](../infra/Caddyfile) | TLS (Let's Encrypt / внутренний CA), один origin для всего | сертификаты в томе `caddy_data` |
| **web** | [`apps/web`](../apps/web) | Next.js 15, весь UI. Сам ничего не хранит, [`middleware.ts`](../apps/web/middleware.ts) не пускает без `relay_pass` | нет |
| **api** | [`apps/api`](../apps/api) | REST + Socket.io: вход, личности, реестр, чат, ЛС, сигналинг звонков, дозвон, настройки, панель владельца | Postgres + том `uploads` + память процесса |
| **db** | `postgres:18-alpine` | всё постоянное | том `pgdata` |
| **sfu** | [`apps/sfu`](../apps/sfu) | медиасервер для каналов `sfu`. Необязателен | только память |
| **coturn** | [`infra/coturn-entrypoint.sh`](../infra/coturn-entrypoint.sh) | TURN для строгих NAT. Необязателен | нет |

`sfu` и `coturn` работают в `network_mode: host` — им нужны диапазоны UDP-портов.
Стек целиком — [`docker-compose.yml`](../docker-compose.yml) (сборка из исходников)
и [`docker-compose.prod.yml`](../docker-compose.prod.yml) (готовые образы GHCR).

**api — один процесс, горизонтально не масштабируется.** Часть состояния живёт
в его памяти (ниже), и это осознанный выбор под маленькую инсталляцию.

## Три вопроса на входе

Каждый запрос проходит три независимые проверки. Их важно не путать.

| Вопрос | Чем отвечается | Где |
|---|---|---|
| **Пустить ли на инсталляцию?** | общий пароль → кука `relay_pass` (HMAC, без базы) | [`auth/auth.ts`](../apps/api/src/auth/auth.ts), [`http-gate.ts`](../apps/api/src/http-gate.ts), [`middleware.ts`](../apps/web/middleware.ts) |
| **Кто это?** | Ed25519-ключ устройства → челлендж → кука `relay_id` | [`identity/`](../apps/api/src/identity/), [`lib/signer.ts`](../apps/web/lib/signer.ts) |
| **Что ему здесь можно?** | бан, маска адреса, обслуживание, пароль закрытого сервера, гость, лимитер | [`gateway/perimeter.ts`](../apps/api/src/gateway/perimeter.ts) |

Пароль инсталляции — это ворота, а не учётная запись. Личность — это ключ на
устройстве: нет регистрации, пароля и восстановления. Потерял все устройства —
заводишь новую личность. Несколько устройств одной личности связываются
6-значным кодом ([protocol.md §2.3](protocol.md#23-устройства-и-связка)).

Отдельно от этого — **владелец инсталляции**: одна личность, получившая власть
по ссылке из терминала сервера (`relay owner-link`). Он видит панель и может
всё; модератор сервера — власть только над своим сервером.

## Контракт

```
                packages/shared  (@relay/shared)
               ▲              ▲               ▲
  исходник TS  │   CommonJS   │    CommonJS   │
               │   (dist/)    │    (dist/)    │
          apps/web        apps/api        apps/sfu
```

[`packages/shared`](../packages/shared/src) — один контракт на все три
стороны: socket-события и их тела, ответы, константы, каталог настроек,
машина состояний вызова, крипто-примитивы личности и протокол медиасервера
([`sfu.ts`](../packages/shared/src/sfu.ts)). Web берёт исходник
(`transpilePackages` в Next), api и sfu — сборку в CommonJS из `dist/`.
Разойтись половинам мешает компилятор.

У каждого имени контракта один путь — `@relay/shared`. Приложения его не
объявляют заново и не реэкспортируют через свои модули: копия под тем же
именем или под другим (`DmPeerView` вместо `DmPeer`) разъезжается с
оригиналом молча. Второго имени тоже нет (`type Source = SfuSource`).
Серверная запись, которая шире клиентской формы, строится от неё
(`ServerEntry extends Pick<Server, …>`), а не переписывается. Правило держит
`pnpm contract:check` ([`tools/check-contract.mjs`](../tools/check-contract.mjs)):
он ищет тени имён, реэкспорт и копии по набору полей между пакетами, а
намеренные исключения перечислены в нём же, каждое с причиной.

Тела, которые присылает клиент, сервер описывает как `Untrusted<T>` от формы
контракта: какие поля бывают — известно, что в них лежит — решает разбор
(`str` / `trimmed` / `optional` в
[`gateway/protocol.ts`](../apps/api/src/gateway/protocol.ts)).

Своё у сервера осталось в двух местах, и оба — реализация, а не копия формы:

| Что | Почему отдельно |
|---|---|
| [`auth/auth.ts`](../apps/api/src/auth/auth.ts) ↔ [`shared/src/auth.ts`](../packages/shared/src/auth.ts) | пропуск проверяют и api (синхронно, `node:crypto`, пароль из панели), и Edge-middleware Next (Web Crypto). Формат один — его держит перекрёстный тест в [`auth.test.ts`](../apps/api/src/auth/auth.test.ts) |
| [`identity/crypto.ts`](../apps/api/src/identity/crypto.ts) | разбор ключа и подписи из сети на `Buffer` и синхронный отпечаток. Константы и тексты подписи — из контракта |

Компилятор не проверит две вещи, и их держат тесты: что каждое событие панели
из контракта кто-то слушает на сервере
([`index.test.ts`](../packages/shared/src/index.test.ts)) и что каждый
параметр каталога кем-то читается
([`consumers.test.ts`](../packages/shared/src/consumers.test.ts)). Меняете
контракт — правите его и [protocol.md](protocol.md).

Нативные клиенты (`clients/`) не могут импортировать TS и реализуют контракт по
[protocol.md](protocol.md). Web — эталонная реализация.

## Где живёт состояние

| Что | Где | Переживает рестарт api |
|---|---|---|
| Серверы, каналы | Postgres `servers`, `channels` (+ копия в памяти `RegistryService`) | да |
| Сообщения, реакции, закрепы, упоминания | Postgres `messages`, `pins`; срок — ретенция | да |
| Вложения | файлы в томе `uploads`, строки в `attachments` | да |
| Личности, устройства, роли и баны | `identities`, `devices`, `roles`, `owner_claims` | да |
| Беседы ЛС | `conversations` (сообщения — в `messages`) | да |
| Отметки чтения, личные настройки | `reads`, `prefs` | да |
| Настройки инсталляции, журнал | `settings`, `audit` | да |
| `relay_pass` | нигде — проверяется подписью | — |
| Сессии `relay_id` | нигде — ключ подписи случайный на процесс | **нет**: клиент молча входит заново |
| Кто в какой комнате, presence, живые вызовы | память api (комнаты Socket.io, `VoiceSessions`, `Presence`, `Rings`) | нет |
| Нонсы входа, коды связки, счётчики попыток | память api | нет |
| Микрофон, камера, хоткеи, громкость по умолчанию | `localStorage` устройства | — |

Схема БД — [`db/entities.ts`](../apps/api/src/db/entities.ts), миграции —
[`db/migrations/`](../apps/api/src/db/migrations/) (применяются на старте api,
[`main.ts`](../apps/api/src/main.ts)).

## Звонки в двух словах

- Голосовой канал `p2p`: api только пересылает SDP/ICE, медиа идёт напрямую между
  участниками (full mesh, perfect negotiation).
- Голосовой канал `sfu`: api выдаёт 60-секундный пропуск, клиент подключается к
  mediasoup напрямую по `/sfu/`, api в медиа не участвует.
- Звонок 1:1 из ЛС — дозвон через api, после ответа двое садятся в отдельную
  комнату `voice:dm-…`, всегда `p2p`.
- TURN — для тех, у кого прямой путь не собирается.

Подробно — [media.md](media.md).

## Клиенты

| Платформа | Каталог | Как устроен |
|---|---|---|
| Web | [`apps/web`](../apps/web) | эталон |
| Windows, macOS | [`clients/desktop`](../clients/desktop) | Tauri v2: окно грузит web-UI с сервера, Rust добавляет трей, PTT-хоткей, автозапуск, обновления, ключ в keychain |
| Linux | [`clients/desktop-linux`](../clients/desktop-linux) | Electron поверх того же web-UI — в дистрибутивном WebKitGTK нет WebRTC |
| iOS | [`clients/ios`](../clients/ios) | SwiftUI + libwebrtc, прототип под протокол до 1.0 (подробнее — [clients/README.md](../clients/README.md)) |

Обе десктоп-оболочки говорят с web-UI одним набором событий
([`lib/shell-bridge.ts`](../apps/web/lib/shell-bridge.ts)); списки —
[`capabilities/remote.json`](../clients/desktop/src-tauri/capabilities/remote.json)
и [`desktop-linux/src/events.js`](../clients/desktop-linux/src/events.js).

## Карта репозитория

```
apps/
  web/            Next.js 15 — UI                                   → frontend.md
  api/            NestJS 11 — REST, Socket.io, Postgres             → backend.md
  sfu/            NestJS 11 + mediasoup — медиасервер               → media.md
packages/
  shared/         @relay/shared — контракт клиент↔сервер            → protocol.md
clients/
  desktop/        Tauri v2 (Windows, macOS)
  desktop-linux/  Electron (Linux)
  ios/            Swift / SwiftUI
infra/            Caddyfile, TLS-режимы, coturn, relay CLI, dev/e2e compose
e2e/              Playwright: сценарии двумя людьми на прод-стеке
tools/            gen-sfx.py (звуки), keyprobe (проба ключей в движках), check-docs.mjs
docs/             эта документация; plans/ — проектные заметки по релизам
install.sh        установщик одной командой
```

# Архитектура

## Топология сервисов

```
Browser
  │  HTTPS / WSS
  ▼
Caddy :443
  ├── /api/*  /socket.io/*  /uploads/*  →  api (NestJS :3000)
  └── /*                               →  web (Next.js :3001)
```

Всё за одним origin — кука `relay_pass` работает без CORS, `getUserMedia`/WebRTC получают secure-context. В dev-стеке та же схема, Caddy слушает `localhost` с самоподписанным внутренним CA.

Caddy автоматически обновляет сертификаты Let's Encrypt для реального домена; `localhost` → внутренний CA (браузер доверяет после принятия предупреждения). Ничего менять не нужно — достаточно задать `DOMAIN`.

---

## Авторизация

Схема без БД: один общий пароль, HMAC-подписанные куки.

```
POST /api/login {password}
  └── passwordMatches() — timing-safe сравнение хэшей SHA-256
       └── issueToken() — HMAC-SHA256(exp, key=SITE_PASSWORD) → кука relay_pass (30 дней)
```

Проверка при каждом запросе:

| Слой | Что делает |
|---|---|
| **Next middleware** (`apps/web/middleware.ts`) | Edge-runtime, `verifyToken()` из `@relay/shared`. Без куки — редирект на `/login`. |
| **Nest Express middleware** (`apps/api/src/main.ts`) | Все маршруты кроме `POST /api/login` отдают 401 без валидной куки. |
| **Socket.io handshake** (`signaling.gateway.ts`) | `handleConnection` проверяет `isAuthorized(client.handshake)` и сбрасывает соединение. Socket.io идёт мимо Express-middleware. |

Смена пароля мгновенно инвалидирует все куки — подпись завязана на `SITE_PASSWORD`.

Код `issueToken`/`verifyToken`/`parseCookies` живёт в [`packages/shared/src/auth.ts`](../packages/shared/src/auth.ts) и шарится между web и api.

---

## WebRTC: mesh без SFU

Выбрана **full-mesh** топология: каждый участник звонит каждому напрямую. Нет медиасервера (SFU/MCU), нет лицензий, нет дополнительного latency. Ограничение — при >5–6 участниках нагрузка на аплоад растёт линейно.

### Сигналинг (perfect negotiation)

Сервер — слепой ретранслятор SDP/ICE. Логика переговоров на клиенте:

```
Новый участник входит в room
  ├── сервер: emit('peers', [...]) → список уже подключённых
  ├── новичок: createPeer(id) для каждого → addTrack → onnegotiationneeded → offer
  └── старожил: peer-joined → createPeer(id) ← принимает offer

Offer collision (оба отправили offer одновременно):
  └── «вежливая» сторона (id < peerId) откатывает своё, принимает чужое
```

При обрыве (`connectionState === 'disconnected'`): таймер 8 с → `restartIce()`. При `'failed'`: ещё 15 с → toast с советом настроить TURN → `removePeer()`.

### ICE / TURN

По умолчанию — STUN Google (`stun.l.google.com:19302`). Дополнительные серверы api отдаёт через `GET /api/config` (фронт получает их при старте).

coturn поднимается как отдельный Docker-профиль (`--profile turn`), слушает UDP/TCP :3478. Нужен для участников за строгими NAT (корпоративные сети, CGNAT, мобильный интернет), где STUN не помогает.

---

## Монорепо

```
pnpm-workspace.yaml     корень — apps/* + packages/*
turbo.json              пайплайн: build → typecheck → test
packages/shared/        @relay/shared — никаких зависимостей от DOM (работает в Node)
```

`@relay/shared` — источник правды: socket-события (`ClientToServerEvents`, `ServerToClientEvents`), DTO, ICE-типы, константы. Оба конца (`web`, `api`) импортируют отсюда и компилируются против одного контракта.

---

## Данные: что где хранится

| Данные | Где |
|---|---|
| Аутентификация | Stateless HMAC-кука. БД нет. |
| История чатов | In-memory (Map на сервере), последние 50 сообщений на канал. Перезапуск → очистка. |
| Файлы загрузок | Docker volume `uploads`, путь `/app/uploads`. In-memory реестр метаданных (только runtime). |
| Состав голосовых каналов | In-memory в Socket.io rooms; рассылается всем клиентам при каждом изменении. |

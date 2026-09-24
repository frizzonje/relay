# Фронтенд: apps/web

Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, Zustand, Framer
Motion, Radix. Web-клиент — эталонная реализация протокола: спорное поведение
сверяется с ним. Тот же UI грузят обе десктоп-оболочки.

## Маршруты

| Путь | Файл | Что |
|---|---|---|
| `/` | [`app/page.tsx`](../apps/web/app/page.tsx) | приложение: `AppShell` + гейт личности |
| `/login` | [`app/login/page.tsx`](../apps/web/app/login/page.tsx) | пароль инсталляции → `POST /api/login` |
| `/invite/[token]` | [`app/invite/[token]/page.tsx`](../apps/web/app/invite/[token]/page.tsx) | гость по ссылке: один голосовой канал |
| `/#pair=123456` | [`stores/pairing.ts`](../apps/web/stores/pairing.ts) | подтвердить связку нового устройства |
| `/#owner=<ключ>` | [`stores/owner.ts`](../apps/web/stores/owner.ts) | забрать власть владельца |

[`middleware.ts`](../apps/web/middleware.ts) (Edge) без `relay_pass` отправляет
на `/login`. Подпись он проверяет только для пароля из `.env` — пароль из
панели хранится хэшем, которого Next не знает, поэтому непросроченный токен
пропускается дальше, а окончательно проверяет api. Исключены `/api`,
`/uploads`, `/invite`, `/_next` и файлы с точкой.

[`app/layout.tsx`](../apps/web/app/layout.tsx) определяет язык на сервере и
подключает [`app/providers.tsx`](../apps/web/app/providers.tsx): i18n,
`SocketProvider`, контекстное меню, тосты.

## Как приложение оживает

1. `SocketProvider` ([`components/providers/SocketProvider.tsx`](../apps/web/components/providers/SocketProvider.tsx))
   подключает единственный сокет ([`lib/socket.ts`](../apps/web/lib/socket.ts)) с
   `auth: {protocol, clientId, guest?, unlock?}` и раскладывает входящие события
   по сторам.
2. Параллельно [`stores/identity.ts`](../apps/web/stores/identity.ts) восстанавливает
   личность: `GET /api/identity/me` → при `401` вход ключом
   ([`lib/identity-login.ts`](../apps/web/lib/identity-login.ts)) → если сервер ответил
   `created`, [`IdentityGate`](../apps/web/components/layout/IdentityGate.tsx) спрашивает имя.
3. Как только личность появилась, сокет переподключается — сервер узнаёт личность
   только на рукопожатии.
4. Гейты поверх каркаса показывают отказы рукопожатия:
   [`OutdatedGate`](../apps/web/components/layout/OutdatedGate.tsx),
   [`BannedGate`](../apps/web/components/layout/BannedGate.tsx),
   [`BlockedGate`](../apps/web/components/layout/BlockedGate.tsx),
   [`MaintenanceGate`](../apps/web/components/layout/MaintenanceGate.tsx).

## Ключ устройства

Интерфейс `Signer` ([`lib/signer.ts`](../apps/web/lib/signer.ts)) с двумя реализациями:

- **браузер** — Ed25519 `CryptoKey` с `extractable: false` в IndexedDB;
- **десктоп-оболочка** — ключ в системной связке ключей, подпись через мост
  событий `identity-request` / `identity-reply`
  ([`lib/signer-shell.ts`](../apps/web/lib/signer-shell.ts)). В WKWebView
  сохранение `CryptoKey` в IndexedDB вешает процесс хранилища, поэтому этот путь
  там запрещён.

Лицо человека — identicon «Аврора 9c» из отпечатка ключа
([`lib/identicon.ts`](../apps/web/lib/identicon.ts), [`components/ui/Identicon.tsx`](../apps/web/components/ui/Identicon.tsx)).
Алгоритм нельзя менять после 1.0 — у людей поменяются лица.

## Каркас

[`components/layout/AppShell.tsx`](../apps/web/components/layout/AppShell.tsx) —
раскладка и адаптив: на десктопе колонки, на узком экране — панели и таб-бар
([`MobileNav`](../apps/web/components/layout/MobileNav.tsx)).

```
AppShell
├─ ServerRail       рейка серверов (+ «другие хосты» — чужие инсталляции)
├─ Sidebar          каналы сервера, кто в голосовых, бейджи непрочитанного
├─ Topbar / Toolbar название канала, поиск, закрепы, панель владельца
├─ Stage            сцена по ui.view:
│   ├─ Lobby        заставка + нагрузка сервера
│   ├─ VideoGrid    звонок (VideoTile)
│   ├─ ChatPanel    лента (Message, MentionPicker, PinsPanel, SearchPanel)
│   └─ DmThread     беседа ЛС
├─ Controls         микрофон, наушники, камера, экран, выход
├─ Members          состав: голосовой канал / кто онлайн
└─ гейты, диалоги, IncomingToast (входящий звонок), DmToast
```

Компоненты — в [`components/`](../apps/web/components/): `layout/`, `stage/`,
`chat/`, `dm/`, `call/`, `admin/` (панель владельца), `ui/` (примитивы: `glass`,
`button`, `dialog`, `icon`, `Logo`, `Identicon`).

## Состояние (Zustand)

Сторы — «витрина» для React. Императивное (соединения, `MediaStream`,
таймеры) живёт в `lib/`, сторы только отражают его.

| Стор | Что |
|---|---|
| [`ui.ts`](../apps/web/stores/ui.ts) | каркас: `view`, открытые голосовой и текстовый каналы (независимы: можно сидеть в звонке и читать другой канал) |
| [`servers.ts`](../apps/web/stores/servers.ts), [`channels.ts`](../apps/web/stores/channels.ts) | зеркало реестра с сервера |
| [`chat.ts`](../apps/web/stores/chat.ts) | открытая лента, ростер, кто печатает |
| [`voice.ts`](../apps/web/stores/voice.ts) | плитки звонка, мут, статус, пинг, `voice-presence` |
| [`presence.ts`](../apps/web/stores/presence.ts) | присутствие личностей |
| [`ring.ts`](../apps/web/stores/ring.ts) | исходящий/входящий вызов (по общей машине `step` из shared) |
| [`dm.ts`](../apps/web/stores/dm.ts) | список переписок |
| [`unread.ts`](../apps/web/stores/unread.ts), [`notify.ts`](../apps/web/stores/notify.ts) | непрочитанное, звук и вспышка уведомлений |
| [`pins.ts`](../apps/web/stores/pins.ts), [`search.ts`](../apps/web/stores/search.ts) | закрепы и поиск |
| [`identity.ts`](../apps/web/stores/identity.ts), [`pairing.ts`](../apps/web/stores/pairing.ts), [`owner.ts`](../apps/web/stores/owner.ts) | личность, связка устройств, захват владения |
| [`admin.ts`](../apps/web/stores/admin.ts) | панель владельца |
| [`config.ts`](../apps/web/stores/config.ts) | снимок `settings` и `/api/config`; `setting('group.key')` для кода вне React |
| [`contract.ts`](../apps/web/stores/contract.ts), [`moderation.ts`](../apps/web/stores/moderation.ts) | отказы рукопожатия: версия, бан |
| [`desktop.ts`](../apps/web/stores/desktop.ts), [`hotkeys.ts`](../apps/web/stores/hotkeys.ts), [`hosts.ts`](../apps/web/stores/hosts.ts) | оболочка, горячие клавиши, другие инсталляции |

## lib/: логика без React

| Модуль | Что |
|---|---|
| [`socket.ts`](../apps/web/lib/socket.ts) | единственный Socket.io-клиент |
| [`voice.ts`](../apps/web/lib/voice.ts) + [`voice/`](../apps/web/lib/voice/) | звонки — см. [media.md](media.md#клиентская-архитектура) |
| [`call.ts`](../apps/web/lib/call.ts) | вход в комнату беседы после `call-state{accepted}` |
| [`config.ts`](../apps/web/lib/config.ts) | `GET /api/config`, ICE-серверы |
| [`channels.ts`](../apps/web/lib/channels.ts), [`servers.ts`](../apps/web/lib/servers.ts) | действия над реестром (сервер — источник правды) |
| [`unlock-tokens.ts`](../apps/web/lib/unlock-tokens.ts) | пропуска на закрытые серверы в localStorage |
| [`identity-login.ts`](../apps/web/lib/identity-login.ts), [`signer*.ts`](../apps/web/lib/signer.ts), [`devices.ts`](../apps/web/lib/devices.ts), [`owner.ts`](../apps/web/lib/owner.ts) | личность, устройства, владение |
| [`prefs.ts`](../apps/web/lib/prefs.ts) | личные настройки (`prefs-set`) |
| [`mentions.ts`](../apps/web/lib/mentions.ts), [`markdown.tsx`](../apps/web/lib/markdown.tsx), [`search.ts`](../apps/web/lib/search.ts) | разметка сообщений, упоминания, подсветка поиска |
| [`refusals.ts`](../apps/web/lib/refusals.ts) | причины отказов сервера → текст для человека |
| [`shell-bridge.ts`](../apps/web/lib/shell-bridge.ts), [`desktop.ts`](../apps/web/lib/desktop.ts), [`desktop-screen-audio.ts`](../apps/web/lib/desktop-screen-audio.ts) | мост к десктоп-оболочке |
| [`sfx.ts`](../apps/web/lib/sfx.ts) | звуки эфира и чата (`public/sfx`, генерируются [`tools/gen-sfx.py`](../tools/gen-sfx.py)) |
| [`hotkeys.ts`](../apps/web/lib/hotkeys.ts) | горячие клавиши и push-to-talk в браузере |
| [`theme.ts`](../apps/web/lib/theme.ts) | светлая/тёмная тема |

## Мост к десктоп-оболочке

Оболочки (Tauri и Electron) грузят этот же UI с сервера и общаются с ним
событиями — не командами. [`lib/shell-bridge.ts`](../apps/web/lib/shell-bridge.ts)
находит реализацию (`window.__TAURI__` или preload Electron).

| Направление | События |
|---|---|
| страница → оболочка | `voice-status`, `call-ringing`, `desktop-settings-get`, `set-autostart`, `set-ptt-shortcut`, `switch-server`, `check-updates`, `install-update`, `identity-request`, `webrtc-missing`, `screen-picker` |
| оболочка → страница | `ptt`, `desktop-settings`, `update-status`, `identity-reply` |

Список должен совпадать в [`capabilities/remote.json`](../clients/desktop/src-tauri/capabilities/remote.json)
и [`desktop-linux/src/events.js`](../clients/desktop-linux/src/events.js).

## Языки

Свой движок в [`lib/i18n/`](../apps/web/lib/i18n/): `en.json` — эталон, остальные
локали падают на него по ключу. Язык определяется на сервере из
`Accept-Language` при первом заходе и запоминается в куке.

Новый язык:

1. `apps/web/lib/i18n/messages/<tag>.json` рядом с `en.json`;
2. тег и название — в `LOCALES` / `LOCALE_LABELS` в [`config.ts`](../apps/web/lib/i18n/config.ts).

`messages.test.ts` проверяет, что ключи, плейсхолдеры и формы множественного
числа совпадают с `en.json`.

## Стиль

Токены цветов и шрифты (IBM Plex Sans / Mono) — в [`app/globals.css`](../apps/web/app/globals.css),
светлая и тёмная темы. Интерфейс монохромный, акцент — светлый серый, не цвет.
Знак — «mesh-треугольник» из трёх узлов ([`components/ui/Logo.tsx`](../apps/web/components/ui/Logo.tsx)).

## Окружение

| Переменная | Где | Что |
|---|---|---|
| `SITE_PASSWORD` | рантайм | проверка `relay_pass` в `middleware.ts` |
| `NEXT_PUBLIC_SOCKET_URL`, `NEXT_PUBLIC_API_URL` | сборка | только если api на другом origin (обычно пусто: всё за Caddy) |

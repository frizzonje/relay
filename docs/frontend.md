# Фронтенд (apps/web)

Next.js 15, App Router, React 19, TypeScript. Tailwind v4, Framer Motion, Radix/shadcn. Состояние — Zustand.

## Страницы и роутинг

```
app/
  layout.tsx       — корневой layout: Providers (Toaster, SocketProvider)
  page.tsx         — главный экран (shell каркаса) — только для авторизованных
  login/page.tsx   — логин: форма ввода пароля → POST /api/login
middleware.ts      — Edge: verifyToken() → редирект на /login без куки
```

`/api`, `/uploads` и вся статика с точкой в пути (`*.svg`, `*.mp3`, ...) из middleware исключены — иначе сам `/login` не загрузится.

---

## Структура компонентов

### Shell (главный экран)

```
page.tsx
├── ServerRail        — левая рейка «серверов» (навигация между группами каналов)
├── Sidebar           — список каналов (голосовые + текстовые); клик → join
├── <main>
│   ├── Topbar        — название канала, кнопки
│   ├── Stage         — центральная сцена, переключается по view
│   │   ├── Lobby     — приветственный экран (нет активного канала)
│   │   ├── VideoGrid — сетка плиток голосового звонка
│   │   └── ChatPanel — текстовый канал
│   └── Controls      — кнопки микрофон/камера/экран/выйти + пинг
└── Members           — правая панель: состав голосовых каналов
AudioUnlock           — кнопка разблокировки autoplay-звука (Safari/Chrome
                        блокируют воспроизведение медиа до первого жеста)
```

`Stage` переключает `Lobby → VideoGrid → ChatPanel` на основе `useUiStore().view` (`'lobby' | 'voice' | 'text'`). Голосовой и текстовый канал независимы: можно сидеть в звонке и параллельно открыть чат другого канала.

---

## Стейт-менеджмент (Zustand)

### `stores/ui.ts` — навигация и глобальный каркас

```typescript
view: 'lobby' | 'voice' | 'text'
textRoom: string | null    // активный текстовый канал
voiceRoom: string | null   // активный голосовой канал
callsign: string           // @-тег (имя пользователя)
```

Изменение `textRoom` слушает `SocketProvider` — при смене отправляет `chat-join` / `chat-leave` на сервер.

### `stores/voice.ts` — состояние голосового звонка

```typescript
tiles: VoiceTile[]         // плитки в видеосетке (local + собеседники)
micOn / camOn / screenOn   // состояние медиа
status: string             // строка статуса подключения
presence: VoicePresence    // { имя_канала: участники } — кто где сидит
focusedId: string | null   // плитка в «театр-режиме»
ping: VoicePing            // RTT до собеседников (каждые 3 с)
```

Стор — только «витрина» для React. Вся императивная механика (RTCPeerConnection, MediaStream, sender'ы) живёт в `lib/voice.ts` как модульные переменные.

### `stores/chat.ts` — текстовый канал

Сообщения и ростер (список участников в канале).

---

## Ключевые модули (`lib/`)

### `lib/voice.ts` — mesh-WebRTC менеджер

Центральный модуль. Императивное состояние (Map `peers`, `localStream`, флаги `micOn/camOn/screenOn`) живёт в модульных переменных. React-компоненты читают только `useVoiceStore`.

Публичные функции: `initVoice()`, `joinVoice(room, label)`, `leaveVoice()`, `toggleMic()`, `toggleCamera()`, `toggleScreen()`, `setScreenMode()`, `toggleFocus()`.

Особенности:
- **Perfect negotiation**: при коллизии offer'ов «вежливая» сторона (меньший socket-id) откатывает свой и принимает чужой.
- Камера и экран занимают **один video-sender** (один слот). Включить оба нельзя — переключаются с заменой трека через `replaceTrack()`.
- `boostVideoBitrate()` из `lib/sdp.ts` патчит SDP offer/answer, повышая лимит b=AS (до 2500 kbps камера, 8000 kbps экран).
- Reconnect: `disconnected` → таймер 8 с → `restartIce()`; `failed` → ещё 15 с → toast → удаление peer.
- SFX-звуки (`lib/sfx.ts`): join/leave/peerJoin/peerLeave/error/reconnect/connLost.

### `lib/socket.ts` — singleton socket.io

Один клиент на всё приложение. В проде — тот же origin (кука уезжает сама). В dev — `NEXT_PUBLIC_SOCKET_URL` указывает на api напрямую.

### `lib/config.ts` — ICE-серверы

`getIceServers()` → `GET /api/config`. Фронт вызывает один раз при `initVoice()`, подставляет TURN если настроен.

### `lib/sdp.ts` — патч SDP

`boostVideoBitrate(sdp)` — чистая функция (нет side-effects), тестируется отдельно.

### `lib/sfx.ts` — пул звуков эфира

Звуковой API эфира — тонкий пул поверх `HTMLAudioElement` (короткие MP3 из `public/sfx`, оригинальные — генерируются `tools/gen-sfx.py`: аддитивный синтез + стерео-реверб). Поддерживает `setSinkId` и общий мут; на SSR — no-op.

---

## UI-примитивы (`components/ui/`)

| Файл | Назначение |
|---|---|
| `glass.tsx` | Glassmorphism-карточка (Liquid Glass эффект) |
| `button.tsx` | shadcn Button |
| `dialog.tsx` | shadcn Dialog |
| `icon.tsx` | SVG-иконка из `public/img/icons/` |

---

## Окружение

```
NEXT_PUBLIC_SOCKET_URL   — в dev: http://localhost:3000 (если api на другом порту)
SITE_PASSWORD            — для middleware.ts (verifyToken)
```

В проде `NEXT_PUBLIC_SOCKET_URL` не задаётся — фронт и бэк на одном origin.

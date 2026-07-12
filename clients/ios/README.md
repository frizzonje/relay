# relay iOS — Swift / SwiftUI

Полностью нативный клиент: SwiftUI + официальный libwebrtc. Реализует протокол
из [docs/protocol.md](../../docs/protocol.md) (web-клиент — референс поведения,
`apps/web/lib/voice.ts` — эталон сигналинга).

## Стек

| Слой | Выбор | Почему |
|---|---|---|
| UI | SwiftUI (iOS 17+) | дизайн сверяется с `apps/web` (мобильная раскладка) |
| WebRTC | [`stasel/WebRTC`](https://github.com/stasel/WebRTC) (SPM, бинарный WebRTC.xcframework от Google) | не собирать libwebrtc самому |
| Сигналинг | [`socket.io-client-swift`](https://github.com/socketio/socket.io-client-swift) (SPM) | сервер говорит на Socket.IO 4 |
| Токен | Keychain | кука `relay_pass` — см. protocol.md §2.3: в handshake передавать `.extraHeaders(["Cookie": ...])` |
| Проект | XcodeGen (`project.yml` в этом каталоге, когда появится код) | .xcodeproj не коммитим — меньше конфликтов |

## Структура (план)

```
Relay/
  App/            RelayApp.swift, конфиг сервера (URL инсталляции)
  Core/
    API.swift         REST: login, config, upload (URLSession)
    SocketClient.swift socket.io: события протокола, реконнект
    CallEngine.swift   mesh: RTCPeerConnection на пира, perfect negotiation
                       (polite = myId < peerId, новичок шлёт offer'ы)
  Features/
    Login/          пароль → Keychain
    Channels/       список серверов/каналов, presence (снапшоты servers/channels)
    Chat/           лента, композер, вложения, реакции
    Call/           сетка участников, mute/deafen/камера, PiP
  DesignSystem/     токены из apps/web (цвета #08090b…, IBM Plex, радиусы)
```

## Порядок работ (MVP → полный)

1. **Логин + сокет**: POST /api/login, кука в Keychain, handshake, приём
   `servers`/`channels` → список каналов на экране.
2. **Чат**: chat-join/history/message (текст) — первый сквозной сценарий.
3. **Голос (только аудио)** ✅ (2026-07-06): join → offers → двусторонний звук с
   web-клиентом. `Core/CallEngine.swift` (mesh, perfect negotiation по `voice.ts`),
   `Core/SDP.swift` (Opus-тюнинг), `Features/Call/CallView.swift` + мини-бар в
   `ChannelsView`. Сборка под симулятор чистая; осталось живьём проверить
   двусторонний звук против деплоя (нужен реальный девайс/второй клиент).
4. media-update/deafen ✅ (мут + глушилка уже в звонке), voice-presence-детали,
   вложения, реакции, выбор имени/тега.
5. Видео/экран, CallKit (нативный звонок), фоновый аудиорежим
   (`UIBackgroundModes: audio, voip`), PiP.

## Гочи, известные заранее

- **Разрешения**: `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`
  в Info.plist — без них креш при getUserMedia-эквиваленте.
- **AVAudioSession**: категория `.playAndRecord` + `.videoChat`, иначе тихий
  динамик/эхо. Deafen = глушить и вывод, и микрофон (как в web).
- **Self-signed TLS** дев-сервера iOS не примет: для разработки использовать
  реальный домен с Let's Encrypt или ATS-исключение только в Debug-конфиге.
- Кука истекает через 30 дней или при смене пароля сервера: признак —
  socket disconnect сразу после connect → показать релогин (protocol.md §9.5).

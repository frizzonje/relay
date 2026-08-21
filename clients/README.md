# Нативные клиенты relay

Каталог для клиентов вне JS-монорепо (pnpm/turbo их не собирают — у каждого
свой тулчейн и свой CI-job). Все клиенты говорят с сервером по одному контракту:
[docs/protocol.md](../docs/protocol.md).

| Платформа | Каталог | Стек | Статус |
|---|---|---|---|
| Web | [`apps/web`](../apps/web) | Next.js 15 / React 19 | ✅ работает (референс-клиент) |
| Windows / macOS | [`desktop/`](desktop/) | Tauri v2 (Rust + системный webview) | ✅ отгружен: MSI/NSIS, dmg |
| Linux | [`desktop-linux/`](desktop-linux/) | Electron (Chromium) | ✅ отгружен: AppImage. Своя оболочка потому, что системный WebKitGTK собран без WebRTC — звонков в Tauri-сборке на Linux не бывает |
| iOS | [`ios/`](ios/) | Swift / SwiftUI + WebRTC.xcframework | план в README |
| Android | `android/` (позже) | Kotlin / Compose + webrtc-android | не начат |

## Принципы

- **Протокол — единственная зависимость.** Клиенты не импортируют код друг
  друга; `@relay/shared` — только для JS-мира. Изменил контракт — обнови
  `packages/shared` **и** `docs/protocol.md` в одном коммите.
- **Web — референс.** Поведение спорных мест сверяется с `apps/web`
  (`lib/voice.ts` — эталон сигналинга и perfect negotiation).
- **Оболочки говорят одними событиями.** У десктопа две оболочки (Tauri и
  Electron), но мост с web-UI один: имена событий и payload'ы общие, и web
  находит его через `apps/web/lib/shell-bridge.ts`. Добавил событие — добавь в
  оба списка (`capabilities/remote.json` и `desktop-linux/src/events.js`).
- **Дизайн** — единый: токены цветов, типографика (IBM Plex), раскладки экранов
  сверяются с `apps/web` как эталонной реализацией.

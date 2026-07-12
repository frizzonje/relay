# Нативные клиенты relay

Каталог для клиентов вне JS-монорепо (pnpm/turbo их не собирают — у каждого
свой тулчейн и свой CI-job). Все клиенты говорят с сервером по одному контракту:
[docs/protocol.md](../docs/protocol.md).

| Платформа | Каталог | Стек | Статус |
|---|---|---|---|
| Web | [`apps/web`](../apps/web) | Next.js 15 / React 19 | ✅ работает (референс-клиент) |
| Windows / Linux | [`desktop/`](desktop/) | Tauri v2 (Rust + системный webview) | ✅ собирается: macOS arm64 (.app/.dmg) + Linux arm64 (.deb) проверены; Windows/Linux-x86_64 — из CI |
| iOS | [`ios/`](ios/) | Swift / SwiftUI + WebRTC.xcframework | план в README |
| Android | `android/` (позже) | Kotlin / Compose + webrtc-android | не начат |
| macOS | — | покрывается Tauri-сборкой desktop | бонус |

## Принципы

- **Протокол — единственная зависимость.** Клиенты не импортируют код друг
  друга; `@relay/shared` — только для JS-мира. Изменил контракт — обнови
  `packages/shared` **и** `docs/protocol.md` в одном коммите.
- **Web — референс.** Поведение спорных мест сверяется с `apps/web`
  (`lib/voice.ts` — эталон сигналинга и perfect negotiation).
- **Дизайн** — единый: токены цветов, типографика (IBM Plex), раскладки экранов
  сверяются с `apps/web` как эталонной реализацией.

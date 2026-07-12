import SwiftUI

// Токены дизайна relay — переносим из apps/web (app/globals.css). Держим 1:1 с
// вебом, чтобы нативный клиент выглядел единообразно. Цвета — из фазы 2 плана.
enum Theme {
    // Фоны
    static let bg0 = Color(hex: 0x08090b)
    static let bg1 = Color(hex: 0x0b0c0f)
    static let bg2 = Color(hex: 0x0f1114)
    // Текст
    static let text = Color(hex: 0xe7e9ec)
    static let textMuted = Color(hex: 0x8b9199)
    static let textFaint = Color(hex: 0x5b6169)
    // Акцент / статусы
    static let accent = Color(hex: 0xe8eaed)
    static let success = Color(hex: 0x46c17f)
    static let danger = Color(hex: 0xe5573f)
    // Рамки
    static let border = Color.white.opacity(0.08)
    static let borderStrong = Color.white.opacity(0.12)

    // Радиусы
    static let radiusLg: CGFloat = 15
    static let radiusMd: CGFloat = 10
    static let radiusSm: CGFloat = 8

    // Моно-шрифт для меток/паролей/таймстампов (IBM Plex Mono в вебе; на iOS без
    // подключения кастомного шрифта берём системный monospaced).
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}

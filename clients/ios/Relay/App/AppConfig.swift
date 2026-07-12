import Foundation
import UIKit

// Адрес инсталляции relay. Нативный клиент — как и web/desktop — работает с любым
// self-hosted сервером; пользователь вводит URL на экране логина. Дефолт — тест-
// деплой (см. deploy overhype.tech). Храним в UserDefaults, токен — в Keychain.
enum AppConfig {
    private static let key = "relay-server-url"
    private static let nameKey = "relay-name"
    static let defaultBaseURL = "https://overhype.tech"

    static var baseURL: String {
        get { UserDefaults.standard.string(forKey: key) ?? defaultBaseURL }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    // Отображаемое имя в голосе/чате (server ограничивает 20 символами).
    // UI выбора имени нет — дефолт из имени устройства.
    static var displayName: String {
        get { UserDefaults.standard.string(forKey: nameKey) ?? UIDevice.current.name }
        set { UserDefaults.standard.set(newValue, forKey: nameKey) }
    }

    // Нормализованный URL без хвостового слэша; nil, если строка не парсится.
    static func url(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        var s = withScheme
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s)
    }
}

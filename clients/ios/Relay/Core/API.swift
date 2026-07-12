import Foundation

// REST-слой (protocol.md §3). Токен предъявляем заголовком `Authorization: Bearer`
// — нативному клиенту это удобнее, чем эмулировать cookie-jar (§2.3). Cookie-jar
// URLSession отключаем, чтобы самим читать `Set-Cookie` из ответа логина.
enum APIError: LocalizedError {
    case badURL
    case invalidPassword
    case rateLimited
    case noToken
    case server(Int)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .badURL: return "Неверный адрес сервера."
        case .invalidPassword: return "Неверный пароль."
        case .rateLimited: return "Слишком много попыток. Подождите пару минут."
        case .noToken: return "Сервер не выдал токен сессии."
        case .server(let code): return "Ошибка сервера (\(code))."
        case .transport(let e): return e.localizedDescription
        }
    }
}

struct APIClient {
    let baseURL: URL

    private var session: URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        return URLSession(configuration: cfg)
    }

    // POST /api/login → токен из заголовка Set-Cookie: relay_pass=<token>.
    func login(password: String) async throws -> String {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["password": password])

        let (_, resp): (Data, URLResponse)
        do {
            (_, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.server(0) }

        switch http.statusCode {
        case 200...299: break
        case 401: throw APIError.invalidPassword
        case 429: throw APIError.rateLimited
        default: throw APIError.server(http.statusCode)
        }

        guard let token = Self.extractToken(from: http) else { throw APIError.noToken }
        return token
    }

    // GET /api/config → ICE-серверы (нужны на этапе звонка; здесь — как проба токена).
    func config(token: String) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/config"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode)
        else { throw APIError.server((resp as? HTTPURLResponse)?.statusCode ?? 0) }
        return data
    }

    // Вытащить значение relay_pass из Set-Cookie. Заголовок вида
    // `relay_pass=<token>; HttpOnly; SameSite=Lax; ...` — берём первую пару.
    static func extractToken(from http: HTTPURLResponse) -> String? {
        guard let raw = http.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        for part in raw.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { continue }
            if kv[0].trimmingCharacters(in: .whitespaces) == "relay_pass" {
                return kv[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }
}

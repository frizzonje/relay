import Foundation
import SwiftUI

// Состояние приложения: адрес сервера, токен, авторизация, живой сокет. Держит
// связку API (логин) + SocketClient (сигналинг). Один на приложение (@main инжектит
// в окружение). @MainActor — всё UI-состояние меняется на главном потоке.
@MainActor
final class Session: ObservableObject {
    enum Phase: Equatable {
        case loggedOut
        case connecting
        case ready
    }

    @Published var phase: Phase = .loggedOut
    @Published var serverURLText: String = AppConfig.baseURL
    @Published var loginError: String?
    @Published var isBusy = false

    let socket = SocketClient()
    let call: CallEngine

    private var token: String?
    private var baseURL: URL?

    init() {
        call = CallEngine(signaling: socket, displayName: { AppConfig.displayName })
        socket.onAuthExpired = { [weak self] in
            Task { @MainActor in self?.logout(reason: "Сессия истекла — войдите заново.") }
        }
        // Автологин, если токен уже в Keychain и адрес сохранён.
        if let saved = Keychain.load(), let url = AppConfig.url(from: AppConfig.baseURL) {
            token = saved
            baseURL = url
            connect()
        }
    }

    func login(urlText: String, password: String) async {
        loginError = nil
        guard let url = AppConfig.url(from: urlText) else {
            loginError = APIError.badURL.localizedDescription
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let tok = try await APIClient(baseURL: url).login(password: password)
            AppConfig.baseURL = url.absoluteString
            Keychain.save(tok)
            token = tok
            baseURL = url
            connect()
        } catch {
            loginError = (error as? APIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    func logout(reason: String? = nil) {
        call.leave()
        socket.disconnect()
        Keychain.delete()
        token = nil
        phase = .loggedOut
        loginError = reason
    }

    private func connect() {
        guard let baseURL, let token else { return }
        phase = .connecting
        socket.connect(baseURL: baseURL, token: token)
        // ICE-серверы для звонка (там может быть TURN); пока летит запрос —
        // дефолтный STUN внутри CallEngine.
        Task { [call] in
            if let data = try? await APIClient(baseURL: baseURL).config(token: token),
                let cfg = try? JSONDecoder().decode(ConfigResponse.self, from: data)
            {
                call.setIceServers(cfg.iceServers)
            }
        }
        // Как только сокет подтвердит connect — переходим в ready. Наблюдаем за
        // изменением состояния через Combine.
        Task {
            for await s in socket.$state.values {
                if s == .connected { phase = .ready; break }
                if s == .disconnected { break } // onAuthExpired разрулит релогин
            }
        }
    }
}

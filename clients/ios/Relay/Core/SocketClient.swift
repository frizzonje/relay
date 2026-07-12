import Foundation
import SocketIO

// Сигналинг relay поверх Socket.IO 4 (protocol.md §4–6). На этом этапе —
// подключение с токеном, снапшоты реестров (servers/channels/voice-presence) и
// текстовый чат. Голос (WebRTC) добавится на этапе 3.
//
// Токен предъявляем заголовком Authorization: connectParams у swift-клиента
// уходят в query, а не в handshake-`auth`, поэтому берём extraHeaders (§2.3).
final class SocketClient: ObservableObject {
    enum ConnState: Equatable {
        case idle
        case connecting
        case connected
        case disconnected
    }

    @Published private(set) var state: ConnState = .idle
    @Published private(set) var servers: [Server] = []
    @Published private(set) var channels: [Channel] = []
    @Published private(set) var voicePresence: [String: [VoicePeer]] = [:]

    // Текстовый чат текущего открытого канала.
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var roster: [String] = []

    // Токен протух (сервер сделал disconnect сразу после connect) → релогин.
    var onAuthExpired: (() -> Void)?

    // ── Голосовой сигналинг (protocol.md §7). CallEngine присваивает эти
    // замыкания; вызываются на главном потоке. ────────────────────────────────
    var onPeers: (([SignalPeer]) -> Void)?
    var onPeerJoined: ((_ id: String, _ name: String?) -> Void)?
    var onPeerLeft: ((_ id: String) -> Void)?
    var onOffer: ((SdpMessage) -> Void)?
    var onAnswer: ((SdpMessage) -> Void)?
    var onRemoteIce: ((IceMessage) -> Void)?
    var onPeerMedia: ((_ from: String, _ micOn: Bool?, _ deafened: Bool?) -> Void)?
    var onPeerRenamed: ((_ id: String, _ name: String) -> Void)?

    // Мой server-assigned socket.io id — база роли polite в perfect negotiation.
    var sid: String? { socket?.sid }

    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var connectedAt: Date?
    private var manualDisconnect = false
    // Была ли за эту сессию хоть одна стабильная (>2с) связь. Пока не было —
    // быстрый обрыв трактуем как протухший токен (protocol.md §9.5); после —
    // это сетевой сбой, socket.io сам переподключится, разлогинивать нельзя.
    private var hadStableSession = false
    private var stableWork: DispatchWorkItem?

    func connect(baseURL: URL, token: String) {
        disconnect() // на всякий случай снимаем прежнее
        manualDisconnect = false
        hadStableSession = false
        state = .connecting

        let mgr = SocketManager(
            socketURL: baseURL,
            config: [
                .log(false),
                .compress,
                .reconnects(true),
                .extraHeaders(["Authorization": "Bearer \(token)"]),
            ]
        )
        let sock = mgr.defaultSocket
        manager = mgr
        socket = sock

        sock.on(clientEvent: .connect) { [weak self] _, _ in
            self?.onMain {
                self?.connectedAt = Date()
                self?.state = .connected
                // Продержались 2с — считаем сессию состоявшейся: дальше обрывы
                // это сеть, не токен.
                self?.stableWork?.cancel()
                let work = DispatchWorkItem { self?.hadStableSession = true }
                self?.stableWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
            }
        }
        sock.on(clientEvent: .disconnect) { [weak self] _, _ in
            self?.onMain { self?.handleDisconnect() }
        }
        sock.on("servers") { [weak self] data, _ in
            self?.onMain { self?.servers = SocketClient.decode(data.first) ?? [] }
        }
        sock.on("channels") { [weak self] data, _ in
            self?.onMain { self?.channels = SocketClient.decode(data.first) ?? [] }
        }
        sock.on("voice-presence") { [weak self] data, _ in
            self?.onMain { self?.voicePresence = SocketClient.decode(data.first) ?? [:] }
        }
        sock.on("chat-history") { [weak self] data, _ in
            self?.onMain { self?.messages = SocketClient.decode(data.first) ?? [] }
        }
        sock.on("chat") { [weak self] data, _ in
            self?.onMain {
                guard let msg: ChatMessage = SocketClient.decode(data.first) else { return }
                self?.messages.append(msg)
            }
        }
        sock.on("chat-roster") { [weak self] data, _ in
            self?.onMain { self?.roster = SocketClient.decode(data.first) ?? [] }
        }

        // ── Голос (WebRTC mesh) ──────────────────────────────────────────────────
        sock.on("peers") { [weak self] data, _ in
            let list: [SignalPeer] = SocketClient.decode(data.first) ?? []
            self?.onMain { self?.onPeers?(list) }
        }
        sock.on("peer-joined") { [weak self] data, _ in
            guard let d = data.first as? [String: Any], let id = d["id"] as? String else { return }
            let name = d["name"] as? String
            self?.onMain { self?.onPeerJoined?(id, name) }
        }
        sock.on("peer-left") { [weak self] data, _ in
            guard let d = data.first as? [String: Any], let id = d["id"] as? String else { return }
            self?.onMain { self?.onPeerLeft?(id) }
        }
        sock.on("offer") { [weak self] data, _ in
            guard let msg = SocketClient.parseSdp(data.first) else { return }
            self?.onMain { self?.onOffer?(msg) }
        }
        sock.on("answer") { [weak self] data, _ in
            guard let msg = SocketClient.parseSdp(data.first) else { return }
            self?.onMain { self?.onAnswer?(msg) }
        }
        sock.on("ice-candidate") { [weak self] data, _ in
            guard let msg = SocketClient.parseIce(data.first) else { return }
            self?.onMain { self?.onRemoteIce?(msg) }
        }
        sock.on("media-update") { [weak self] data, _ in
            guard let d = data.first as? [String: Any], let from = d["from"] as? String else { return }
            self?.onMain { self?.onPeerMedia?(from, d["micOn"] as? Bool, d["deafened"] as? Bool) }
        }
        sock.on("peer-renamed") { [weak self] data, _ in
            guard let d = data.first as? [String: Any], let id = d["id"] as? String,
                let name = d["name"] as? String
            else { return }
            self?.onMain { self?.onPeerRenamed?(id, name) }
        }

        sock.connect()
    }

    func disconnect() {
        manualDisconnect = true
        stableWork?.cancel()
        stableWork = nil
        socket?.disconnect()
        socket = nil
        manager = nil
        state = .idle
        connectedAt = nil
        hadStableSession = false
    }

    // ── Текстовый чат ────────────────────────────────────────────────────────
    func chatJoin(slug: String, name: String?) {
        messages = []
        roster = []
        var payload: [String: Any] = ["room": slug]
        if let name { payload["name"] = name }
        socket?.emit("chat-join", payload)
    }

    func chatLeave() {
        socket?.emit("chat-leave")
        messages = []
        roster = []
    }

    func sendMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        socket?.emit("chat-message", ["text": String(trimmed.prefix(500))])
    }

    // ── Голос: исходящие (protocol.md §7.1/§7.3) ──────────────────────────────
    func voiceJoin(room: String, name: String?) {
        var payload: [String: Any] = ["room": room]
        if let name, !name.isEmpty { payload["name"] = name }
        socket?.emit("join", payload)
    }

    func voiceLeave() { socket?.emit("leave") }

    func sendOffer(to: String, type: String, sdp: String) {
        socket?.emit("offer", ["to": to, "sdp": ["type": type, "sdp": sdp]])
    }

    func sendAnswer(to: String, type: String, sdp: String) {
        socket?.emit("answer", ["to": to, "sdp": ["type": type, "sdp": sdp]])
    }

    func sendIce(to: String, candidate: String, sdpMid: String?, sdpMLineIndex: Int32) {
        var c: [String: Any] = ["candidate": candidate, "sdpMLineIndex": Int(sdpMLineIndex)]
        if let sdpMid { c["sdpMid"] = sdpMid }
        socket?.emit("ice-candidate", ["to": to, "candidate": c])
    }

    // Аудио-этап: camOn/screenOn всегда false, шлём мут/deafen.
    func voiceMediaUpdate(micOn: Bool, deafened: Bool) {
        socket?.emit(
            "media-update",
            ["camOn": false, "screenOn": false, "micOn": micOn, "deafened": deafened])
    }

    func voiceRename(name: String) { socket?.emit("rename", ["name": name]) }

    // Вложенные payload'ы sdp/candidate разбираем вручную (Codable через
    // JSONSerialization ломается на разнотипных значениях candidate).
    static func parseSdp(_ any: Any?) -> SdpMessage? {
        guard let d = any as? [String: Any], let from = d["from"] as? String,
            let sdpDict = d["sdp"] as? [String: Any],
            let type = sdpDict["type"] as? String, let sdp = sdpDict["sdp"] as? String
        else { return nil }
        return SdpMessage(from: from, name: d["name"] as? String, type: type, sdp: sdp)
    }

    static func parseIce(_ any: Any?) -> IceMessage? {
        guard let d = any as? [String: Any], let from = d["from"] as? String,
            let c = d["candidate"] as? [String: Any], let cand = c["candidate"] as? String
        else { return nil }
        return IceMessage(
            from: from,
            candidate: cand,
            sdpMid: c["sdpMid"] as? String,
            sdpMLineIndex: (c["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0)
    }

    // ── Внутреннее ────────────────────────────────────────────────────────────
    // Мгновенный disconnect после connect = невалидный токен (protocol.md §9.5).
    private func handleDisconnect() {
        let wasConnected = connectedAt != nil
        let quick = connectedAt.map { Date().timeIntervalSince($0) < 2 } ?? false
        stableWork?.cancel()
        stableWork = nil
        state = .disconnected
        connectedAt = nil
        // Быстрый обрыв = протухший токен только ДО первой стабильной сессии.
        // После — это сетевой сбой (сервер моргнул, Wi-Fi): socket.io сам
        // переподключится, разлогинивать нельзя.
        if !manualDisconnect && wasConnected && quick && !hadStableSession {
            onAuthExpired?()
        }
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }

    // Socket.IO отдаёт payload как JSON-совместимый объект ([Any]/[String:Any]) —
    // пере-сериализуем и декодируем в Codable-тип.
    static func decode<T: Decodable>(_ any: Any?) -> T? {
        guard let any, JSONSerialization.isValidJSONObject(any) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

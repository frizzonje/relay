import Foundation

// Типы протокола relay — перевод packages/shared/src/index.ts (см. docs/protocol.md).
// При изменении контракта на сервере обновлять и здесь, и в protocol.md.

struct Server: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let emoji: String?
    let removable: Bool
    let locked: Bool?
}

struct Channel: Codable, Identifiable, Hashable {
    let id: String
    let serverId: String
    let type: ChannelType
    let name: String
    let slug: String
    let removable: Bool

    enum ChannelType: String, Codable {
        case text
        case voice
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    // Сервер не всегда шлёт id (системные сообщения) — генерим локальный ключ.
    var id: String { serverId ?? "\(ts)-\(name ?? "sys")-\(text)" }
    let serverId: String?
    let name: String?
    let text: String
    let ts: Double
    let system: Bool?

    enum CodingKeys: String, CodingKey {
        case serverId = "id"
        case name, text, ts, system
    }
}

struct VoicePeer: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let micOn: Bool?
    let deafened: Bool?
}

// ── Голосовой сигналинг (protocol.md §7). Транспортные payload'ы. ────────────
// SignalPeer декодируется из `peers`; Sdp/Ice-сообщения парсятся вручную
// (вложенные объекты) — см. SocketClient.parseSdp/parseIce.
struct SignalPeer: Codable, Hashable {
    let id: String
    let name: String?
}

struct SdpMessage {
    let from: String
    let name: String?
    let type: String  // "offer" | "answer"
    let sdp: String
}

struct IceMessage {
    let from: String
    let candidate: String
    let sdpMid: String?
    let sdpMLineIndex: Int32
}

// GET /api/config (protocol.md §3) — ICE-серверы для WebRTC (там же может быть TURN).
struct IceServerConfig: Codable, Hashable {
    let urls: [String]
    let username: String?
    let credential: String?
}

struct ConfigResponse: Codable {
    let iceServers: [IceServerConfig]
}

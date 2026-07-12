import AVFoundation
import Combine
import Foundation
import WebRTC

// Mesh-WebRTC для аудио-звонка (protocol.md §7), порт apps/web/lib/voice.ts —
// эталон поведения. На каждого собеседника свой RTCPeerConnection; perfect
// negotiation с детерминированной ролью polite (у кого socket.id меньше).
// Новичок, получив `peers`, шлёт offer каждому; старожилы отвечают. Видео/экран
// не поддерживаются — здесь только микрофон.
//
// Императивное состояние (peers, треки) живёт в модели; наружу отдаём
// реактивную витрину `participants` + флаги микрофона/deafen для CallView.
//
// Потоки: замыкания socket.io приходят на главном (SocketClient.onMain), а
// коллбэки/делегаты WebRTC — на своих рабочих потоках. Всё, что трогает peers и
// @Published, маршалим на главный поток (`main`).
final class CallEngine: NSObject, ObservableObject {
    // ── Витрина для UI ────────────────────────────────────────────────────────
    @Published private(set) var inCall = false
    @Published private(set) var room: String?
    @Published private(set) var roomLabel = ""
    @Published private(set) var participants: [CallParticipant] = []
    @Published private(set) var micOn = true
    @Published private(set) var deafened = false
    @Published private(set) var reconnecting = false

    struct CallParticipant: Identifiable, Equatable {
        let id: String  // "local" для себя, иначе socket.id собеседника
        var name: String
        var isLocal: Bool
        var micOn: Bool
        var deafened: Bool
        var state: State

        enum State { case connecting, connected, reconnecting, failed }
    }

    // ── Императивное состояние ─────────────────────────────────────────────────
    private final class Peer {
        let id: String
        var name: String
        let pc: RTCPeerConnection
        let polite: Bool
        var makingOffer = false
        var ignoreOffer = false
        var pending: [RTCIceCandidate] = []
        // Все входящие аудиодорожки пира (голос + возможный звук демонстрации
        // с web); deafen глушит их все.
        var remoteAudioTracks: [RTCAudioTrack] = []
        var micOn = true
        var deafened = false
        var state: CallParticipant.State = .connecting
        var failWork: DispatchWorkItem?

        init(id: String, name: String, pc: RTCPeerConnection, polite: Bool) {
            self.id = id
            self.name = name
            self.pc = pc
            self.polite = polite
        }
    }

    private let signaling: SocketClient
    private let displayName: () -> String

    private var peers: [String: Peer] = [:]
    private var localAudioTrack: RTCAudioTrack?
    private var micWasOnBeforeDeafen = true
    private var iceServers: [RTCIceServer] = [
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
    ]
    private var cancellables = Set<AnyCancellable>()

    // Одна фабрика на приложение (ICE/SSL инициализируется единожды).
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    init(signaling: SocketClient, displayName: @escaping () -> String) {
        self.signaling = signaling
        self.displayName = displayName
        super.init()
        wireSignaling()
        // Реконнект сокета: старые пиры (иные socket.id) мертвы — гасим и
        // перезаходим, сервер пришлёт свежий `peers`.
        signaling.$state
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.handleSignalingState($0) }
            .store(in: &cancellables)
    }

    // Обновить ICE-серверы (Session тянет GET /api/config после логина).
    func setIceServers(_ configs: [IceServerConfig]) {
        let mapped = configs.map { c -> RTCIceServer in
            if let u = c.username, let cred = c.credential {
                return RTCIceServer(urlStrings: c.urls, username: u, credential: cred)
            }
            return RTCIceServer(urlStrings: c.urls)
        }
        if !mapped.isEmpty { iceServers = mapped }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Вход / выход
    // ─────────────────────────────────────────────────────────────────────────

    func join(slug: String, label: String) {
        if room == slug {  // уже на связи в этой комнате — просто показать
            inCall = true
            return
        }
        if room != nil { leave(hard: false) }  // мягкая пересадка между каналами

        configureAudioSession(active: true)
        if localAudioTrack == nil { localAudioTrack = makeLocalAudioTrack() }

        room = slug
        roomLabel = label
        inCall = true
        reconnecting = false
        // Глушилка переживает пересадку, микрофон — открыт (если не под deafen).
        micOn = !deafened
        localAudioTrack?.isEnabled = micOn

        signaling.voiceJoin(room: slug, name: String(displayName().prefix(20)))
        // Сразу за join — своё медиасостояние (сервер его сбросил).
        signaling.voiceMediaUpdate(micOn: micOn, deafened: deafened)
        syncParticipants()
    }

    // hard=true — полный выход (освобождаем микрофон, гасим аудиосессию).
    // hard=false — мягкая пересадка между голосовыми (поток микрофона живёт).
    func leave(hard: Bool = true) {
        if room != nil { signaling.voiceLeave() }
        teardownPeers()
        room = nil
        roomLabel = ""
        reconnecting = false
        participants = []
        if !hard {
            inCall = false
            return
        }
        inCall = false
        localAudioTrack?.isEnabled = false
        localAudioTrack = nil
        configureAudioSession(active: false)
        deafened = false
        micOn = true
        micWasOnBeforeDeafen = true
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Микрофон / глушилка
    // ─────────────────────────────────────────────────────────────────────────

    func toggleMic() {
        // Включение микрофона под deafen снимает и её (как в web): нелепо говорить,
        // не слыша ответов.
        if !micOn && deafened {
            micWasOnBeforeDeafen = true
            setDeafened(false)
            return
        }
        micOn.toggle()
        localAudioTrack?.isEnabled = micOn
        signaling.voiceMediaUpdate(micOn: micOn, deafened: deafened)
        syncParticipants()
    }

    func toggleDeafen() { setDeafened(!deafened) }

    private func setDeafened(_ on: Bool) {
        guard on != deafened else { return }
        deafened = on
        if on {
            micWasOnBeforeDeafen = micOn
            micOn = false
        } else {
            micOn = micWasOnBeforeDeafen
        }
        localAudioTrack?.isEnabled = micOn
        applyDeafenToRemotes()
        signaling.voiceMediaUpdate(micOn: micOn, deafened: deafened)
        syncParticipants()
    }

    private func applyDeafenToRemotes() {
        for peer in peers.values {
            for track in peer.remoteAudioTracks { track.isEnabled = !deafened }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Сигналинг: подписки
    // ─────────────────────────────────────────────────────────────────────────

    private func wireSignaling() {
        signaling.onPeers = { [weak self] list in self?.handlePeers(list) }
        signaling.onPeerJoined = { _, _ in }  // ждём offer от новичка
        signaling.onPeerLeft = { [weak self] id in self?.removePeer(id) }
        signaling.onOffer = { [weak self] msg in self?.handleRemoteOffer(msg) }
        signaling.onAnswer = { [weak self] msg in self?.handleRemoteAnswer(msg) }
        signaling.onRemoteIce = { [weak self] msg in self?.handleRemoteIce(msg) }
        signaling.onPeerMedia = { [weak self] from, mic, deaf in
            self?.handlePeerMedia(from: from, micOn: mic, deafened: deaf)
        }
        signaling.onPeerRenamed = { [weak self] id, name in self?.handlePeerRenamed(id, name) }
    }

    private func handleSignalingState(_ s: SocketClient.ConnState) {
        guard room != nil else { return }
        switch s {
        case .connecting, .disconnected:
            if !peers.isEmpty || !reconnecting {
                reconnecting = true
                teardownPeers()
                syncParticipants()
            }
        case .connected:
            // Реконнект: перезаходим в комнату, сервер пришлёт свежий `peers`.
            if reconnecting, let room {
                reconnecting = false
                signaling.voiceJoin(room: room, name: String(displayName().prefix(20)))
                signaling.voiceMediaUpdate(micOn: micOn, deafened: deafened)
            }
        case .idle:
            break
        }
    }

    private func handlePeers(_ list: [SignalPeer]) {
        guard room != nil, localAudioTrack != nil else { return }
        for p in list where peers[p.id] == nil {
            createPeer(id: p.id, name: p.name ?? "Участник", initiator: true)
        }
        syncParticipants()
    }

    private func handleRemoteOffer(_ msg: SdpMessage) {
        guard room != nil, localAudioTrack != nil else { return }
        let fresh = peers[msg.from] == nil
        if fresh { createPeer(id: msg.from, name: msg.name ?? "Участник", initiator: false) }
        guard let peer = peers[msg.from] else { return }
        let pc = peer.pc

        // Perfect negotiation: невежливая сторона при коллизии игнорирует offer.
        let collision = peer.makingOffer || pc.signalingState != .stable
        peer.ignoreOffer = !peer.polite && collision
        if peer.ignoreOffer { return }

        let remote = RTCSessionDescription(type: .offer, sdp: msg.sdp)
        let applyRemote: () -> Void = { [weak self] in
            pc.setRemoteDescription(remote) { [weak self] err in
                self?.main {
                    guard err == nil else {
                        NSLog("[relay] setRemoteDescription(offer) failed: \(err!)")
                        return
                    }
                    self?.drainCandidates(peer)
                    self?.makeAnswer(peer)
                }
            }
        }
        // Вежливая сторона при коллизии откатывает свой offer (в аудио-only
        // практически недостижимо: ренеготиации нет, offer один).
        if peer.polite && collision {
            pc.setLocalDescription(RTCSessionDescription(type: .rollback, sdp: "")) { [weak self] _ in
                self?.main(applyRemote)
            }
        } else {
            applyRemote()
        }
    }

    private func handleRemoteAnswer(_ msg: SdpMessage) {
        guard let peer = peers[msg.from], peer.pc.signalingState == .haveLocalOffer else { return }
        let remote = RTCSessionDescription(type: .answer, sdp: msg.sdp)
        peer.pc.setRemoteDescription(remote) { [weak self] err in
            self?.main {
                if let err { NSLog("[relay] setRemoteDescription(answer) failed: \(err)") }
                self?.drainCandidates(peer)
            }
        }
    }

    private func handleRemoteIce(_ msg: IceMessage) {
        guard let peer = peers[msg.from] else { return }
        let cand = RTCIceCandidate(
            sdp: msg.candidate, sdpMLineIndex: msg.sdpMLineIndex, sdpMid: msg.sdpMid)
        // Кандидаты до setRemoteDescription буферизуем (protocol.md §7.2.3).
        if peer.pc.remoteDescription != nil {
            peer.pc.add(cand) { _ in }
        } else {
            peer.pending.append(cand)
        }
    }

    private func handlePeerMedia(from: String, micOn: Bool?, deafened: Bool?) {
        guard let peer = peers[from] else { return }
        if let micOn { peer.micOn = micOn }
        if let deafened { peer.deafened = deafened }
        syncParticipants()
    }

    private func handlePeerRenamed(_ id: String, _ name: String) {
        guard let peer = peers[id] else { return }
        peer.name = name
        syncParticipants()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Peer lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    private func createPeer(id: String, name: String, initiator: Bool) {
        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceCandidatePoolSize = 4
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard
            let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: nil)
        else { return }

        // Вежливая сторона уступает при одновременных offer'ах: роль по socket.id.
        let mySid = signaling.sid ?? ""
        let peer = Peer(id: id, name: name, pc: pc, polite: mySid < id)
        peers[id] = peer
        pc.delegate = self

        if let track = localAudioTrack { pc.add(track, streamIds: ["relay-local"]) }

        // Инициатор (мы — новичок) сразу шлёт offer; отвечающая сторона своё аудио
        // унесёт в answer, встречный offer не нужен.
        if initiator { makeOffer(peer) }
    }

    private func makeOffer(_ peer: Peer) {
        peer.makingOffer = true
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peer.pc.offer(for: constraints) { [weak self] sdp, err in
            self?.main {
                guard let self else { return }
                guard let sdp else {
                    peer.makingOffer = false
                    return
                }
                // Пока считали offer, мог прийти встречный (glare) и сменить
                // состояние — тогда свой offer не нужен (ответим в handleRemoteOffer).
                guard peer.pc.signalingState == .stable else {
                    peer.makingOffer = false
                    return
                }
                let tuned = RTCSessionDescription(type: sdp.type, sdp: SDPTuner.boostAudio(sdp.sdp))
                peer.pc.setLocalDescription(tuned) { [weak self] err in
                    self?.main {
                        peer.makingOffer = false
                        guard err == nil else {
                            NSLog("[relay] setLocalDescription(offer) failed: \(err!)")
                            return
                        }
                        self?.signaling.sendOffer(
                            to: peer.id, type: Self.typeString(tuned.type), sdp: tuned.sdp)
                    }
                }
            }
        }
    }

    private func makeAnswer(_ peer: Peer) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peer.pc.answer(for: constraints) { [weak self] sdp, err in
            self?.main {
                guard let self, let sdp else { return }
                let tuned = RTCSessionDescription(type: sdp.type, sdp: SDPTuner.boostAudio(sdp.sdp))
                peer.pc.setLocalDescription(tuned) { [weak self] err in
                    self?.main {
                        guard err == nil else {
                            NSLog("[relay] setLocalDescription(answer) failed: \(err!)")
                            return
                        }
                        self?.signaling.sendAnswer(
                            to: peer.id, type: Self.typeString(tuned.type), sdp: tuned.sdp)
                    }
                }
            }
        }
    }

    private func drainCandidates(_ peer: Peer) {
        guard peer.pc.remoteDescription != nil else { return }
        for cand in peer.pending { peer.pc.add(cand) { _ in } }
        peer.pending.removeAll()
    }

    private func removePeer(_ id: String) {
        guard let peer = peers.removeValue(forKey: id) else { return }
        peer.failWork?.cancel()
        peer.pc.close()
        syncParticipants()
    }

    private func teardownPeers() {
        for peer in peers.values {
            peer.failWork?.cancel()
            peer.pc.close()
        }
        peers.removeAll()
    }

    // Свод connectionState + iceConnectionState в одно UI-состояние. На iOS
    // connectionState приходит ненадёжно — ICE закрывает пробел (как в voice.ts).
    private func applyConnState(_ peer: Peer) {
        let c = peer.pc.connectionState
        let i = peer.pc.iceConnectionState
        let state: CallParticipant.State
        if c == .connected || i == .connected || i == .completed {
            state = .connected
        } else if c == .failed || i == .failed {
            state = .failed
        } else if c == .disconnected || i == .disconnected {
            state = .reconnecting
        } else {
            state = .connecting
        }
        guard peer.state != state else { return }
        peer.state = state
        peer.failWork?.cancel()
        peer.failWork = nil
        switch state {
        case .connected:
            tuneAudioSenders(peer)
        case .reconnecting:
            // >8с в disconnected → restartIce (protocol.md §7.2.4).
            let work = DispatchWorkItem { [weak peer] in peer?.pc.restartIce() }
            peer.failWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
        case .failed:
            peer.pc.restartIce()
            let id = peer.id
            let work = DispatchWorkItem { [weak self] in self?.removePeer(id) }
            peer.failWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
        case .connecting:
            break
        }
        syncParticipants()
    }

    // Потолок битрейта голосового sender'а (SDP задаёт предел кодеку, а это —
    // фактический максимум кодировщика). Приоритет high, чтобы под нагрузкой
    // голос не душился (как в voice.ts).
    private func tuneAudioSenders(_ peer: Peer) {
        for sender in peer.pc.senders where sender.track?.kind == "audio" {
            let params = sender.parameters
            if params.encodings.isEmpty { continue }
            for enc in params.encodings {
                enc.maxBitrateBps = NSNumber(value: 128_000)
                enc.networkPriority = .high
            }
            sender.parameters = params
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Аудиосессия / локальный трек
    // ─────────────────────────────────────────────────────────────────────────

    private func makeLocalAudioTrack() -> RTCAudioTrack {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let source = Self.factory.audioSource(with: constraints)
        return Self.factory.audioTrack(with: source, trackId: "relay-audio0")
    }

    // Категория .playAndRecord + режим .videoChat — иначе тихий динамик/эхо
    // (README §Гочи). Deafen глушит вход, не трогая сессию.
    private func configureAudioSession(active: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        if active {
            let config = RTCAudioSessionConfiguration.webRTC()
            config.category = AVAudioSession.Category.playAndRecord.rawValue
            config.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            config.mode = AVAudioSession.Mode.videoChat.rawValue
            do {
                try session.setConfiguration(config, active: true)
            } catch {
                NSLog("[relay] audio session activate failed: \(error)")
            }
        } else {
            do {
                try session.setActive(false)
            } catch {
                NSLog("[relay] audio session deactivate failed: \(error)")
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Витрина
    // ─────────────────────────────────────────────────────────────────────────

    private func syncParticipants() {
        var list: [CallParticipant] = []
        if room != nil {
            list.append(
                CallParticipant(
                    id: "local", name: displayName(), isLocal: true, micOn: micOn,
                    deafened: deafened, state: .connected))
        }
        for peer in peers.values.sorted(by: { $0.id < $1.id }) {
            list.append(
                CallParticipant(
                    id: peer.id, name: peer.name, isLocal: false, micOn: peer.micOn,
                    deafened: peer.deafened, state: peer.state))
        }
        participants = list
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Хелперы
    // ─────────────────────────────────────────────────────────────────────────

    private func main(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }

    private static func typeString(_ t: RTCSdpType) -> String {
        switch t {
        case .offer: return "offer"
        case .answer: return "answer"
        case .prAnswer: return "pranswer"
        case .rollback: return "rollback"
        @unknown default: return "offer"
        }
    }
}

// MARK: - RTCPeerConnectionDelegate
// Коллбэки WebRTC приходят на рабочих потоках — всё маршалим на главный (`main`),
// где живёт словарь peers и @Published-витрина.
extension CallEngine: RTCPeerConnectionDelegate {
    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        main { [weak self] in
            guard let self, let peer = self.peer(for: pc) else { return }
            self.signaling.sendIce(
                to: peer.id, candidate: candidate.sdp, sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex)
        }
    }

    // Unified Plan: входящий трек приходит через rtpReceiver.
    func peerConnection(
        _ pc: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]
    ) {
        guard let audio = rtpReceiver.track as? RTCAudioTrack else { return }
        main { [weak self] in
            guard let self, let peer = self.peer(for: pc) else { return }
            peer.remoteAudioTracks.append(audio)
            audio.isEnabled = !self.deafened  // под deafen новый голос сразу немой
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        main { [weak self] in
            guard let self, let peer = self.peer(for: pc) else { return }
            self.applyConnState(peer)
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        main { [weak self] in
            guard let self, let peer = self.peer(for: pc) else { return }
            self.applyConnState(peer)
        }
    }

    // Ренеготиацию не ведём вручную из shouldNegotiate — offer'ы гоним сами
    // (новичок инициирует). Для аудио-only треки фиксированы, доп. кругов нет.
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    private func peer(for pc: RTCPeerConnection) -> Peer? {
        peers.values.first { $0.pc === pc }
    }
}

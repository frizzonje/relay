import Foundation

// Порт apps/web/lib/sdp.ts (boostAudioBitrate) — тюним Opus в SDP до «discord-
// уровня»: стерео, высокий средний битрейт, in-band FEC, без DTX. Дефолт WebRTC
// для голоса ~32 кбит/с моно, и звонок звучит глухо. Видео-часть (boostVideoBitrate)
// не переносим — клиент только аудио.
//
// Это ПОТОЛОК кодека в SDP (maxaveragebitrate); фактический максимум sender'а
// задаётся отдельно через encodings.maxBitrate (см. CallEngine).
enum SDPTuner {
    static let opusMaxBitrate = 256_000

    // Параметры fmtp Opus, которые навязываем (перетирая встречные значения).
    private static let opusParams: [(String, String)] = [
        ("stereo", "1"),
        ("sprop-stereo", "1"),
        ("maxaveragebitrate", String(opusMaxBitrate)),
        ("maxplaybackrate", "48000"),
        ("useinbandfec", "1"),
        ("usedtx", "0"),
        ("minptime", "10"),
    ]

    /// Прокачивает качество Opus в SDP. Для каждого opus-кодека выставляет stereo,
    /// высокий maxaveragebitrate, FEC и т.д.; кодеку без строки `a=fmtp` дописывает
    /// её сразу после `a=rtpmap`. Не-аудио строки не трогает. Идемпотентна.
    static func boostAudio(_ sdp: String) -> String {
        // libwebrtc отдаёт SDP с \r\n; на всякий случай не ломаемся и на \n.
        let sep = sdp.contains("\r\n") ? "\r\n" : "\n"
        var lines = sdp.components(separatedBy: sep)

        // Payload-типы opus и индекс их rtpmap-строки (чтобы вставить fmtp при нужде).
        var opusRtpmapIdx: [String: Int] = [:]
        for (i, line) in lines.enumerated() {
            if let pt = match(line, prefix: "a=rtpmap:", contains: "opus/") {
                opusRtpmapIdx[pt] = i
            }
        }
        guard !opusRtpmapIdx.isEmpty else { return sdp }

        // Существующие fmtp opus-кодеков обновляем на месте.
        var seen = Set<String>()
        for (i, line) in lines.enumerated() {
            guard line.hasPrefix("a=fmtp:") else { continue }
            let rest = line.dropFirst("a=fmtp:".count)
            guard let space = rest.firstIndex(of: " ") else { continue }
            let pt = String(rest[..<space])
            guard opusRtpmapIdx[pt] != nil else { continue }
            let existing = String(rest[rest.index(after: space)...])
            seen.insert(pt)
            lines[i] = "a=fmtp:\(pt) \(mergeFmtp(existing))"
        }

        // Кодекам без fmtp дописываем строку сразу после rtpmap. Идём с конца,
        // чтобы вставки не съезжали индексы.
        let params = opusParams.map { "\($0.0)=\($0.1)" }.joined(separator: ";")
        let missing = opusRtpmapIdx
            .filter { !seen.contains($0.key) }
            .sorted { $0.value > $1.value }
        for (pt, idx) in missing {
            lines.insert("a=fmtp:\(pt) \(params)", at: idx + 1)
        }

        return lines.joined(separator: sep)
    }

    // Сливает существующие параметры fmtp с нашими (наши перетирают встречные).
    private static func mergeFmtp(_ existing: String) -> String {
        var map: [String: String] = [:]
        var order: [String] = []
        for part in existing.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1)
            let k = kv[0].trimmingCharacters(in: .whitespaces)
            guard !k.isEmpty else { continue }
            if map[k] == nil { order.append(k) }
            map[k] = kv.count > 1 ? String(kv[1]) : ""
        }
        for (k, v) in opusParams {
            if map[k] == nil { order.append(k) }
            map[k] = v
        }
        return order.map { k in map[k]!.isEmpty ? k : "\(k)=\(map[k]!)" }.joined(separator: ";")
    }

    // Достаёт payload-type из строки вида `a=rtpmap:111 opus/48000/2`.
    private static func match(_ line: String, prefix: String, contains: String) -> String? {
        guard line.hasPrefix(prefix) else { return nil }
        let rest = line.dropFirst(prefix.count)
        guard let space = rest.firstIndex(of: " ") else { return nil }
        let pt = String(rest[..<space])
        let after = rest[rest.index(after: space)...]
        guard after.lowercased().hasPrefix(contains.lowercased()) else { return nil }
        return pt
    }
}

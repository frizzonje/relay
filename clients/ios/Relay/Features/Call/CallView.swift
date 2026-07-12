import SwiftUI

// Экран голосового звонка (аудио). Сетка участников (аватар-круг с
// инициалами, имя, индикатор микрофона) + контролы: микрофон / глушилка / отбой,
// и «свернуть» (звонок продолжается в фоне, поверх списка каналов — мини-бар).
// Видео/демонстрация не поддерживаются.
struct CallView: View {
    @EnvironmentObject private var call: CallEngine
    var onMinimize: () -> Void = {}

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(call.participants) { p in
                        ParticipantTile(participant: p)
                    }
                }
                .padding(16)
            }
            controls
        }
        .background(Theme.bg0.ignoresSafeArea())
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button(action: onMinimize) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 40, height: 40)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(call.roomLabel.isEmpty ? "Голосовой канал" : call.roomLabel)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text(statusLine)
                    .font(Theme.mono(11))
                    .foregroundStyle(call.reconnecting ? Theme.danger : Theme.textFaint)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.bg1)
    }

    private var statusLine: String {
        if call.reconnecting { return "переподключение…" }
        let n = call.participants.count
        return "\(n) " + plural(n, "участник", "участника", "участников")
    }

    private var controls: some View {
        HStack(spacing: 14) {
            CallButton(
                icon: call.micOn ? "mic.fill" : "mic.slash.fill",
                active: !call.micOn, tint: call.micOn ? Theme.text : Theme.danger
            ) { call.toggleMic() }

            CallButton(
                icon: call.deafened ? "speaker.slash.fill" : "headphones",
                active: call.deafened, tint: call.deafened ? Theme.danger : Theme.text
            ) { call.toggleDeafen() }

            Spacer()

            Button {
                call.leave()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Theme.danger)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(Theme.bg1)
    }

    private func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let m10 = n % 10
        let m100 = n % 100
        if m10 == 1 && m100 != 11 { return one }
        if (2...4).contains(m10) && !(12...14).contains(m100) { return few }
        return many
    }
}

// Квадратная кнопка контрола 52×52 (моно-стиль relay).
private struct CallButton: View {
    let icon: String
    let active: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 52, height: 52)
                .background(active ? Theme.bg2 : Theme.bg2.opacity(0.6))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radiusMd)
                        .stroke(active ? Theme.borderStrong : Theme.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        }
    }
}

private struct ParticipantTile: View {
    let participant: CallEngine.CallParticipant

    private var initial: String {
        String(participant.name.prefix(1)).uppercased()
    }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Theme.bg2, Theme.bg1],
                            startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .frame(width: 64, height: 64)
                    .overlay(Circle().stroke(ringColor, lineWidth: 2))
                Text(initial)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Theme.text)
            }

            HStack(spacing: 5) {
                if !participant.micOn {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.danger)
                }
                if participant.deafened {
                    Image(systemName: "speaker.slash.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.danger)
                }
                Text(participant.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
            }

            if let sub = subline {
                Text(sub)
                    .font(Theme.mono(10))
                    .foregroundStyle(Theme.textFaint)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .background(Theme.bg1)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMd).stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
    }

    private var ringColor: Color {
        switch participant.state {
        case .connected: return Theme.border
        case .failed: return Theme.danger
        case .connecting, .reconnecting: return Theme.textFaint
        }
    }

    private var subline: String? {
        if participant.isLocal { return "вы" }
        switch participant.state {
        case .connecting: return "соединение…"
        case .reconnecting: return "переподключение…"
        case .failed: return "нет связи"
        case .connected: return nil
        }
    }
}

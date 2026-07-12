import SwiftUI

// Текстовый канал (protocol.md §6): лента сообщений, композер.
// Реакции/вложения не поддерживаются.
struct ChatView: View {
    // Наблюдаем SocketClient напрямую — иначе SwiftUI не перерисует ленту при
    // приходе `chat`/`chat-roster` (Session при этом не публикует изменений).
    @EnvironmentObject private var socket: SocketClient
    let channel: Channel

    @State private var draft: String = ""

    var body: some View {
        VStack(spacing: 0) {
            messageList
            composer
        }
        .background(Theme.bg0)
        .navigationTitle("#\(channel.name)")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { socket.chatJoin(slug: channel.slug, name: nil) }
        .onDisappear { socket.chatLeave() }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(socket.messages) { msg in
                        MessageRow(message: msg)
                            .id(msg.id)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .onChange(of: socket.messages.count) {
                if let last = socket.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField(
                "",
                text: $draft,
                prompt: Text("написать в #\(channel.name)").foregroundColor(Theme.textFaint),
                axis: .vertical
            )
            .font(.system(size: 15))
            .foregroundStyle(Theme.text)
            .lineLimit(1...4)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.bg2)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMd)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.bg0)
                    .frame(width: 40, height: 40)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            }
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(draft.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.bg1)
    }

    private func send() {
        socket.sendMessage(draft)
        draft = ""
    }
}

struct MessageRow: View {
    let message: ChatMessage

    private var time: String {
        let d = Date(timeIntervalSince1970: message.ts / 1000)
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    var body: some View {
        if message.system == true {
            Text(message.text)
                .font(Theme.mono(12))
                .foregroundStyle(Theme.textFaint)
                .frame(maxWidth: .infinity, alignment: .center)
        } else {
            HStack(alignment: .top, spacing: 10) {
                avatar
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(message.name ?? "Аноним")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.text)
                        Text(time)
                            .font(Theme.mono(11))
                            .foregroundStyle(Theme.textFaint)
                    }
                    Text(message.text)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.text.opacity(0.92))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var avatar: some View {
        let initial = String((message.name ?? "?").prefix(1)).uppercased()
        return Text(initial)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.text)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(
                    colors: [Theme.bg2, Theme.bg1],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .overlay(Circle().stroke(Theme.border, lineWidth: 1))
            .clipShape(Circle())
    }
}

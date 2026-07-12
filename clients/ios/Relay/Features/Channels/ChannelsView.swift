import SwiftUI

// Список серверов и каналов (protocol.md §5). Рейка серверов сверху, ниже —
// каналы выбранного сервера. Текстовый канал открывает чат; голосовой — вход в
// аудио-звонок: CallView поверх, при сворачивании — мини-бар внизу.
struct ChannelsView: View {
    @EnvironmentObject private var session: Session
    // Наблюдаем сокет напрямую — списки серверов/каналов и voice-presence
    // приходят снапшотами уже после показа экрана (Session их не публикует).
    @EnvironmentObject private var socket: SocketClient
    @EnvironmentObject private var call: CallEngine
    @State private var selectedServerId: String?
    @State private var showCall = false

    private var servers: [Server] { socket.servers }

    private var currentServer: Server? {
        servers.first { $0.id == selectedServerId } ?? servers.first
    }

    private var visibleChannels: [Channel] {
        guard let sid = currentServer?.id else { return [] }
        return socket.channels.filter { $0.serverId == sid }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                serverRail
                Divider().overlay(Theme.border)
                channelList
            }
            .background(Theme.bg0)
            .navigationTitle(currentServer?.name ?? "relay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        session.logout()
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if call.inCall && !showCall {
                    MiniCallBar(onTap: { showCall = true })
                }
            }
        }
        .fullScreenCover(isPresented: $showCall) {
            CallView(onMinimize: { showCall = false })
        }
        // Звонок завершился (отбой/логаут/сессия) — закрываем экран звонка.
        .onChange(of: call.inCall) { _, active in
            if !active { showCall = false }
        }
    }

    private var serverRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(servers) { server in
                    Button {
                        selectedServerId = server.id
                    } label: {
                        Text(server.emoji ?? String(server.name.prefix(1)).uppercased())
                            .font(.system(size: 20))
                            .frame(width: 48, height: 48)
                            .background(Theme.bg2)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.radiusMd)
                                    .stroke(
                                        currentServer?.id == server.id
                                            ? Theme.accent : Theme.border,
                                        lineWidth: currentServer?.id == server.id ? 2 : 1
                                    )
                            )
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }

    private var channelList: some View {
        List {
            if visibleChannels.isEmpty {
                Text("В этом сервере нет каналов")
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.textFaint)
                    .listRowBackground(Theme.bg0)
            }
            ForEach(visibleChannels) { channel in
                channelRow(channel)
                    .listRowBackground(Theme.bg0)
                    .listRowSeparatorTint(Theme.border)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg0)
    }

    @ViewBuilder
    private func channelRow(_ channel: Channel) -> some View {
        if channel.type == .text {
            NavigationLink {
                ChatView(channel: channel)
            } label: {
                channelLabel(channel)
            }
        } else {
            // Голосовой канал: тап — вход в аудио-звонок.
            let peers = socket.voicePresence[channel.slug] ?? []
            let active = call.room == channel.slug
            Button {
                call.join(slug: channel.slug, label: channel.name)
                showCall = true
            } label: {
                HStack {
                    channelLabel(channel)
                    Spacer()
                    if active {
                        Image(systemName: "waveform")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.success)
                    }
                    if !peers.isEmpty {
                        Text("\(peers.count)")
                            .font(Theme.mono(12))
                            .foregroundStyle(Theme.textFaint)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func channelLabel(_ channel: Channel) -> some View {
        HStack(spacing: 8) {
            Image(systemName: channel.type == .text ? "number" : "speaker.wave.2.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textFaint)
            Text(channel.name)
                .font(.system(size: 15))
                .foregroundStyle(Theme.text)
        }
    }
}

// Мини-бар активного звонка (звонок свёрнут). Тап — развернуть CallView; кнопки
// микрофона и отбоя доступны прямо отсюда (как в мобильном web-клиенте).
private struct MiniCallBar: View {
    @EnvironmentObject private var call: CallEngine
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "waveform")
                .font(.system(size: 14))
                .foregroundStyle(call.reconnecting ? Theme.danger : Theme.success)
            VStack(alignment: .leading, spacing: 1) {
                Text(call.roomLabel.isEmpty ? "Голосовой канал" : call.roomLabel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Text(call.reconnecting ? "переподключение…" : "в эфире")
                    .font(Theme.mono(10))
                    .foregroundStyle(Theme.textFaint)
            }
            Spacer()
            Button {
                call.toggleMic()
            } label: {
                Image(systemName: call.micOn ? "mic.fill" : "mic.slash.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(call.micOn ? Theme.text : Theme.danger)
                    .frame(width: 38, height: 38)
            }
            Button {
                call.leave()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Theme.danger)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.bg2)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.border), alignment: .top)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}

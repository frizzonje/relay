import SwiftUI

@main
struct RelayApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(session.socket)
                .environmentObject(session.call)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

// Корневой роутер по фазе сессии. Логин → подключение → список каналов.
struct RootView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ZStack {
            Theme.bg0.ignoresSafeArea()
            switch session.phase {
            case .loggedOut:
                LoginView()
            case .connecting:
                ConnectingView()
            case .ready:
                ChannelsView()
            }
        }
    }
}

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView().tint(Theme.textMuted)
            Text("Подключение…")
                .font(Theme.mono(13))
                .foregroundStyle(Theme.textMuted)
        }
    }
}

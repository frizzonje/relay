import SwiftUI

// Экран входа (референс, раздел 03): знак по центру, адрес сервера, поле пароля
// (моно-каретка), кнопка «Войти». Один общий пароль на инсталляцию (protocol.md §2).
struct LoginView: View {
    @EnvironmentObject private var session: Session
    @State private var urlText: String = AppConfig.baseURL
    @State private var password: String = ""
    @FocusState private var passwordFocused: Bool

    var body: some View {
        VStack(spacing: 22) {
            Spacer()

            MeshMark()
                .frame(width: 56, height: 56)

            Text("relay")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.text)

            VStack(spacing: 12) {
                field(text: $urlText, placeholder: "адрес сервера", secure: false)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()

                field(text: $password, placeholder: "пароль", secure: true)
                    .focused($passwordFocused)
                    .onSubmit(submit)
            }
            .frame(maxWidth: 320)

            if let err = session.loginError {
                Text(err)
                    .font(Theme.mono(12))
                    .foregroundStyle(Theme.danger)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
            }

            Button(action: submit) {
                Group {
                    if session.isBusy {
                        ProgressView().tint(Theme.bg0)
                    } else {
                        Text("Войти").font(.system(size: 15, weight: .semibold))
                    }
                }
                .frame(maxWidth: 320)
                .frame(height: 46)
                .background(Theme.accent)
                .foregroundStyle(Theme.bg0)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            }
            .disabled(session.isBusy || password.isEmpty)
            .opacity(session.isBusy || password.isEmpty ? 0.6 : 1)

            Spacer()
        }
        .padding(.horizontal, 24)
        .onAppear { passwordFocused = true }
    }

    private func submit() {
        guard !session.isBusy else { return }
        Task { await session.login(urlText: urlText, password: password) }
    }

    @ViewBuilder
    private func field(text: Binding<String>, placeholder: String, secure: Bool) -> some View {
        Group {
            if secure {
                SecureField("", text: text, prompt: prompt(placeholder))
            } else {
                TextField("", text: text, prompt: prompt(placeholder))
            }
        }
        .font(Theme.mono(15))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(Theme.bg2)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radiusMd)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
    }

    private func prompt(_ s: String) -> Text {
        Text(s).foregroundColor(Theme.textFaint)
    }
}

// Упрощённый знак «mesh-триада» — три узла-кружка, связанные линиями. Статичный.
struct MeshMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let r = s * 0.11
            let pts = [
                CGPoint(x: s * 0.5, y: s * 0.16),
                CGPoint(x: s * 0.16, y: s * 0.82),
                CGPoint(x: s * 0.84, y: s * 0.82),
            ]
            ZStack {
                Path { p in
                    for i in 0..<pts.count {
                        p.move(to: pts[i])
                        p.addLine(to: pts[(i + 1) % pts.count])
                    }
                }
                .stroke(Theme.textFaint, lineWidth: 1.5)

                ForEach(0..<pts.count, id: \.self) { i in
                    Circle()
                        .fill(Theme.accent)
                        .frame(width: r * 2, height: r * 2)
                        .position(pts[i])
                }
            }
        }
    }
}

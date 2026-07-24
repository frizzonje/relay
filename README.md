# relay

🇷🇺 [Русская версия](README.ru.md)

Self-hosted platform for private voice, video, and text communication for small groups. Two WebRTC transports — P2P mesh for small calls, a mediasoup SFU for large ones — text channels with attachments and reactions, shared-password access, TLS out of the box.

## ⚡ Get started

Spin up your own relay on a fresh **Debian/Ubuntu** server in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/frizzonje/relay/main/install.sh | bash
```

It installs Docker, asks for your domain, login password, TURN and the media server, pulls prebuilt images, opens the firewall, and starts everything — then hands you a `relay` CLI (`relay update`, `relay logs`, `relay config`, `relay backup`). The stack lives in `/opt/relay`.

> [!TIP]
> Prefer to read before you pipe into a shell? Download it first:
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/frizzonje/relay/main/install.sh
> less install.sh && bash install.sh
> ```

Want to run it locally or build from source instead? See [Quick start](#quick-start-from-source).

## Features

- **Voice and video** — camera, screen sharing (with system audio on Windows), push-to-talk, voice activity detection, mute/deafen indicators, per-participant volume mixer (0–300 %) with memory
- **Two call transports** — P2P mesh and a mediasoup SFU, picked per voice channel; see [Call topology](#call-topology)
- **Text channels** — message history, replies, editing, deletion, typing indicators, reactions, attachments up to 25 MB
- **Servers and channels** — create/delete on the fly, optional per-server password, shared registry for all members, invite links with guest tokens
- **Closed perimeter** — single login password (HMAC cookie), one origin behind Caddy, automatic TLS via Let's Encrypt
- **TURN profile** — coturn for calls behind strict NAT (mobile networks, CGNAT), including TURN over TLS on 5349
- **Native clients** — desktop (Tauri) with tray, global push-to-talk hotkey and auto-updates; iOS in progress

## Call topology

Every voice channel carries a `mode` its owner chooses. Both transports live side by side — neither is legacy.

| | `p2p` (mesh, default) | `sfu` (media server) |
|---|---|---|
| Media path | direct between participants | via the `sfu` service |
| Uplink per participant | grows with the room (N−1 streams) | constant (1 stream) |
| Sweet spot | 2–3 with video, up to ~6–7 voice-only | 4+ with video |
| Server load | none (signaling only) | CPU and RTC ports |
| Requires | nothing | `--profile sfu` + `SFU_SECRET` |

The media server is optional by design: an installation without it stays fully functional. If the SFU is down or disabled, `sfu` channels fall back to P2P automatically and warn in the UI. Details and the reasoning behind the split: [docs/sfu-plan.md](docs/sfu-plan.md).

## Clients

| Platform | Directory | Stack | Status |
|---|---|---|---|
| Web | [`apps/web`](apps/web) | Next.js 15 / React 19 | reference client |
| Windows / Linux / macOS | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + system webview) | shipping — MSI/NSIS, AppImage/deb/rpm, dmg, AUR |
| iOS | [`clients/ios`](clients/ios) | Swift / SwiftUI + WebRTC.xcframework | in progress — login, chat and audio calls over P2P mesh |
| Android | — | Kotlin / Compose | not started |

Native clients implement one contract — [docs/protocol.md](docs/protocol.md) — and never import each other's code.

## Repository structure

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand)
  api/        NestJS 10 + Socket.io (signaling, chat, registry, uploads)
  sfu/        NestJS 10 + mediasoup (optional media server for large calls)
packages/
  shared/     @relay/shared — shared contract: types, socket events, HMAC auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright tests
docs/         architecture, frontend, backend, protocol, SFU
docker-compose.yml        production stack, built from source (entry point)
docker-compose.prod.yml   the same stack on prebuilt GHCR images
install.sh                one-command installer
```

The JS part is a **pnpm workspaces + Turborepo** monorepo; all services run in Docker, a local Node install isn't required. Native clients live under `clients/` with their own toolchains and CI jobs.

## Quick start (from source)

**Dev** (hot-reload, self-signed TLS):

```bash
docker compose -f infra/docker-compose.dev.yml up
# → https://localhost
```

**Production:**

```bash
cp .env.example .env   # set SITE_PASSWORD and DOMAIN
docker compose up --build

# with a TURN relay (strict NAT / mobile networks):
docker compose --profile turn up --build

# with the media server (calls of 4+ with video); needs SFU_SECRET in .env:
docker compose --profile sfu up --build
```

To deploy without building — pull prebuilt images from GHCR (what the installer
uses under the hood):

```bash
docker compose -f docker-compose.prod.yml up -d          # add --profile turn / --profile sfu
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `SITE_PASSWORD` | _(empty)_ | Login password. Shared by api and web. Empty → auth disabled |
| `DOMAIN` | `localhost` | Domain for Caddy. `localhost` → self-signed CA, real domain → Let's Encrypt |
| `SERVER_HOST` | `localhost` | Host for the ICE config and coturn realm |
| `TURN_USERNAME` | `webrtc` | TURN user |
| `TURN_CREDENTIAL` | _(empty)_ | TURN server password. Required with `--profile turn` |
| `TURN_EXTERNAL_IP` | _(empty)_ | Public IP behind 1:1 NAT (cloud VMs) |
| `STUN_URLS` / `TURN_URLS` | — | Override the ICE servers handed to clients |
| `SFU_SECRET` | _(empty)_ | Pass-signing key shared by api and sfu. Empty → the SFU mode stays off |
| `SFU_ANNOUNCED_IP` | `TURN_EXTERNAL_IP` | Public IP in the media server's ICE candidates (1:1 NAT) |
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | `40000` / `40100` | Media port range |

### Firewall

| Port | Protocol | Needed for |
|---|---|---|
| `80`, `443` | tcp | Caddy: web UI, API, ACME |
| `3478` | udp + tcp | coturn (`--profile turn`) |
| `5349` | tcp | TURN over TLS |
| `49160–49200` | udp | coturn relay range |
| `40000–40100` | udp + tcp | SFU media range (`--profile sfu`) |

The installer opens these for you. The SFU's signaling port (`3100`) stays internal — Caddy proxies it at `/sfu/`.

## Tests

```bash
# unit (Vitest) + typecheck + build of all packages
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'
```

CI (`.github/workflows/ci.yml`): typecheck → unit → docker build → e2e (Playwright) on every push.

## Documentation

- [Architecture](docs/architecture.md) — services, traffic, auth, signaling
- [Frontend](docs/frontend.md) — components, stores, WebRTC client
- [Backend](docs/backend.md) — NestJS, Socket.io gateway, REST
- [Protocol](docs/protocol.md) — client API spec (web / iOS / desktop)
- [SFU](docs/sfu-plan.md) — scaling video via a mediasoup media server

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

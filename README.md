# relay

🇷🇺 [Русская версия](README.ru.md)

Self-hosted platform for private voice, video, and text communication for small groups. Two WebRTC transports — P2P mesh for small calls, a mediasoup SFU for large ones — text channels with attachments and reactions, shared-password access, TLS out of the box.

## ⚡ Get started

Spin up your own relay on a fresh **Debian/Ubuntu** server in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/frizzonje/relay/main/install.sh | bash
```

It installs Docker, asks for your domain, login password, TURN and the media server, pulls prebuilt images, opens the firewall, and starts everything — then hands you a `relay` CLI (`relay update`, `relay logs`, `relay config`, `relay backup`, `relay restore`, `relay disown`). The stack lives in `/opt/relay`, pinned to the release it installed: `relay up` after a reboot starts what you were running, and moving to a new version is `relay update` and nothing else.

**No domain?** Say so and the installer takes a Let's Encrypt certificate for the server's IP address instead — real HTTPS at `https://<your-ip>`, no browser warnings, nothing to buy. Such certificates are only valid for six days by design, so Caddy renews them every couple of days on its own. If issuance fails (port 80 closed, address behind NAT), the stack still comes up with a self-signed certificate.

> [!TIP]
> Prefer to read before you pipe into a shell? Download it first:
> ```bash
> curl -fsSLO https://raw.githubusercontent.com/frizzonje/relay/main/install.sh
> less install.sh && bash install.sh
> ```

Want to build from source or hack on it? See [Quick start](#quick-start-from-source) and [Run and test locally](#run-and-test-locally).

## Features

- **Voice and video** — camera, screen sharing (tab/system audio via the browser; on Windows the desktop client captures system audio natively), push-to-talk, voice activity detection, mute/deafen indicators, per-participant volume mixer (0–300 %) with memory
- **Two call transports** — P2P mesh and a mediasoup SFU, picked per voice channel; see [Call topology](#call-topology)
- **Text channels** — replies, editing, deletion, typing indicators, reactions, attachments up to 25 MB. Chat is ephemeral: the API keeps the last 50 messages per channel in memory — see [Data and persistence](#data-and-persistence)
- **Servers and channels** — create/delete on the fly, optional per-server password, shared registry for all members, invite links with guest tokens. Renaming and deleting is limited to the device that created the entry; if that browser is gone, `relay disown` on the host hands the entry back to everyone
- **Closed perimeter** — single login password (HMAC cookie), one origin behind Caddy, automatic TLS via Let's Encrypt
- **Interface in English and Russian** — resolved server-side from the browser's `Accept-Language` on the first visit (so the first paint is already right), remembered in a cookie, switchable in Settings → Appearance. Adding a language is one JSON file — see [Localization](#localization)
- **TURN profile** — coturn for calls behind strict NAT (mobile networks, CGNAT), including TURN over TLS on 5349
- **Native clients** — desktop (Tauri) with tray, global push-to-talk hotkey and auto-updates on Windows and macOS (on Linux the shell is chat-only — see [Clients](#clients)); iOS in progress

## Call topology

Voice channels created by members carry a `mode` that its creator can flip from the sidebar (the channels seeded with a new server are always `p2p`). Both transports live side by side — neither is legacy.

| | `p2p` (mesh, default) | `sfu` (media server) |
|---|---|---|
| Media path | direct between participants | via the `sfu` service |
| Uplink per participant | grows with the room (N−1 streams) | constant (1 stream) |
| Sweet spot | 2–3 with video, up to ~6–7 voice-only | 4+ with video |
| Server load | none (signaling only) | CPU and RTC ports |
| Requires | nothing | `--profile sfu` + `SFU_SECRET` |

The media server is optional by design: an installation without it stays fully functional. If the SFU is down or disabled, `sfu` channels fall back to P2P automatically and warn in the UI. Design note behind the split (Russian): [docs/plans/old/sfu.md](docs/plans/old/sfu.md).

## Clients

| Platform | Directory | Stack | Status |
|---|---|---|---|
| Web | [`apps/web`](apps/web) | Next.js 15 / React 19 | reference client — full feature set on every OS |
| Windows / macOS | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + system webview) | shipping — MSI/NSIS, dmg; tray, global push-to-talk hotkey, auto-updates |
| Linux | [`clients/desktop`](clients/desktop) | Tauri v2 (Rust + system webview) | AppImage/deb/rpm — **chat only, no calls** (see below) |
| iOS | [`clients/ios`](clients/ios) | Swift / SwiftUI + WebRTC.xcframework | in progress — login, chat and audio calls over P2P mesh |
| Android | — | Kotlin / Compose | not started |

**Downloads:** [Releases](https://github.com/frizzonje/relay/releases) (tags `desktop-v*`; `nightly` is a pre-release built from `main`). Installers are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first run. Arch Linux PKGBUILDs live in [`clients/desktop/packaging/arch`](clients/desktop/packaging/arch) but are not published to the AUR yet — build them from the repo.

> [!IMPORTANT]
> **The Linux desktop shell cannot make calls.** Distro builds of WebKitGTK ship with `-DENABLE_WEB_RTC=OFF`, so `RTCPeerConnection` does not exist in the webview and no change on our side can fix it. Chat, uploads and notifications work; for voice and video on Linux use the web client in Chromium or Firefox. Details and the evidence: [clients/desktop/README.md](clients/desktop/README.md).

Native clients implement one contract — [docs/protocol.md](docs/protocol.md) — and never import each other's code.

## Repository structure

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand, i18n en/ru)
  api/        NestJS 11 + Socket.io (signaling, chat, registry, uploads)
  sfu/        NestJS 11 + mediasoup (optional media server for large calls)
packages/
  shared/     @relay/shared — shared contract: types, socket events, HMAC auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright tests
docs/         architecture, frontend, backend, protocol, plans/
docker-compose.yml        production stack, built from source (entry point)
docker-compose.prod.yml   the same stack on prebuilt GHCR images
install.sh                one-command installer
```

The JS part is a **pnpm workspaces + Turborepo** monorepo; all services run in Docker, a local Node install isn't required. Native clients live under `clients/` with their own toolchains and CI jobs.

## Quick start (from source)

**Production** (builds the images locally):

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

Pin a version with `RELAY_VERSION` (`latest` by default); published tags are listed on the [GHCR packages](https://github.com/frizzonje?tab=packages&repo_name=relay) page. Images are pulled on demand, so `docker compose pull` is how you ask for new ones — `up` alone will not change what is running under you.

### Updating an installation

`relay update` moves the whole stack, not just the images: it re-fetches `docker-compose.prod.yml`, the Caddy config, coturn's entry point and the CLI itself from the tag it is moving to, then pulls and restarts. The previous files are kept under `/opt/relay/backups/`, and an update that fails to come up rolls itself back.

```bash
relay version           # installed, newest available, active profiles
relay update            # go to the newest release
relay update 0.7.0      # go to a specific one — this is also how you roll back
relay backup            # volumes AND config (including .env) into one tarball
relay restore <file>    # put that tarball back
```

> [!IMPORTANT]
> Installations made before this existed have a `relay` CLI that only pulls images and can therefore never update itself. Re-run the installer once on those; it keeps your `.env`, backing up the old one beside it.

## Run and test locally

Docker with the Compose plugin is the only prerequisite — no local Node, no pnpm.

### Dev stack (hot-reload)

```bash
docker compose -f infra/docker-compose.dev.yml up
# → https://localhost
```

What this gives you: `api` (NestJS in watch mode) and `web` (Next.js with Turbopack) behind one Caddy origin on `:443`, both hot-reloading from your working tree. The first run installs dependencies into named volumes and takes a few minutes; later runs start in seconds. Add `--profile sfu` to bring the media server up too (it builds from `apps/sfu/Dockerfile`).

Things worth knowing before the first run:

- **The dev stack does not read the root `.env`.** Compose resolves `.env` relative to the compose file, so `infra/docker-compose.dev.yml` would look for `infra/.env`. To feed it the root file, pass it explicitly:
  ```bash
  docker compose --env-file .env -f infra/docker-compose.dev.yml up
  ```
  Without it every variable falls back to the defaults baked into the compose file, which is exactly what you want for plain local work.
- **No password by default.** `SITE_PASSWORD` is empty in dev → the login gate is off and `https://localhost` opens straight into the app. Set it (`SITE_PASSWORD=… docker compose …`) only when you want to test the gate itself; it must be identical for `api` and `web`, otherwise the `relay_pass` cookie fails to verify.
- **The certificate is self-signed** (Caddy's internal CA), so the browser warns once — accept it. TLS matters here: `getUserMedia` and screen capture only work in a secure context.
- **Ports 80 and 443 must be free.** If a production stack from this repo is already running locally, stop it first — both bind the same ports.

### Trying a call

Open `https://localhost` in two tabs (or two browser profiles), pick different `@`-tags, and join the same voice channel — a mesh call between two participants needs nothing else. Chromium's `--use-fake-device-for-media-stream` is handy when you have no second microphone. To test the `sfu` mode, run the stack with `--profile sfu` and a non-empty `SFU_SECRET`, then create your own voice channel and flip its `P2P`/`SFU` badge in the sidebar — the channels seeded with a server can't be switched. With an empty secret the badge stays disabled and every channel runs P2P.

Calls between two machines need a hostname both can reach: set `DOMAIN` and `SERVER_HOST` to the LAN IP of the host, and expect a certificate warning on the second machine.

### Tests and checks

```bash
# unit (Vitest) + typecheck + build of all packages — same set as CI
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm turbo run typecheck test build'

# lint and formatting — CI fails on both
docker run --rm -v "$PWD":/mono -w /mono node:20-alpine \
  sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm lint && pnpm format:check'
```

End-to-end (Playwright) runs against the production stack, not the dev one:

```bash
SITE_PASSWORD=testpass123 POSTGRES_PASSWORD=testpass123 docker compose -f docker-compose.yml -f infra/docker-compose.e2e.yml up -d --build
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' relay-caddy-1)
docker run --rm --network relay_default --add-host "relay.test:$CADDY_IP" \
  -v "$PWD":/work -w /work/e2e \
  -e BASE_URL=https://relay.test -e SITE_PASSWORD=testpass123 \
  mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c 'npm install --no-save @playwright/test@1.49.0 && npx playwright test'
docker compose -f docker-compose.yml -f infra/docker-compose.e2e.yml down -v
```

CI (`.github/workflows/ci.yml`) runs the same three groups on pushes to `main`/`refactor/**` and on every pull request: lint + format + typecheck + unit + build, production image builds for api/web/sfu, then e2e. The desktop client has its own workflow (`desktop.yml`).

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `SITE_PASSWORD` | _(empty)_ | Login password. Shared by api and web. Empty → auth disabled |
| `POSTGRES_PASSWORD` | — | **Required.** Between api and Postgres, never typed by a person — `install.sh` and `relay update` generate it. `initdb` reads it once, when the volume is created: changing it later only breaks api's login |
| `DATABASE_URL` | assembled from `POSTGRES_PASSWORD` | Set it whole only for a database outside this stack, or for a hand-picked password containing `@ / : ?` |
| `RETENTION_DAYS` | `14` | How long messages and their attachments live. `0` keeps nothing |
| `DOMAIN` | `localhost` | Host for Caddy. `localhost` → self-signed CA, real domain → Let's Encrypt. A public IP also gets a Let's Encrypt certificate, but needs the issuer block `install.sh` writes into `tls-mode.caddy` |
| `SERVER_HOST` | `localhost` | Host for the ICE config and coturn realm |
| `TURN_USERNAME` | `webrtc` | TURN user |
| `TURN_CREDENTIAL` | _(empty)_ | TURN server password. Required with `--profile turn` |
| `TURN_EXTERNAL_IP` | _(empty)_ | Public IP behind 1:1 NAT (cloud VMs) |
| `STUN_URLS` / `TURN_URLS` | — | Override the ICE servers handed to clients |
| `SFU_SECRET` | _(empty)_ | Pass-signing key shared by api and sfu. Empty → the SFU mode stays off |
| `SFU_ANNOUNCED_IP` | `TURN_EXTERNAL_IP` | Public IP in the media server's ICE candidates (1:1 NAT) |
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | `40000` / `40100` | Media port range |
| `SFU_URL` | `/` | Public address of the SFU signaling handed to clients. `/` means "same origin, path `/sfu/`" |
| `SFU_INTERNAL_URL` | `http://host.docker.internal:3100` | Where api health-checks the SFU from inside the network (dev: `http://sfu:3100`) |
| `PORT` | `3000` | Port the NestJS app listens on inside the container |
| `RELAY_VERSION` | `latest` | Image tag used by `docker-compose.prod.yml`. `install.sh` pins the installed release here and `relay update` moves it |
| `RELAY_REPO` / `RELAY_REF` | `frizzonje/relay` / `main` | Where `relay update` fetches stack files from. The ref follows `RELAY_VERSION` when it is pinned; `RELAY_REF` is only used by an installation following `latest` |
| `RELAY_TLS_MODE` | _(empty)_ | `domain`, `ip` or `selfsigned` — which `tls-mode.caddy` `relay update` re-fetches |

### Firewall

| Port | Protocol | Needed for |
|---|---|---|
| `80`, `443` | tcp | Caddy: web UI, API, ACME |
| `3478` | udp + tcp | coturn (`--profile turn`) |
| `5349` | tcp | TURN over TLS |
| `49160–49200` | udp | coturn relay range |
| `40000–40100` | udp + tcp | SFU media range (`--profile sfu`) |

The installer opens these for you. The SFU's signaling port (`3100`) stays internal — Caddy proxies it at `/sfu/`.

## Data and persistence

There is no database. What survives a restart and what doesn't:

| Data | Where | Survives a restart? |
|---|---|---|
| Servers and channels | `registry.json` on the `uploads` volume (`DATA_DIR`) | yes |
| Uploaded attachments | `uploads` volume | yes |
| TLS certificates | `caddy_data` volume | yes |
| Chat messages | api process memory — last 50 per channel, 200 channels max | **no** |
| Your `@`-tag, volume levels, unread state | browser `localStorage` | yes, per browser |

So `relay update`, `docker compose up` or any api restart wipes the message history while keeping servers, channels and files. `relay backup` snapshots both volumes **and** the configuration next to them (`.env` with all its secrets, the compose file, the Caddy config) — a machine rebuilt from one of these tarballs comes back as it was, which was not true of the volumes alone. Accounts don't exist either: access is one shared `SITE_PASSWORD`, and identity is the `@`-tag a visitor picks after entering it.

## Localization

The web client ships in English and Russian; `en` is the reference dictionary and every other locale falls back to it key by key. The desktop client embeds the same UI, so it follows along, and its own "connect to your installation" screen carries the same two languages, picked from the system language of the webview. The iOS client is Russian-only for now.

Adding a language means two edits and no new code:

1. drop `apps/web/lib/i18n/messages/<tag>.json` next to `en.json`;
2. add the tag and its label to `LOCALES` / `LOCALE_LABELS` in [`apps/web/lib/i18n/config.ts`](apps/web/lib/i18n/config.ts).

`messages.test.ts` then fails the build on any drift from `en.json` — a missing key, a dropped `{placeholder}`, or a plural form the language needs. Everything else (detection, the cookie, the picker) is already wired.

## Documentation

Docs and code comments are in Russian; the two READMEs are the English-facing entry point.

- [Architecture](docs/architecture.md) — services, traffic, auth, signaling
- [Frontend](docs/frontend.md) — components, stores, WebRTC client
- [Backend](docs/backend.md) — NestJS, Socket.io gateway, REST
- [Protocol](docs/protocol.md) — client API spec (web / iOS / desktop)
- [SFU](docs/plans/old/sfu.md) — design note on scaling video via a mediasoup media server
- [1.0](docs/plans/relay-1.0.md) — what the next major brings: identity, persistent history, deeper basics
- [2.0](docs/plans/relay-2.0.md) — direct messages and one-to-one calls, the release after

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

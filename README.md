# relay

🇷🇺 [Русская версия](README.ru.md)

Self-hosted platform for private voice, video, and text communication for small groups. Mesh WebRTC calls with no media server, text channels with attachments and reactions, shared-password access, TLS out of the box.

## Features

- **Voice and video** — mesh WebRTC (P2P, up to ~6–7 participants), camera, screen sharing, mute/deafen indicators
- **Text channels** — message history, attachments up to 25 MB, reactions
- **Servers and channels** — create/delete on the fly, optional per-server password, shared registry for all members
- **Closed perimeter** — single login password (HMAC cookie), one origin behind Caddy, automatic TLS
- **TURN profile** — coturn for calls behind strict NAT (mobile networks, CGNAT)

## Repository structure

```
apps/
  web/        Next.js 15 (App Router, React 19, Tailwind, Zustand)
  api/        NestJS 10 + Socket.io (signaling, chat, registry, uploads)
packages/
  shared/     @relay/shared — shared contract: types, socket events, HMAC auth
clients/
  desktop/    Windows/Linux/macOS — Tauri v2 (scaffold)
  ios/        iOS — Swift/SwiftUI + WebRTC.xcframework (scaffold)
infra/        Caddyfile, dev/e2e compose
e2e/          Playwright tests
docs/         architecture, frontend, backend, protocol
docker-compose.yml   production stack (entry point)
```

The JS part is a **pnpm workspaces + Turborepo** monorepo; all services run in Docker, a local Node install isn't required. Native clients live under `clients/` with their own toolchains and talk to the server over a shared protocol — [docs/protocol.md](docs/protocol.md).

## Quick start

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
```

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `SITE_PASSWORD` | _(empty)_ | Login password. Shared by api and web. Empty → auth disabled |
| `DOMAIN` | `localhost` | Domain for Caddy. `localhost` → self-signed CA, real domain → Let's Encrypt |
| `SERVER_HOST` | `localhost` | Host for the ICE config and coturn realm |
| `TURN_CREDENTIAL` | _(empty)_ | TURN server password. Required with `--profile turn` |
| `TURN_EXTERNAL_IP` | _(empty)_ | Public IP behind 1:1 NAT (cloud VMs) |
| `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` | — | Override ICE servers |

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
- [SFU plan](docs/sfu-plan.md) — scaling video via LiveKit

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

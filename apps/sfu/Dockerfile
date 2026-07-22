# Медиасервер. В отличие от api/web — не alpine, а bookworm (glibc): mediasoup
# качает готовый бинарник воркера (C++) под glibc, на musl он бы вместо этого
# собирался из исходников (python3 + meson + g++, минуты и лишние сотни мегабайт).

# ── Stage 1: установка зависимостей (dev+prod, нужны для tsc) ────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /mono
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# Сначала только манифесты — слой кэшируется, пока package.json не менялись.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/sfu/package.json ./apps/sfu/
RUN pnpm install --frozen-lockfile --filter @relay/sfu...

# ── Stage 2: компиляция TypeScript ───────────────────────────────────────────
FROM deps AS builder
COPY apps/sfu ./apps/sfu
RUN pnpm --filter @relay/sfu build

# ── Stage 3: pnpm deploy — только прод-зависимости + dist ────────────────────
FROM deps AS pruner
COPY --from=builder /mono/apps/sfu/dist ./apps/sfu/dist
RUN pnpm deploy --filter @relay/sfu --prod /deploy

# ── Stage 4: минимальный runtime ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3100
COPY --from=pruner /deploy .
EXPOSE 3100
CMD ["node", "dist/main.js"]

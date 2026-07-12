# ── Stage 1: установка зависимостей ──────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /mono
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── Stage 2: сборка Next.js (standalone output) ───────────────────────────────
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
# @relay/shared — TS-исходник; next.config.mjs → transpilePackages компилирует его inline.
RUN pnpm --filter @relay/web build

# ── Stage 3: минимальный runtime (Next standalone) ────────────────────────────
# standalone зеркалит структуру монорепо: server.js лежит внутри apps/web/.
# Статику и public кладём рядом с server.js — туда, где он их ожидает.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /mono/apps/web/.next/standalone ./
COPY --from=builder /mono/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /mono/apps/web/public ./apps/web/public
EXPOSE 3001
ENV PORT=3001 HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]

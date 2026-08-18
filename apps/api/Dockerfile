# ── Stage 1: установка зависимостей (dev+prod, нужны для tsc) ────────────────
FROM node:20-alpine AS deps
WORKDIR /mono
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# Сначала только манифесты — слой кэшируется, пока package.json не менялись.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── Stage 2: компиляция TypeScript ───────────────────────────────────────────
FROM deps AS builder
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm --filter @relay/api build

# ── Stage 3: pnpm deploy — только прод-зависимости + dist ────────────────────
# Стартуем от deps (есть lockfile + манифесты), добавляем скомпилированный dist.
FROM deps AS pruner
COPY --from=builder /mono/apps/api/dist ./apps/api/dist
# pnpm deploy копирует файлы пакета (package.json + dist/) и ставит prod-deps.
RUN pnpm deploy --filter @relay/api --prod /deploy

# ── Stage 4: минимальный runtime ─────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
# Номер релиза, под которым собран образ: релизный workflow передаёт тег,
# сборка из исходников оставляет пустым. Пустое значение — честный ответ
# «номера нет», и api отдаёт именно его, а не выдуманное число.
ARG RELAY_VERSION=""
ENV NODE_ENV=production PORT=3000 RELAY_VERSION=$RELAY_VERSION
COPY --from=pruner /deploy .
# Приложение — не root (audit S6). su-exec — то, чем точка входа опускается с
# root после того, как отдала том uploads пользователю node: named volume
# монтируется docker'ом от root, и без этой отдачи api снова писал бы как root.
RUN apk add --no-cache su-exec
COPY infra/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
EXPOSE 3000
CMD ["node", "dist/main.js"]

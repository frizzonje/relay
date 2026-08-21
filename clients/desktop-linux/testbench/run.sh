#!/usr/bin/env bash
# Живой прогон Linux-клиента: оболочка звонит браузеру на поднятом стенде.
#
# Всё в Docker — ни Node, ни Electron на машине не нужны:
#   1) поднимается прод-стек с e2e-оверлеем (api + web + Caddy + медиасервер);
#   2) собирается образ стенда (Playwright + Electron версии оболочки);
#   3) гоняется спек e2e/tests/linux-shell.spec.ts — он запускает саму оболочку,
#      ведёт её через экран выбора сервера и звонит обычному Chromium.
#
#   ./clients/desktop-linux/testbench/run.sh          # поднять стенд и прогнать
#   KEEP_STACK=1 ./clients/desktop-linux/testbench/run.sh   # не гасить стек после
#
# Стек остаётся тем же, что у CI (docker-compose.yml + infra/docker-compose.e2e.yml),
# поэтому спек оболочки и обычные e2e видят одну и ту же инсталляцию.
set -euo pipefail

cd "$(dirname "$0")/../../.."   # корень репозитория

export SITE_PASSWORD="${SITE_PASSWORD:-testpass123}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-testpass123}"
# Свой проект compose, а не общий `relay`: у настоящей локальной инсталляции
# том базы заведён с ДРУГИМ паролем, а postgres читает его один раз, при
# создании тома, — стенд на общем проекте упирался бы в «password
# authentication failed» и выглядел бы как поломка стенда.
PROJECT="${COMPOSE_PROJECT:-relay-e2e}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f infra/docker-compose.e2e.yml)
CADDY="$PROJECT-caddy-1"
NETWORK="${PROJECT}_default"

echo "==> Поднимаю стенд"
"${COMPOSE[@]}" up -d --build

cleanup() {
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    echo "==> Гашу стенд"
    "${COMPOSE[@]}" down
  fi
}
trap cleanup EXIT

echo "==> Жду, пока Caddy начнёт отдавать https://relay.test"
# Не пауза, а вопрос: запрос идёт всю дорогу целиком — сертификат, имя сайта,
# прокси до api. Фиксированный сон либо длиннее нужного на каждом зелёном
# прогоне, либо короче на одном медленном, и этот один выглядит как поломка.
for i in $(seq 60); do
  if docker exec "$CADDY" wget -q --no-check-certificate -O /dev/null https://relay.test/api/health 2>/dev/null; then
    echo "    стенд отвечает"
    break
  fi
  if [ "$i" = 60 ]; then
    echo "Caddy так и не поднял https://relay.test"
    docker logs "$CADDY" | tail -30
    exit 1
  fi
  sleep 2
done

echo "==> Собираю образ стенда (Playwright + Electron)"
docker build -q -f clients/desktop-linux/testbench/Dockerfile -t relay-linux-bench clients/desktop-linux

echo "==> Прогон"
CADDY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CADDY")
docker run --rm --network "$NETWORK" --add-host "relay.test:$CADDY_IP" \
  --ipc=host \
  -v "$PWD":/work -w /work/e2e \
  -e BASE_URL=https://relay.test -e SITE_PASSWORD -e CI=1 \
  -e RELAY_LINUX_SHELL=/shell/desktop-linux \
  relay-linux-bench \
  sh -c '
    set -e
    # Оболочку кладём РЯДОМ с её зависимостями, а не запускаем из /work:
    # Electron не смотрит в NODE_PATH (в отличие от Node), и `electron-updater`
    # из образа он бы не нашёл. Копируем весь clients/ — оболочка берёт из
    # соседнего каталога общий с Tauri-клиентом экран выбора сервера.
    cp -a /work/clients /shell
    ln -sfn /bench/node_modules /shell/desktop-linux/node_modules
    npm install --no-save @playwright/test@1.55.0
    # Electron — настоящее окно, ему нужен дисплей: без Xvfb он выходит с
    # «The platform failed to initialize».
    xvfb-run -a --server-args="-screen 0 1280x1024x24" npx playwright test tests/linux-shell.spec.ts
  '

# Стенд Linux-клиента: Playwright + Electron той же версии, что у оболочки.
#
# Базовый образ — тот же, которым гоняется e2e монорепо (mcr playwright), чтобы
# спек оболочки и браузерные спеки видели одну и ту же версию Playwright: они
# сидят в одном прогоне и делят фикстуры (e2e/fixtures/stand.ts).
#
# Версия Electron НЕ дублируется: она приезжает из package.json самой оболочки,
# который сюда копируется. Разъехаться нечему — стенд ставит ровно то, что
# ставится в сборку.
#
# Собирается из каталога оболочки:
#   docker build -f testbench/Dockerfile -t relay-linux-bench clients/desktop-linux
FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /bench
COPY package.json /bench/package.json
# Бинарь Electron качает postinstall самого пакета, а под root он не отрабатывает:
# `npm install` завершается «успешно», но `dist/electron` в образе нет — и стенд
# падает не на своей ошибке (ENOENT при запуске оболочки). Поэтому зовём загрузку
# явно, а `test -x` валит СБОРКУ образа, если бинаря всё-таки не оказалось.
RUN npm install --unsafe-perm --no-audit --no-fund \
    && npm install --no-save --no-audit --no-fund @playwright/test@1.55.0 \
    && node node_modules/electron/install.js \
    && test -x /bench/node_modules/electron/dist/electron

# Оболочка лежит в примонтированном репозитории и ищет свои зависимости
# (electron-updater) вверх по дереву — там их нет. NODE_PATH и есть тот мост.
ENV NODE_PATH=/bench/node_modules
ENV RELAY_ELECTRON_BIN=/bench/node_modules/electron/dist/electron

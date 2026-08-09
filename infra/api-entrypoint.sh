#!/bin/sh
# Точка входа api. Единственная работа — отдать том с данными пользователю
# node и опуститься до него: docker монтирует свежий named volume от root, и
# без этого api писал бы загрузки и реестр root'ом (audit S6).
#
# Повторный старт стоит копейки: chown трогает только метаданные. Если том
# уже принадлежит node (перезапуск, rootless docker) — chown проходит вхолостую.
set -e

if [ "$(id -u)" = "0" ]; then
  DIR="${UPLOAD_DIR:-/app/uploads}"
  mkdir -p "$DIR"
  chown -R node:node "$DIR"
  exec su-exec node "$@"
fi

# Запущены уже не root (rootless/к8s с securityContext) — опускаться не нужно.
exec "$@"

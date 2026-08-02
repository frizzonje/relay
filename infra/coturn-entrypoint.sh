#!/bin/sh
# Точка входа coturn. Общая для dev- и прод-compose, монтируется внутрь
# контейнера read-only.
#
# Зачем скрипт вместо inline-команды: coturn берёт сертификат для TURN over TLS
# из тома Caddy, а Caddy сертификаты ротирует — на голом IP каждые несколько
# дней (Let's Encrypt выдаёт на IP только shortlived-серты, 160 часов). Логика
# «дождаться серта → перечитать его при ротации» в YAML-строку уже не влезает.
set -eu

CERTS=/certs/caddy/certificates
HOST="${SERVER_HOST:-localhost}"
# Как часто сторож заглядывает на диск. Пять минут против шестидневного серта —
# запас на два порядка; переменная нужна главным образом тестам.
WATCH="${CERT_WATCH_INTERVAL:-300}"

# --external-ip нужен только на машинах за 1:1-NAT и только с адресом IPv4;
# имя хоста coturn сюда не примет.
EXT="${TURN_EXTERNAL_IP:-$HOST}"
case "$EXT" in
  "" | *[!0-9.]*) EXTFLAG="" ;;
  *) EXTFLAG="--external-ip=$EXT" ;;
esac

# Ищем серт по имени хоста, а не по пути: у Let's Encrypt и внутреннего CA
# каталоги разные, а имя файла — всегда субъект сертификата.
find_cert() { find "$CERTS" -type f -name "$HOST.crt" 2>/dev/null | head -n1; }

# На первом старте Caddy ещё выписывает сертификат. Без ожидания coturn
# навсегда останется без TLS — до тех пор, пока кто-нибудь не перезапустит
# контейнер вручную. Ждём до минуты; на последующих стартах серт уже на месте и
# цикл завершается сразу.
CERT=""
i=0
while [ "$i" -lt 12 ]; do
  CERT="$(find_cert)"
  if [ -n "$CERT" ]; then break; fi
  i=$((i + 1))
  sleep 5
done
KEY="${CERT%.crt}.key"

if [ -n "$CERT" ] && [ -f "$KEY" ]; then
  TLSFLAGS="--tls-listening-port=5349 --cert=$CERT --pkey=$KEY --no-dtls"
  echo "coturn: TLS on 5349, certificate $CERT"

  # Сертификат живёт 90 дней на домене и всего 6 — на голом IP. Прочитав пару
  # crt+key один раз на старте, coturn продолжал бы отдавать протухшую: сам он
  # перечитывает сертификаты только по SIGUSR2 (SIGHUP у него — про лог-файл).
  # Сторож шлёт этот сигнал, когда файлы на диске изменились; активные сессии
  # при этом не рвутся. $$ — pid этой оболочки, и exec ниже сохраняет его за
  # turnserver, так что сигнал придёт по адресу.
  TURN_PID=$$
  (
    STAMP="$(md5sum "$CERT" "$KEY" 2>/dev/null || true)"
    while sleep "$WATCH"; do
      kill -0 "$TURN_PID" 2>/dev/null || exit 0
      NEW="$(md5sum "$CERT" "$KEY" 2>/dev/null || true)"
      [ -n "$NEW" ] || continue
      [ "$NEW" != "$STAMP" ] || continue
      STAMP="$NEW"
      echo "coturn: certificate rotated, reloading (SIGUSR2)"
      kill -USR2 "$TURN_PID" 2>/dev/null || exit 0
    done
  ) &
else
  TLSFLAGS="--no-tls --no-dtls"
  echo "coturn: no certificate for $HOST yet — running without TLS on 5349"

  # Сертификата не было и на момент запуска: включить TLS сигналом уже нельзя
  # (turnserver стартовал без --cert), поэтому ждём его появления и роняем
  # процесс — docker поднимет контейнер заново, уже с TLS. Перезапуск случится
  # ровно один раз: пока серта нет, сторож просто тихо опрашивает диск.
  TURN_PID=$$
  (
    while sleep "$WATCH"; do
      kill -0 "$TURN_PID" 2>/dev/null || exit 0
      [ -n "$(find_cert)" ] || continue
      echo "coturn: certificate appeared, restarting to enable TLS"
      kill -TERM "$TURN_PID" 2>/dev/null
      exit 0
    done
  ) &
fi

# shellcheck disable=SC2086 # флаги должны разбиться на слова
exec turnserver -n --log-file=stdout \
  --realm="$HOST" \
  --listening-port=3478 \
  --min-port=49160 --max-port=49200 \
  --lt-cred-mech \
  --user="${TURN_USERNAME:-webrtc}:${TURN_CREDENTIAL:-}" \
  $TLSFLAGS --no-cli \
  --no-multicast-peers \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  $EXTFLAG

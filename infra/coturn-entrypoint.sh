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

# Куда ретранслировать НЕЛЬЗЯ. TURN по построению — «пошли этот пакет туда», и
# без списка ниже сервер работает открытым проксёром внутрь собственной сети.
#
#   0/8            «этот хост»
#   10/8, 172.16/12, 192.168/16   частные сети (RFC1918)
#   100.64/10      CGNAT — им же адресуются Tailscale и часть операторов
#   127/8          петля. coturn закрывает её и сам, но гарантия не должна
#                  зависеть от версии образа
#   169.254/16     link-local, а в нём 169.254.169.254 — сервис метаданных
#                  облака. На AWS/GCP/Hetzner/Яндексе это выдача учётных данных
#                  инстанса: без этой строки открытый TURN превращается в канал
#                  до них — клиент просит ретранслировать на метаданные и
#                  читает ответ как обычный TURN-трафик
#   224/4 и выше   мультикаст, резерв, широковещание
#
# Легитимного адресата среди них нет: пиры звонка — браузеры в интернете, а
# соседи по локальной сети договариваются напрямую, минуя ретранслятор.
DENIED_V4="
0.0.0.0-0.255.255.255
10.0.0.0-10.255.255.255
100.64.0.0-100.127.255.255
127.0.0.0-127.255.255.255
169.254.0.0-169.254.255.255
172.16.0.0-172.31.255.255
192.168.0.0-192.168.255.255
224.0.0.0-255.255.255.255
"

# То же самое по IPv6 — отдельным списком, потому что запрет диапазона IPv4 на
# IPv6-адрес не распространяется никак. На машине с включённым IPv6 (а это
# почти любой VPS) ULA и link-local соседи доступны ровно так же, как 10/8.
#
# Последние два — префиксы NAT64 (RFC 6052 и 8215). Это тот же обход, что и
# ::ffff:a.b.c.d выше, только через шлюз: на IPv6-only машине с NAT64 адрес
# 64:ff9b::a9fe:a9fe уезжает наружу как 169.254.169.254, а правило для IPv4 к
# нему опять не применяется. Без NAT64 эти адреса не ведут никуда, так что
# запрет ничего не стоит и на машинах, где его незачем.
DENIED_V6="
::
::1
64:ff9b::-64:ff9b::ffff:ffff
64:ff9b:1::-64:ff9b:1:ffff:ffff:ffff:ffff:ffff
fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
"

DENYFLAGS=""
for RANGE in $DENIED_V4; do
  DENYFLAGS="$DENYFLAGS --denied-peer-ip=$RANGE"
  # …и он же в виде ::ffff:a.b.c.d. Для coturn это адрес другого семейства, и
  # правило для IPv4 к нему не применяется — а дотянуться через него можно
  # ровно до того же самого места. Обходной путь длиной в один префикс.
  DENYFLAGS="$DENYFLAGS --denied-peer-ip=::ffff:${RANGE%%-*}-::ffff:${RANGE##*-}"
done
for RANGE in $DENIED_V6; do
  DENYFLAGS="$DENYFLAGS --denied-peer-ip=$RANGE"
done

# Чем доказывают право ретранслировать.
#
# TURN_SECRET — временные учётки (TURN REST API): сервер не хранит
# пользователей вовсе, а проверяет HMAC-SHA1 от логина, в котором записан срок
# годности. Выдаёт их api (`apps/api/src/turn.ts`), читая ту же переменную из
# того же `.env`, — разойтись стороны не могут. Секрет наружу не уходит, а
# выданное протухает само, без рестарта и без обрыва чужих звонков.
#
# Без него — как было до 1.0: одна пара логин-пароль на всю инсталляцию,
# бессрочная, и она же в открытую отдаётся каждому вошедшему. Оставлено ради
# инсталляций, чей `.env` написан руками; про это говорится вслух, потому что
# молчаливая небезопасная настройка — худший вид настройки.
if [ -n "${TURN_SECRET:-}" ]; then
  AUTHFLAGS="--use-auth-secret --static-auth-secret=$TURN_SECRET"
  echo "coturn: временные учётки (HMAC), общий секрет из TURN_SECRET"
else
  AUTHFLAGS="--lt-cred-mech --user=${TURN_USERNAME:-webrtc}:${TURN_CREDENTIAL:-}"
  echo "coturn: статическая пара «${TURN_USERNAME:-webrtc}:…» — бессрочная и общая."
  echo "coturn: задайте TURN_SECRET, чтобы перейти на временные учётки."
fi

# shellcheck disable=SC2086 # флаги должны разбиться на слова
exec turnserver -n --log-file=stdout \
  --realm="$HOST" \
  --listening-port=3478 \
  --min-port=49160 --max-port=49200 \
  $AUTHFLAGS \
  $TLSFLAGS --no-cli \
  --no-multicast-peers \
  $DENYFLAGS \
  $EXTFLAG

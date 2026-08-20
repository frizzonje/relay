#!/usr/bin/env bash
# `relay disown` against a real Postgres. The stack is stubbed out — starting
# and stopping api is not what is under test — but the database is not: the
# whole command is four lines of SQL, and SQL is exactly the kind of thing a
# stub would agree with and a cluster would refuse.
#
# Until 1.0 this command edited registry.json. After the registry moved into
# Postgres that file is read once in the life of an installation, so the old
# implementation wrote, reported success, and changed nothing.
set -uo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORK="$(mktemp -d)"
PGC=relaytest-disown-db
cleanup() { docker rm -f "$PGC" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }

# ── a real cluster ───────────────────────────────────────────────────────────
docker rm -f "$PGC" >/dev/null 2>&1
docker run -d --name "$PGC" -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay \
  -e POSTGRES_DB=relay postgres:18-alpine >/dev/null || { echo "  SKIP: no docker"; exit 0; }
# Not pg_isready: the official image runs its own server during initdb, on the
# unix socket only, and pg_isready says yes to that one — after which it shuts
# down, taking with it every table created in the meantime. A query over TCP is
# the honest question, because TCP is exactly what the init server does not
# listen on.
for _ in $(seq 1 60); do
  docker exec -e PGPASSWORD=relay "$PGC" \
    psql -h 127.0.0.1 -U relay -d relay -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

psql() { docker exec -i "$PGC" psql -U relay -d relay -At -q "$@"; }

# Only the columns the command touches. The full schema lives in the api
# migration and is checked there against the entities; repeating it here would
# be a second source of truth for no extra coverage.
psql -c "
  CREATE TABLE servers  (id text PRIMARY KEY, name text NOT NULL, creator_id text);
  CREATE TABLE channels (id text PRIMARY KEY, name text NOT NULL, creator_id text);" >/dev/null

seed() {
  psql -c "
    TRUNCATE servers, channels;
    INSERT INTO servers  VALUES ('srv-1', 'чей-то сервер', 'dev-gone'), ('srv-2', 'общий', NULL);
    INSERT INTO channels VALUES ('ch-1', 'болталка', 'dev-gone');" >/dev/null
}
owner_of() { psql -c "SELECT coalesce(creator_id, '-') FROM $1 WHERE id = '$2'"; }

# ── the stack, stubbed ───────────────────────────────────────────────────────
BIN="$WORK/bin"; mkdir -p "$BIN"
REAL_DOCKER="$(command -v docker)"
cat >"$BIN/docker" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "compose" ]; then
  shift
  args=()
  while [ \$# -gt 0 ]; do
    case "\$1" in
      -f|--profile) shift 2 ;;
      *) args+=("\$1"); shift ;;
    esac
  done
  echo "\${args[*]}" >>"$WORK/compose.log"
  # exec -T db <cmd...> → the scratch cluster, verbatim from -T onwards.
  if [ "\${args[0]}" = "exec" ]; then
    rest=("\${args[@]:1}")
    [ "\${rest[0]}" = "-T" ] && rest=("\${rest[@]:1}")
    rest=("\${rest[@]:1}")
    exec "$REAL_DOCKER" exec -i "$PGC" "\${rest[@]}"
  fi
  exit 0
fi
exec "$REAL_DOCKER" "\$@"
STUB
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"

D="$WORK/stack"; mkdir -p "$D"
cp "$REPO_ROOT/infra/relay-cli.sh" "$D/relay-cli.sh"
cp "$REPO_ROOT/docker-compose.prod.yml" "$D/docker-compose.prod.yml"
printf 'SITE_PASSWORD=x\nRELAY_VERSION=1.0.0\n' >"$D/.env"
relay() { RELAY_DIR="$D" bash "$D/relay-cli.sh" "$@" 2>&1; }

echo "── the list is read out of the database"
seed
OUT="$(relay disown)"
check "the owned server is listed"  "yes" "$(echo "$OUT" | grep -q 'server   srv-1' && echo yes || echo no)"
check "the owned channel too"       "yes" "$(echo "$OUT" | grep -q 'channel  ch-1'  && echo yes || echo no)"
check "and the free server is not"  "no"  "$(echo "$OUT" | grep -q 'srv-2' && echo yes || echo no)"
check "listing does not stop api"   "no"  "$(grep -q 'stop api' "$WORK/compose.log" && echo yes || echo no)"

echo
echo "── releasing one releases exactly one"
OUT="$(relay disown ch-1)"
check "reported one entry"          "yes"      "$(echo "$OUT" | grep -q 'Released 1 entry' && echo yes || echo no)"
check "the channel is free now"     "-"        "$(owner_of channels ch-1)"
check "the server was left alone"   "dev-gone" "$(owner_of servers srv-1)"
check "api was stopped for it"      "yes"      "$(grep -q 'stop api' "$WORK/compose.log" && echo yes || echo no)"
check "and started again"           "yes"      "$(grep -q 'up -d api' "$WORK/compose.log" && echo yes || echo no)"

echo
echo "── an id nobody owns changes nothing"
OUT="$(relay disown ch-1)"
check "says so plainly"             "yes"      "$(echo "$OUT" | grep -q 'Nothing owned matches ch-1' && echo yes || echo no)"
check "api is up regardless"        "yes"      "$(echo "$OUT" | grep -q 'api restarted' && echo yes || echo no)"

echo
echo "── an id shaped like SQL is data, not SQL"
# The value comes off someone's command line. Pasted out of a runbook, out of a
# support thread, out of anywhere — it is never a fragment of the query.
OUT="$(relay disown "x'; UPDATE servers SET creator_id = NULL; --")"
check "the injection released nothing" "dev-gone" "$(owner_of servers srv-1)"
check "and was reported as a miss"     "yes"      "$(echo "$OUT" | grep -q 'Nothing owned matches' && echo yes || echo no)"

echo
echo "── --all releases the rest"
seed
OUT="$(relay disown --all)"
check "reported both entries"       "yes" "$(echo "$OUT" | grep -q 'Released 2 entries' && echo yes || echo no)"
check "the server is free"          "-"   "$(owner_of servers srv-1)"
check "the channel is free"         "-"   "$(owner_of channels ch-1)"
OUT="$(relay disown)"
check "and the list is empty after" "yes" "$(echo "$OUT" | grep -q 'already free to manage' && echo yes || echo no)"

echo
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

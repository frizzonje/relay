#!/usr/bin/env bash
# backup/restore round-trip against real docker volumes (scratch names, never
# the live relay_* ones). `docker compose` is stubbed out — starting the stack
# is not what is under test; moving bytes in and out of volumes is.
set -uo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORK="$(mktemp -d)"
VU=relaytest_uploads; VC=relaytest_caddy_data; VP=relaytest_pgdata
cleanup() { docker volume rm -f "$VU" "$VC" "$VP" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }

BIN="$WORK/bin"; mkdir -p "$BIN"
REAL_DOCKER="$(command -v docker)"
# The stub answers for the database too. pg_dump has to produce something that
# looks like a dump, because backup refuses to write an archive around an empty
# one — that check is the point of it, and a stub that returned nothing would
# make the test pass by never reaching the code under test.
cat >"$BIN/docker" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "compose" ]; then
  echo "\$*" >>"$WORK/compose.log"
  case "\$*" in
    *pg_dump*) echo "-- relay dump"; echo "CREATE TABLE messages (id int);" ;;
    *psql*)    cat >"$WORK/loaded.sql" ;;
  esac
  exit 0
fi
exec "$REAL_DOCKER" "\$@"
STUB
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"

D="$WORK/stack"; mkdir -p "$D"
for f in docker-compose.prod.yml:docker-compose.prod.yml Caddyfile:infra/Caddyfile \
         tls-mode.caddy:infra/tls-mode.caddy coturn-entrypoint.sh:infra/coturn-entrypoint.sh \
         relay-cli.sh:infra/relay-cli.sh; do
  cp "$REPO_ROOT/${f#*:}" "$D/${f%%:*}"
done
printf 'SITE_PASSWORD=s3cret-that-exists-nowhere-else\nRELAY_VERSION=0.8.0\nDOMAIN=example.test\n' >"$D/.env"
chmod 600 "$D/.env"
relay() { RELAY_DIR="$D" RELAY_VOL_UPLOADS="$VU" RELAY_VOL_CADDY="$VC" RELAY_VOL_PGDATA="$VP" bash "$D/relay-cli.sh" "$@" 2>&1; }

seed() { # put known content into the scratch volumes
  docker run --rm -v "$VU":/u -v "$VC":/c -v "$VP":/p alpine sh -c '
    mkdir -p /u/state /c/certs /p/18/docker
    echo "an uploaded file" >/u/photo.jpg
    echo "{\"servers\":[{\"id\":\"s1\"}]}" >/u/state/registry.json
    echo "PEM" >/c/certs/site.crt
    echo "cluster" >/p/18/docker/PG_VERSION' >/dev/null
}

echo "── backup carries everything a rebuild needs (B7.3)"
seed
OUT="$(relay backup)"
TAR="$(ls "$D"/backups/relay-backup-*.tar.gz 2>/dev/null | head -1)"
check "a tarball was produced" "yes" "$([ -n "$TAR" ] && echo yes || echo no)"
LIST="$(tar tzf "$TAR" 2>/dev/null)"
for want in ./u/photo.jpg ./u/state/registry.json ./c/certs/site.crt ./cfg/.env \
            ./cfg/docker-compose.prod.yml ./cfg/Caddyfile ./cfg/tls-mode.caddy \
            ./cfg/coturn-entrypoint.sh ./cfg/relay-cli.sh ./db.sql; do
  check "contains $want" "yes" "$(echo "$LIST" | grep -qxF "$want" && echo yes || echo no)"
done
check "the tarball is not world-readable (.env is in it)" "600" "$(stat -f '%Lp' "$TAR" 2>/dev/null || stat -c '%a' "$TAR")"
# A dump, not a copy of the data directory: the volume must never be read here.
check "the database was dumped, not copied" "yes" "$(grep -q 'pg_dump' "$WORK/compose.log" && echo yes || echo no)"
check "and the data directory stayed out of the archive" "no" "$(echo "$LIST" | grep -q 'PG_VERSION' && echo yes || echo no)"

echo
echo "── backup refuses to write an archive without the database"
mv "$BIN/docker" "$BIN/docker.real-stub"
printf '#!/usr/bin/env bash\nif [ "${1:-}" = "compose" ]; then exit 1; fi\nexec %s "$@"\n' "$REAL_DOCKER" >"$BIN/docker"
chmod +x "$BIN/docker"
OUT="$(relay backup)"
check "a dead database stops the backup" "yes" "$(echo "$OUT" | grep -q 'Could not dump the database' && echo yes || echo no)"
check "and no half-backup was left behind" "1" "$(ls "$D"/backups/relay-backup-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
mv "$BIN/docker.real-stub" "$BIN/docker"

echo
echo "── a stack from before the database backs up anyway"
# The installations that most need an archive are the ones about to be handed a
# database — `relay update` takes one on the way into 1.0. Demanding a dump from
# a stack that has no db service would fail exactly there.
cp "$D/docker-compose.prod.yml" "$WORK/compose.keep"
awk '/^  db:/{skip=1} /^  api:/{skip=0} !skip' "$WORK/compose.keep" >"$D/docker-compose.prod.yml"
: >"$WORK/compose.log"
OUT="$(relay backup)"
PRE="$(ls -t "$D"/backups/relay-backup-*.tar.gz 2>/dev/null | head -1)"
check "an archive was still written" "yes" "$([ -n "$PRE" ] && echo yes || echo no)"
check "it says what is in it" "yes" "$(echo "$OUT" | grep -q 'files and configuration only' && echo yes || echo no)"
check "no dump was attempted" "no" "$(grep -q 'pg_dump' "$WORK/compose.log" && echo yes || echo no)"
check "and the archive carries the uploads and the config" "yes" \
  "$(tar tzf "$PRE" | grep -qxF ./cfg/.env && tar tzf "$PRE" | grep -qxF ./u/photo.jpg && echo yes || echo no)"
check "with no empty dump inside it" "no" "$(tar tzf "$PRE" | grep -qxF ./db.sql && echo yes || echo no)"
cp "$WORK/compose.keep" "$D/docker-compose.prod.yml"
rm -f "$PRE"

echo
echo "── restore puts it back, config included"
# Destroy everything the way a dead machine would — except the data directory,
# which is left behind on purpose: a restore has to clear it, or the cluster
# from this machine's previous life keeps the password the restored .env lost.
docker run --rm -v "$VU":/u -v "$VC":/c alpine sh -c 'find /u /c -mindepth 1 -delete' >/dev/null
echo "SITE_PASSWORD=wrong" >"$D/.env"
echo "# clobbered" >"$D/Caddyfile"
OUT="$(relay restore -y "$TAR")"
check "restore reported success" "yes" "$(echo "$OUT" | grep -q '^✓ Restored' && echo yes || echo no)"
check "uploads are back" "an uploaded file" "$(docker run --rm -v "$VU":/u alpine cat /u/photo.jpg 2>/dev/null)"
check "registry is back" '{"servers":[{"id":"s1"}]}' "$(docker run --rm -v "$VU":/u alpine cat /u/state/registry.json 2>/dev/null)"
check "certificates are back" "PEM" "$(docker run --rm -v "$VC":/c alpine cat /c/certs/site.crt 2>/dev/null)"
check "the password is back" "SITE_PASSWORD=s3cret-that-exists-nowhere-else" "$(grep '^SITE_PASSWORD=' "$D/.env")"
check "Caddyfile un-clobbered" "0" "$(grep -c 'clobbered' "$D/Caddyfile" | tr -d ' ')"
check ".env is 0600 after restore" "600" "$(stat -f '%Lp' "$D/.env" 2>/dev/null || stat -c '%a' "$D/.env")"
check "the CLI is executable after restore" "yes" "$([ -x "$D/relay-cli.sh" ] && echo yes || echo no)"
check "the stack was stopped and started" "yes" "$(grep -q 'down' "$WORK/compose.log" && grep -q 'up -d --remove-orphans' "$WORK/compose.log" && echo yes || echo no)"
check "the old cluster was cleared, not merged into" "" "$(docker run --rm -v "$VP":/p alpine sh -c 'ls -A /p' 2>/dev/null)"
check "the dump was loaded back" "CREATE TABLE messages (id int);" "$(grep 'CREATE TABLE' "$WORK/loaded.sql" 2>/dev/null)"
check "and the database was started before psql ran" "yes" "$(grep -q 'up -d db' "$WORK/compose.log" && echo yes || echo no)"

echo
echo "── restore refuses what it should"
docker run --rm -v "$VU":/u alpine sh -c 'echo survivor >/u/marker' >/dev/null
tar czf "$WORK/junk.tar.gz" -C "$WORK" bin >/dev/null 2>&1
OUT="$(relay restore -y "$WORK/junk.tar.gz")"
check "a tarball that is not a relay backup is rejected" "yes" "$(echo "$OUT" | grep -q 'does not look like a relay backup' && echo yes || echo no)"
check "and nothing was wiped on the way to finding out" "survivor" "$(docker run --rm -v "$VU":/u alpine cat /u/marker 2>/dev/null)"
OUT="$(relay restore -y "$WORK/nope.tar.gz")"
check "a missing file is rejected" "yes" "$(echo "$OUT" | grep -q 'No such file' && echo yes || echo no)"

echo
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

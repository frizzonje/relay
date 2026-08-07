#!/usr/bin/env bash
# backup/restore round-trip against real docker volumes (scratch names, never
# the live relay_* ones). `docker compose` is stubbed out — starting the stack
# is not what is under test; moving bytes in and out of volumes is.
set -uo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORK="$(mktemp -d)"
VU=relaytest_uploads; VC=relaytest_caddy_data
cleanup() { docker volume rm -f "$VU" "$VC" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }

BIN="$WORK/bin"; mkdir -p "$BIN"
REAL_DOCKER="$(command -v docker)"
cat >"$BIN/docker" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "compose" ]; then echo "\$*" >>"$WORK/compose.log"; exit 0; fi
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
relay() { RELAY_DIR="$D" RELAY_VOL_UPLOADS="$VU" RELAY_VOL_CADDY="$VC" bash "$D/relay-cli.sh" "$@" 2>&1; }

seed() { # put known content into the scratch volumes
  docker run --rm -v "$VU":/u -v "$VC":/c alpine sh -c '
    mkdir -p /u/state /c/certs
    echo "an uploaded file" >/u/photo.jpg
    echo "{\"servers\":[{\"id\":\"s1\"}]}" >/u/state/registry.json
    echo "PEM" >/c/certs/site.crt' >/dev/null
}

echo "── backup carries everything a rebuild needs (B7.3)"
seed
OUT="$(relay backup)"
TAR="$(ls "$D"/backups/relay-backup-*.tar.gz 2>/dev/null | head -1)"
check "a tarball was produced" "yes" "$([ -n "$TAR" ] && echo yes || echo no)"
LIST="$(tar tzf "$TAR" 2>/dev/null)"
for want in ./u/photo.jpg ./u/state/registry.json ./c/certs/site.crt ./cfg/.env \
            ./cfg/docker-compose.prod.yml ./cfg/Caddyfile ./cfg/tls-mode.caddy \
            ./cfg/coturn-entrypoint.sh ./cfg/relay-cli.sh; do
  check "contains $want" "yes" "$(echo "$LIST" | grep -qxF "$want" && echo yes || echo no)"
done
check "the tarball is not world-readable (.env is in it)" "600" "$(stat -f '%Lp' "$TAR" 2>/dev/null || stat -c '%a' "$TAR")"

echo
echo "── restore puts it back, config included"
# Destroy everything the way a dead machine would.
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

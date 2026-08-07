#!/usr/bin/env bash
# Functional test for infra/relay-cli.sh with stubbed curl/docker.
set -uo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}
contains() { # contains <desc> <needle> <haystack>
  case "$3" in *"$2"*) PASS=$((PASS+1)); printf '  ok   %s\n' "$1" ;;
  *) FAIL=$((FAIL+1)); printf '  FAIL %s\n       missing: %s\n       in: %s\n' "$1" "$2" "$3" ;; esac
}

# ── stubs ────────────────────────────────────────────────────────────────────
BIN="$WORK/bin"; mkdir -p "$BIN"
cat >"$BIN/curl" <<STUB
#!/usr/bin/env bash
# Serves the local checkout instead of raw.githubusercontent.com, so the test
# exercises the real URL construction without a network.
url=""; out=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
echo "\$url" >>"$WORK/curl.log"
case "\$url" in
  *api.github.com/repos/*/releases/latest)
    if [ -n "\${STUB_NO_GITHUB:-}" ]; then exit 22; fi
    printf '{\n  "tag_name": "v%s",\n  "name": "rel"\n}\n' "\${STUB_LATEST:-9.9.9}"; exit 0 ;;
esac
# https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
ref="\$(echo "\$url" | sed -n 's#.*githubusercontent.com/[^/]*/[^/]*/\([^/]*\)/.*#\1#p')"
path="\$(echo "\$url" | sed -n 's#.*githubusercontent.com/[^/]*/[^/]*/[^/]*/##p')"
if [ -n "\${STUB_BAD_REF:-}" ] && [ "\$ref" = "\${STUB_BAD_REF}" ]; then exit 22; fi
src="$REPO_ROOT/\$path"
[ -f "\$src" ] || exit 22
if [ -n "\${STUB_TRUNCATE:-}" ] && [ "\$path" = "docker-compose.prod.yml" ]; then
  printf 'services:\n  api:\n    image: [[[\n' >"\$out"; exit 0
fi
cp "\$src" "\$out"
STUB
cat >"$BIN/docker" <<STUB
#!/usr/bin/env bash
echo "\$*" >>"$WORK/docker.log"
case "\$*" in
  *" config -q"*) [ -z "\${STUB_BAD_COMPOSE:-}" ] || exit 1 ;;
  *pull*)  [ -z "\${STUB_PULL_FAILS:-}" ] || exit 1 ;;
  *"up -d"*)
    # Fail only the first N attempts: the new version does not come up, the
    # rollback to the old one does. Failing every attempt would test nothing
    # but the "rollback failed too" branch.
    if [ -n "\${STUB_UP_FAILS:-}" ]; then
      n=\$(cat "$WORK/upfails" 2>/dev/null || echo 0)
      if [ "\$n" -lt "\${STUB_UP_FAILS}" ]; then echo \$((n+1)) >"$WORK/upfails"; exit 1; fi
    fi ;;
esac
exit 0
STUB
chmod +x "$BIN/curl" "$BIN/docker"
export PATH="$BIN:$PATH"

# ── a fake installation ──────────────────────────────────────────────────────
mkinstall() { # mkinstall <dir> <extra .env lines...>
  local d="$1"; shift
  mkdir -p "$d"
  cp "$REPO_ROOT/docker-compose.prod.yml" "$d/"
  cp "$REPO_ROOT/infra/Caddyfile" "$d/"
  cp "$REPO_ROOT/infra/tls-mode.caddy" "$d/"
  cp "$REPO_ROOT/infra/coturn-entrypoint.sh" "$d/"
  cp "$REPO_ROOT/infra/relay-cli.sh" "$d/"
  { echo "# test"; echo "SITE_PASSWORD=hunter2"; echo "DOMAIN=example.test"
    for l in "$@"; do echo "$l"; done; } >"$d/.env"
  chmod 600 "$d/.env"
}
relay() { RELAY_DIR="$1" bash "$1/relay-cli.sh" "${@:2}" 2>&1; }

echo "── profiles derived from .env, not from install day (B7.4)"
D="$WORK/i1"; mkinstall "$D" "RELAY_VERSION=0.8.0"
: >"$WORK/docker.log"; relay "$D" up >/dev/null
check "no features -> no profiles" "compose -f docker-compose.prod.yml up -d" "$(cat "$WORK/docker.log")"

D="$WORK/i2"; mkinstall "$D" "TURN_CREDENTIAL=abc"
: >"$WORK/docker.log"; relay "$D" up >/dev/null
check "TURN in .env -> --profile turn" "compose -f docker-compose.prod.yml --profile turn up -d" "$(cat "$WORK/docker.log")"

D="$WORK/i3"; mkinstall "$D" "TURN_CREDENTIAL=abc" "SFU_SECRET=xyz"
: >"$WORK/docker.log"; relay "$D" up >/dev/null
check "both -> both profiles" "compose -f docker-compose.prod.yml --profile turn --profile sfu up -d" "$(cat "$WORK/docker.log")"

# The actual bug: turning a feature on with `relay config` used to do nothing.
echo "SFU_SECRET=late" >>"$WORK/i2/.env"
: >"$WORK/docker.log"; relay "$WORK/i2" up >/dev/null
check "feature enabled after install takes effect" "compose -f docker-compose.prod.yml --profile turn --profile sfu up -d" "$(cat "$WORK/docker.log")"

echo
echo "── update refreshes stack files, not just images (B7.1)"
D="$WORK/u1"; mkinstall "$D" "RELAY_VERSION=0.8.0" "RELAY_REPO=frizzonje/relay"
echo "# stale local edit" >>"$D/Caddyfile"
: >"$WORK/curl.log"; : >"$WORK/docker.log"
OUT="$(STUB_LATEST=9.9.9 relay "$D" update)"
check "version pinned to the new release" "RELAY_VERSION=9.9.9" "$(grep '^RELAY_VERSION=' "$D/.env")"
contains "stack files fetched from the matching tag" "/relay/v9.9.9/docker-compose.prod.yml" "$(cat "$WORK/curl.log")"
contains "the CLI updates itself too" "infra/relay-cli.sh" "$(cat "$WORK/curl.log")"
check "stale local edit replaced" "" "$(grep -c 'stale local edit' "$D/Caddyfile" | tr -d ' ' | sed 's/^0$//')"
check "old files kept" "1" "$(ls -d "$D"/backups/stack-* 2>/dev/null | wc -l | tr -d ' ')"
contains "images pulled and stack restarted" "up -d --remove-orphans" "$(cat "$WORK/docker.log")"

echo
echo "── update picks the TLS file this installation actually uses"
D="$WORK/u2"; mkinstall "$D" "RELAY_VERSION=0.8.0" "RELAY_TLS_MODE=ip"
: >"$WORK/curl.log"; STUB_LATEST=9.9.9 relay "$D" update >/dev/null
contains "ip mode fetches tls-mode-ip.caddy" "infra/tls-mode-ip.caddy" "$(cat "$WORK/curl.log")"
contains "and it lands with the ACME profile" "profile shortlived" "$(cat "$D/tls-mode.caddy")"

D="$WORK/u3"; mkinstall "$D" "RELAY_VERSION=0.8.0" "RELAY_TLS_MODE=domain"
: >"$WORK/curl.log"; STUB_LATEST=9.9.9 relay "$D" update >/dev/null
contains "domain mode fetches the empty switch" "infra/tls-mode.caddy" "$(cat "$WORK/curl.log")"
check "which has no tls block" "0" "$(grep -c '^tls {' "$D/tls-mode.caddy" | tr -d ' ')"

echo
echo "── a failed update leaves the server as it was"
D="$WORK/f1"; mkinstall "$D" "RELAY_VERSION=0.8.0"
BEFORE="$(cat "$D/docker-compose.prod.yml")"
OUT="$(STUB_LATEST=9.9.9 STUB_BAD_REF=v9.9.9 relay "$D" update; echo "rc=$?")"
contains "unreachable ref aborts" "Nothing has been changed" "$OUT"
check "version untouched" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"
check "compose untouched" "$BEFORE" "$(cat "$D/docker-compose.prod.yml")"

D="$WORK/f2"; mkinstall "$D" "RELAY_VERSION=0.8.0"
OUT="$(STUB_LATEST=9.9.9 STUB_BAD_COMPOSE=1 relay "$D" update; echo "rc=$?")"
contains "unparseable compose aborts" "does not parse" "$OUT"
check "version untouched" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"

D="$WORK/f3"; mkinstall "$D" "RELAY_VERSION=0.8.0"
BEFORE="$(cat "$D/docker-compose.prod.yml")"
rm -f "$WORK/upfails"
OUT="$(STUB_LATEST=9.9.9 STUB_UP_FAILS=1 relay "$D" update; echo "rc=$?")"
contains "a stack that will not start rolls back" "Rolled back to 0.8.0" "$OUT"
check "and the pin goes back with it" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"
check "and so do the stack files" "$BEFORE" "$(cat "$D/docker-compose.prod.yml")"
contains "the server is running again, not left down" "up -d --remove-orphans" "$(tail -1 "$WORK/docker.log")"

D="$WORK/f4"; mkinstall "$D" "RELAY_VERSION=0.8.0"
rm -f "$WORK/upfails"
OUT="$(STUB_LATEST=9.9.9 STUB_PULL_FAILS=1 relay "$D" update; echo "rc=$?")"
contains "no images for the new version rolls back" "Rolled back to 0.8.0" "$OUT"

D="$WORK/f5"; mkinstall "$D" "RELAY_VERSION=0.8.0"
OUT="$(STUB_NO_GITHUB=1 relay "$D" update)"
contains "GitHub down: stay put, refresh in place" "staying on 0.8.0" "$OUT"
check "still pinned where it was" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"

echo
echo "── explicit version is also the rollback path"
D="$WORK/r1"; mkinstall "$D" "RELAY_VERSION=9.9.9"
: >"$WORK/curl.log"; relay "$D" update 0.8.0 >/dev/null
check "moves to the version asked for" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"
contains "from that version's tag" "/relay/v0.8.0/" "$(cat "$WORK/curl.log")"
D="$WORK/r2"; mkinstall "$D" "RELAY_VERSION=9.9.9"
relay "$D" update v0.8.0 >/dev/null
check "a leading v is accepted too" "RELAY_VERSION=0.8.0" "$(grep '^RELAY_VERSION=' "$D/.env")"

echo
echo "── .env is data, not code"
D="$WORK/e1"; mkinstall "$D" "RELAY_VERSION=0.8.0"
# One SITE_PASSWORD line only — the point is that this exact string survives.
grep -v '^SITE_PASSWORD=' "$D/.env" >"$D/.env.t" && mv "$D/.env.t" "$D/.env"
printf 'SITE_PASSWORD=%s\n' 'a$(touch /tmp/pwned)`x`b=c' >>"$D/.env"
OUT="$(relay "$D" version)"
contains "reads a password full of shell metacharacters" "0.8.0" "$OUT"
check "and does not execute it" "no" "$([ -e /tmp/pwned ] && echo yes || echo no)"
relay "$D" update 1.2.3 >/dev/null
check "rewriting the version keeps the password intact" 'SITE_PASSWORD=a$(touch /tmp/pwned)`x`b=c' "$(grep '^SITE_PASSWORD=' "$D/.env")"
check ".env stays 0600" "600" "$(stat -f '%Lp' "$D/.env" 2>/dev/null || stat -c '%a' "$D/.env")"

echo
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

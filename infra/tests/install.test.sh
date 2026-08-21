#!/usr/bin/env bash
# End-to-end run of install.sh in a container, with docker and the network
# stubbed out. Answers go in through a pty (`script`) because the installer
# reads its questions from /dev/tty, exactly as it does under `curl | bash`.
set -uo pipefail
REPO_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }
has() { if echo "$3" | grep -qF "$2"; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s (missing: %s)\n' "$1" "$2"; fi; }
hasnt() { if echo "$3" | grep -qF "$2"; then FAIL=$((FAIL+1)); printf '  FAIL %s (present: %s)\n' "$1" "$2"
  else PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; fi; }

INNER_SH="$(mktemp)"
cat >"$INNER_SH" <<'INNER'
#!/usr/bin/env bash
# Runs inside the container.
set -u
mkdir -p /stub
cat >/stub/curl <<'CURL'
#!/usr/bin/env bash
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --resolve|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >>/tmp/curl.log
case "$url" in
  *ipify*|*ifconfig.me*) printf '203.0.113.7'; exit 0 ;;
  *api.github.com/repos/*/tags*)
    # The real repository's answer, in the real repository's shape: one line,
    # a moving `nightly` tag, the desktop app's own releases, and the stack's
    # versions in whatever order GitHub feels like — 0.10.0 above 0.9.0 so a
    # lexical sort would get it wrong.
    if [ -n "${STUB_NO_STACK_TAGS:-}" ]; then
      printf '[{"name":"nightly","x":1},{"name":"desktop-v0.6.1","x":2}]'; exit 0
    fi
    printf '[{"name":"nightly","x":1},{"name":"desktop-v0.6.1","x":2},{"name":"v%s","x":3},{"name":"v0.10.0","x":4},{"name":"v0.9.0","x":5}]' "${STUB_LATEST:-9.9.9}"; exit 0 ;;
  https://*/ ) exit 0 ;;   # the health probe at the end
esac
ref="$(echo "$url" | sed -n 's#.*githubusercontent.com/[^/]*/[^/]*/\([^/]*\)/.*#\1#p')"
path="$(echo "$url" | sed -n 's#.*githubusercontent.com/[^/]*/[^/]*/[^/]*/##p')"
if [ -n "${STUB_OLD_TAG:-}" ] && [ "$ref" = "v${STUB_LATEST:-9.9.9}" ]; then
  # Model a release cut before these files existed: the tree has the old set only.
  case "$path" in infra/relay-cli.sh|infra/tls-mode-ip.caddy) exit 22 ;; esac
fi
[ -f "/repo/$path" ] || exit 22
cp "/repo/$path" "$out"
CURL
cat >/stub/docker <<'DOCKER'
#!/usr/bin/env bash
echo "$*" >>/tmp/docker.log
case "$*" in
  *"tar czf /out/"*)
    # The upgrade takes a backup through this. It has to leave a file behind —
    # the installer trusts the file, not docker's exit code.
    all="$*"
    outdir="$(echo "$all" | sed -n 's#.*-v \([^ ]*\):/out .*#\1#p')"
    name="${all##*tar czf /out/}"; name="${name%% *}"
    if [ -n "$outdir" ] && [ -n "$name" ]; then echo archive >"$outdir/$name"; fi ;;
  *pull*)
    # Only the first pull fails: the pinned tag has no images, the :latest
    # fallback does. Failing every pull would test nothing but `die`.
    if [ -n "${STUB_PULL_FAILS:-}" ] && [ ! -f /tmp/pullfailed ]; then
      touch /tmp/pullfailed; exit 1
    fi ;;
esac
exit 0
DOCKER
chmod +x /stub/curl /stub/docker
export PATH=/stub:$PATH
cp /repo/install.sh /tmp/install.sh
# A machine that already runs relay. The database password is the one value the
# installer must not regenerate: Postgres baked it into the data directory when
# initdb ran, and a fresh one would lock api out of a volume it still has.
if [ -n "${STUB_REINSTALL:-}" ]; then
  mkdir -p /opt/relay
  printf 'SITE_PASSWORD=old\nPOSTGRES_PASSWORD=the-one-initdb-baked-in\n' >/opt/relay/.env
fi
# A server installed before 1.0: same shape, but its compose file has no db
# service — which is what makes this run an upgrade rather than an install.
if [ -n "${STUB_OLD_STACK:-}" ]; then
  mkdir -p /opt/relay
  printf 'SITE_PASSWORD=old\n' >/opt/relay/.env
  awk '/^  db:/{skip=1} /^  api:/{skip=0} !skip' /repo/docker-compose.prod.yml >/opt/relay/docker-compose.prod.yml
fi
# Answers: domain? y / which? relay.test / not resolving, use anyway? y /
# set password? n(generate) / TURN? y / SFU? y
# The sleep keeps the pty's write end open: util-linux `script` tears the
# session down on stdin EOF, which would kill the installer mid-question.
{ printf 'y\ny\nrelay.test\ny\n\ny\ny\ny\n'; sleep 120; } | script -qec "bash /tmp/install.sh" /dev/null
echo "INSTALLER_EXIT=$?"
INNER
chmod +x "$INNER_SH"
trap 'rm -f "$INNER_SH"' EXIT

run() { # run <env...>
  docker run --rm -v "$REPO_ROOT":/repo:ro -v "$INNER_SH":/inner.sh:ro \
    "$@" alpine sh -c 'apk add --no-cache bash util-linux >/dev/null 2>&1; bash /inner.sh; echo "---ENV---"; cat /opt/relay/.env 2>/dev/null; echo "---FILES---"; ls -1 /opt/relay 2>/dev/null; echo "---SHIM---"; cat /usr/local/bin/relay 2>/dev/null; echo "---CURL---"; cat /tmp/curl.log' 2>&1
}

echo "── install.sh, release available (the normal path)"
OUT="$(run -e STUB_LATEST=9.9.9)"
check "installer finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "pins the release it installed" "RELAY_VERSION=9.9.9" "$OUT"
has  "records the repo to update from" "RELAY_REPO=frizzonje/relay" "$OUT"
has  "records the TLS mode" "RELAY_TLS_MODE=domain" "$OUT"
has  "stack files came from the matching tag" "/relay/v9.9.9/docker-compose.prod.yml" "$OUT"
has  "the CLI was downloaded, not baked in" "/relay/v9.9.9/infra/relay-cli.sh" "$OUT"
has  "relay-cli.sh is on disk" "relay-cli.sh" "$OUT"
has  "the shim points at it" 'exec bash "$RELAY_DIR/relay-cli.sh"' "$OUT"
has  "the shim knows the directory" 'RELAY_DIR="/opt/relay"' "$OUT"
has  "TURN answered yes -> signing secret written" "TURN_SECRET=" "$OUT"
# The static pair is what 0.x wrote, and api handed it to every browser in the
# clear. A fresh install must not carry the name at all: leave it in .env and
# coturn goes back to one never-expiring password shared by everyone.
hasnt "and the old never-expiring pair is gone" "TURN_CREDENTIAL=" "$OUT"
has  "SFU answered yes -> secret written" "SFU_SECRET=" "$OUT"
has  "a database password was generated without asking" "POSTGRES_PASSWORD=" "$OUT"

echo
echo "── re-installing over a live installation keeps the database password"
OUT="$(run -e STUB_LATEST=9.9.9 -e STUB_REINSTALL=1)"
check "installer finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "the password initdb baked in survives" "POSTGRES_PASSWORD=the-one-initdb-baked-in" "$OUT"
has  "and says so" "Keeping the existing database password" "$OUT"
check "exactly one of them in .env" "1" "$(echo "$OUT" | grep -c '^POSTGRES_PASSWORD=' | tr -d ' ')"

echo
echo "── upgrading a server that predates the database"
OUT="$(run -e STUB_LATEST=1.0.0 -e STUB_OLD_STACK=1)"
check "installer finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "it says this is an upgrade, not a fresh install" "already installed here" "$OUT"
has  "and what it costs: history starts being kept" "RETENTION_DAYS days" "$OUT"
has  "and that names are picked again" "picks a name" "$OUT"
has  "a backup was taken before anything moved" "Backup: /opt/relay/backups/relay-backup-before-1.0-" "$OUT"
has  "and it says how to go back" "relay restore /opt/relay/backups/" "$OUT"
has  "the stack file was replaced afterwards" "Stack files downloaded" "$OUT"

echo
echo "── the desktop app's releases are not the stack's (found on a live install)"
has  "asked for tags, not for /releases/latest" "/tags?per_page=100" "$OUT"
check "never asked GitHub for the latest release" "0" "$(echo "$OUT" | grep -c 'releases/latest' | tr -d ' ')"

echo
echo "── a repository with desktop tags and no stack tags yet"
OUT="$(run -e STUB_NO_STACK_TAGS=1)"
check "installer finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "says there is nothing published to pin to" "No published release found" "$OUT"
has  "and follows :latest instead of a desktop tag" "RELAY_VERSION=latest" "$OUT"
check "did not try to fetch a stack from desktop-v0.6.1" "0" "$(echo "$OUT" | grep -c 'desktop-v0.6.1' | tr -d ' ')"

echo
echo "── a release too old to carry the new files falls back to the branch"
OUT="$(run -e STUB_LATEST=9.9.9 -e STUB_OLD_TAG=1)"
check "installer still finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "says so out loud" "predates this installer" "$OUT"
has  "and pins :latest rather than a version it did not install" "RELAY_VERSION=latest" "$OUT"
has  "having fetched from the branch instead" "/relay/main/infra/relay-cli.sh" "$OUT"

echo
echo "── a tag whose images were never published"
OUT="$(run -e STUB_LATEST=9.9.9 -e STUB_PULL_FAILS=1)"
check "installer still finished cleanly" "INSTALLER_EXIT=0" "$(echo "$OUT" | grep -o 'INSTALLER_EXIT=[0-9]*')"
has  "falls back rather than dying" "falling back to :latest" "$OUT"
has  "and the pin on disk agrees" "RELAY_VERSION=latest" "$OUT"

echo
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

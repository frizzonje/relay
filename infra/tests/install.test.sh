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
  *api.github.com/repos/*/releases/latest)
    printf '{\n  "tag_name": "v%s"\n}\n' "${STUB_LATEST:-9.9.9}"; exit 0 ;;
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
# Answers: domain? y / which? relay.test / not resolving, use anyway? y /
# set password? n(generate) / TURN? y / SFU? y
# The sleep keeps the pty's write end open: util-linux `script` tears the
# session down on stdin EOF, which would kill the installer mid-question.
{ printf 'y\ny\nrelay.test\ny\n\ny\ny\n'; sleep 120; } | script -qec "bash /tmp/install.sh" /dev/null
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
has  "TURN answered yes -> credential written" "TURN_CREDENTIAL=" "$OUT"
has  "SFU answered yes -> secret written" "SFU_SECRET=" "$OUT"

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

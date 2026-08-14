#!/usr/bin/env bash
# relay — one-command self-host installer (Debian/Ubuntu).
#
#   curl -fsSL https://raw.githubusercontent.com/frizzonje/relay/main/install.sh | bash
#
# Prefer to read before you run (recommended for any curl|bash):
#   curl -fsSLO https://raw.githubusercontent.com/frizzonje/relay/main/install.sh
#   less install.sh && bash install.sh
#
# What it does: installs Docker if missing, asks a few questions (domain, TURN,
# login password), writes /opt/relay/.env, pulls prebuilt images from GHCR,
# opens the firewall, starts the stack, and installs a `relay` helper CLI.
#
# No domain is fine: Let's Encrypt issues certificates for bare IP addresses
# too, so the installer can still give you a trusted https:// — see step 4.
#
# Interactive: questions are read from /dev/tty so it works under `curl | bash`.
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
RELAY_REPO="${RELAY_REPO:-frizzonje/relay}"
RELAY_REF="${RELAY_REF:-main}"
RAW_BASE="${RELAY_RAW_BASE:-https://raw.githubusercontent.com/${RELAY_REPO}/${RELAY_REF}}"
INSTALL_DIR="${RELAY_DIR:-/opt/relay}"
COMPOSE_FILE="docker-compose.prod.yml"

# ── Pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; N=$'\033[0m'
else
  B=''; DIM=''; GRN=''; YLW=''; RED=''; CYN=''; N=''
fi
info() { printf '%s▸%s %s\n' "$CYN" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$N" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$N" >&2; exit 1; }
hr()   { printf '%s────────────────────────────────────────────────────────%s\n' "$DIM" "$N"; }

# Interactive input MUST come from the terminal, not the piped script on stdin.
TTY=/dev/tty
[ -e "$TTY" ] || die "No terminal available. Download and run instead: curl -fsSLO ${RAW_BASE}/install.sh && bash install.sh"

ask() { # ask "Question" "default" -> echoes answer
  local q="$1" def="${2:-}" ans
  if [ -n "$def" ]; then printf '%s %s[%s]%s ' "$q" "$DIM" "$def" "$N" >"$TTY"
  else printf '%s ' "$q" >"$TTY"; fi
  IFS= read -r ans <"$TTY" || ans=''
  printf '%s' "${ans:-$def}"
}
ask_yn() { # ask_yn "Question" "Y|N" -> returns 0 for yes
  local q="$1" def="${2:-Y}" ans hint
  case "$def" in Y|y) hint="Y/n";; *) hint="y/N";; esac
  ans="$(ask "$q ($hint)" "")"
  [ -z "$ans" ] && ans="$def"
  case "$ans" in y|Y|yes|YES|да|Да) return 0;; *) return 1;; esac
}

gen_secret() { # url-safe-ish 24 chars
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 18 | tr '+/' '-_' | tr -d '=\n'
  else head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; fi
}

# Is this a routable IPv4? Let's Encrypt issues certificates for public
# addresses only — offering an IP certificate for a LAN or CGNAT address would
# just buy the user a failed ACME challenge and a confusing wait.
# Plain ifs on purpose: `[ ... ] && return 1` as a function's last command
# returns 1 when the test is false, which is the opposite of what it reads like.
is_public_ipv4() {
  local ip="$1" a b c d o
  IFS=. read -r a b c d <<<"$ip" || return 1
  for o in "$a" "$b" "$c" "$d"; do
    case "$o" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$o" -gt 255 ]; then return 1; fi
  done
  case "$a" in
    0|10|127) return 1 ;;                       # this-network, private, loopback
    172) if [ "$b" -ge 16 ] && [ "$b" -le 31 ]; then return 1; fi ;;
    192) if [ "$b" = 168 ]; then return 1; fi ;;
    169) if [ "$b" = 254 ]; then return 1; fi ;; # link-local
    100) if [ "$b" -ge 64 ] && [ "$b" -le 127 ]; then return 1; fi ;;  # CGNAT
  esac
  if [ "$a" -ge 224 ]; then return 1; fi        # multicast / reserved
  return 0
}

# ── 0. Root ──────────────────────────────────────────────────────────────────
# Re-exec via sudo only when we're a real file on disk. Under `curl | bash` the
# script arrives on stdin ($0 is the shell), so there's nothing to re-exec —
# tell the user to pipe into sudo instead.
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "$0" ] && [ -r "$0" ]; then
    warn "Re-running with sudo…"
    exec sudo -E RELAY_REF="$RELAY_REF" RELAY_RAW_BASE="$RAW_BASE" RELAY_DIR="$INSTALL_DIR" bash "$0" "$@"
  fi
  die "Please run as root. Re-run with:  curl -fsSL ${RAW_BASE}/install.sh | sudo bash"
fi

# Newest published release, without jq — a fresh Debian box has curl and nothing
# else. Prints nothing when GitHub is unreachable or has no releases yet; every
# caller treats that as "follow :latest" rather than as an error.
latest_release() {
  curl -fsSL --max-time 10 "https://api.github.com/repos/${RELAY_REPO}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1
}

hr
printf '%s  relay self-host installer%s\n' "$B" "$N"
hr

# ── 1. OS check ──────────────────────────────────────────────────────────────
. /etc/os-release 2>/dev/null || die "Cannot detect OS (/etc/os-release missing)."
case "${ID:-}:${ID_LIKE:-}" in
  *debian*|*ubuntu*) ok "Detected ${PRETTY_NAME:-$ID}" ;;
  *) warn "This installer targets Debian/Ubuntu. Detected '${PRETTY_NAME:-$ID}'."
     ask_yn "Continue anyway?" "N" || die "Aborted." ;;
esac

# ── 1b. Resources ────────────────────────────────────────────────────────────
# Said out loud rather than enforced. relay runs on a 1 GB single-core VM — the
# database is configured for exactly that (see docker-compose.prod.yml) — but it
# runs there *with swap*. Without it, the box does not refuse to install; it
# installs, and then the kernel picks one container to kill on the first busy
# evening, which reads as "relay randomly restarts" and never as "add swap".
MEM_MB="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
SWAP_MB="$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_MB="$(df -Pm "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)"
if [ "${MEM_MB:-0}" -gt 0 ] && [ "$MEM_MB" -lt 1500 ] && [ "${SWAP_MB:-0}" -lt 1024 ]; then
  warn "${MEM_MB} MB of RAM and ${SWAP_MB} MB of swap. relay fits, but with no room to spare —"
  warn "  add swap before you rely on it:  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi
if [ "${DISK_MB:-0}" -gt 0 ] && [ "$DISK_MB" -lt 3072 ]; then
  warn "Only $((DISK_MB / 1024)) GB free on $(dirname "$INSTALL_DIR"). Images, uploads and the database share it."
fi

# ── 2. Docker ────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker + compose plugin present"
else
  info "Installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh >/dev/null || die "Docker install failed."
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Docker compose plugin missing after install."
  ok "Docker installed"
fi

# ── 3. Public IP ─────────────────────────────────────────────────────────────
info "Detecting public IP…"
PUBIP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
[ -n "$PUBIP" ] && ok "Public IP: $PUBIP" || warn "Could not detect public IP automatically."

hr
printf '%sLet'\''s configure your relay server.%s\n' "$B" "$N"
hr

# ── 4. Domain / TLS ──────────────────────────────────────────────────────────
# Three tiers, best first:
#   domain     — real hostname, ordinary 90-day Let's Encrypt certificate
#   ip         — no domain: Let's Encrypt certificate for the bare IP. Generally
#                available since 2026-01-15, mandatory `shortlived` profile
#                (160 h), renewed by Caddy on its own every couple of days.
#   selfsigned — Caddy's internal CA. Works everywhere, warns in every browser.
DOMAIN="localhost"   # Caddy: localhost => internal CA (self-signed)
SERVER_HOST="${PUBIP:-localhost}"
TLS_MODE="selfsigned"
if ask_yn "Do you have a domain pointed at this server? (needed for a trusted HTTPS cert)" "Y"; then
  while :; do
    D="$(ask "  Domain (e.g. relay.example.com):" "")"
    [ -z "$D" ] && { warn "Empty domain."; continue; }
    # DNS check: does it resolve to our public IP? `|| true` because of
    # `pipefail`: on a host without getent (any non-glibc distro reached through
    # the "continue anyway?" branch above) the pipeline fails, and `set -e` would
    # end the installer right here — silently, mid-question. An unanswered DNS
    # check is meant to be a warning, not the end of the install.
    RES="$(getent ahostsv4 "$D" 2>/dev/null | awk 'NR==1{print $1}' || true)"
    if [ -n "$PUBIP" ] && [ -n "$RES" ] && [ "$RES" = "$PUBIP" ]; then
      ok "  $D → $RES (matches this server)"
    elif [ -n "$RES" ]; then
      warn "  $D resolves to $RES, but this server is ${PUBIP:-unknown}."
      warn "  Let's Encrypt will fail until the A record points here."
      ask_yn "  Use it anyway?" "N" || continue
    else
      warn "  $D does not resolve yet (DNS may still be propagating)."
      ask_yn "  Use it anyway?" "N" || continue
    fi
    DOMAIN="$D"; SERVER_HOST="$D"; TLS_MODE="domain"; break
  done
elif [ -n "$PUBIP" ] && is_public_ipv4 "$PUBIP"; then
  printf '%s  No domain is fine: Let'\''s Encrypt issues certificates for bare IP%s\n' "$DIM" "$N"
  printf '%s  addresses too, so you still get a trusted https:// with no warnings.%s\n' "$DIM" "$N"
  printf '%s  Such certificates live 6 days — Caddy renews them by itself.%s\n' "$DIM" "$N"
  if ask_yn "Get a real certificate for ${PUBIP}?" "Y"; then
    DOMAIN="$PUBIP"; SERVER_HOST="$PUBIP"; TLS_MODE="ip"
    ok "  Certificate will be issued for $PUBIP."
  else
    info "No domain → serving over IP with a self-signed cert (browsers show a warning)."
    SERVER_HOST="$PUBIP"
  fi
else
  # No public IPv4 (private address, IPv6-only, or detection failed) — ACME has
  # nothing to validate against, so the internal CA is the only honest option.
  info "No domain and no public IPv4 → self-signed cert (browsers show a warning)."
  [ -n "$PUBIP" ] && SERVER_HOST="$PUBIP"
fi

# ── 5. Login password ────────────────────────────────────────────────────────
hr
if ask_yn "Set the login password now? (No = generate a strong one)" "N"; then
  while :; do
    P="$(ask "  Login password:" "")"
    [ -n "$P" ] && { SITE_PASSWORD="$P"; break; } || warn "  Empty."
  done
else
  SITE_PASSWORD="$(gen_secret)"
  ok "  Generated login password."
fi

# ── 5b. Database password ────────────────────────────────────────────────────
# Never asked, only generated: nobody types this, and it is not a password in
# the sense the previous question was — it is a secret between two containers.
#
# Re-running the installer on a machine that already has relay MUST keep the old
# one. Postgres reads the password exactly once, when initdb creates the data
# directory; a fresh value here would leave the existing volume answering to a
# password api no longer has, and the failure would show up as "the site is
# down after a re-install" with nothing in the logs to connect it to this line.
POSTGRES_PASSWORD=""
if [ -f "$INSTALL_DIR/.env" ]; then
  POSTGRES_PASSWORD="$(sed -n 's/^[[:space:]]*POSTGRES_PASSWORD=//p' "$INSTALL_DIR/.env" | tail -n1)"
fi
if [ -n "$POSTGRES_PASSWORD" ]; then
  ok "  Keeping the existing database password."
else
  POSTGRES_PASSWORD="$(gen_secret)$(gen_secret)"
fi

# ── 6. TURN ──────────────────────────────────────────────────────────────────
hr
USE_TURN=0; TURN_CREDENTIAL=""
if ask_yn "Enable TURN relay? (recommended — fixes calls on mobile/CGNAT/strict NAT)" "Y"; then
  USE_TURN=1
  TURN_CREDENTIAL="$(gen_secret)"
  ok "  TURN enabled (credential generated)."
fi

# ── 6b. Media server (SFU) ───────────────────────────────────────────────────
# Optional, like TURN: without it calls still work over p2p, they just get heavy
# past 3 people with video (everyone uploads their camera to everyone else).
hr
USE_SFU=0; SFU_SECRET=""
printf '%s  Media server (SFU): needed for calls of 4+ with video.%s\n' "$DIM" "$N"
printf '%s  It adds ~200 MB of image and needs UDP+TCP 40000-40100 open.%s\n' "$DIM" "$N"
if ask_yn "Enable the media server?" "Y"; then
  USE_SFU=1
  # Shared signing key: api mints the pass, sfu verifies it. Empty on either
  # side means no pass is ever accepted, so it must be generated exactly once.
  SFU_SECRET="$(gen_secret)$(gen_secret)"
  ok "  Media server enabled (signing key generated)."
fi

# ── 7. Fetch stack files ─────────────────────────────────────────────────────
hr
info "Installing to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"

# Which TLS switch this installation gets. The repo's tls-mode.caddy is empty
# (comments only), which is exactly right for a domain or for the internal CA —
# Caddy picks the issuer by hostname. A bare IP is the one case it can't infer:
# Let's Encrypt refuses IP identifiers outside the `shortlived` profile, and
# Caddy won't try ACME for an IP at all unless told to. That variant is a file
# of its own so `relay update` can refresh it like everything else.
if [ "$TLS_MODE" = "ip" ]; then TLS_SRC="infra/tls-mode-ip.caddy"; else TLS_SRC="infra/tls-mode.caddy"; fi

# Every file the stack needs, from one ref, all or nothing. Files bind-mounted
# by compose are fetched even when their feature is off: a missing source makes
# docker silently create a directory in its place, and the consumer then fails
# in a way that looks nothing like "the file wasn't downloaded".
fetch_stack() { # fetch_stack <ref> <dest-dir>
  local ref="$1" dest="$2" base name path
  base="https://raw.githubusercontent.com/${RELAY_REPO}/${ref}"
  # An explicit RELAY_RAW_BASE is how you point the installer at a tree that is
  # not on GitHub at all; it can only stand in for the branch install.
  if [ -n "${RELAY_RAW_BASE:-}" ] && [ "$ref" = "$RELAY_REF" ]; then base="$RELAY_RAW_BASE"; fi
  while read -r name path; do
    [ -n "$name" ] || continue
    curl -fsSL --max-time 60 "${base}/${path}" -o "${dest}/${name}" || return 1
    [ -s "${dest}/${name}" ] || return 1
  done <<STACK
${COMPOSE_FILE} ${COMPOSE_FILE}
Caddyfile infra/Caddyfile
coturn-entrypoint.sh infra/coturn-entrypoint.sh
relay-cli.sh infra/relay-cli.sh
tls-mode.caddy ${TLS_SRC}
STACK
}

# Install a release by number, not `:latest` (audit B7.2). `:latest` moves the
# day a release is cut, and with `pull_policy` on it, an ordinary `relay up`
# after a reboot would carry someone across a major version without asking.
# Stack files come from the matching tag for the same reason images do: a
# compose file from `main` next to images from a release is how a service
# acquires an environment variable the running image has never heard of.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
RELEASE="$(latest_release || true)"
if [ -n "$RELEASE" ] && fetch_stack "v${RELEASE}" "$STAGE"; then
  RELAY_VERSION="$RELEASE"
  ok "Installing release ${RELAY_VERSION}"
else
  # No releases yet, GitHub unreachable, or a tag too old to carry these files
  # — fall back to the branch, and then `:latest` is the honest pin for it.
  rm -f "$STAGE"/*
  fetch_stack "$RELAY_REF" "$STAGE" || die "Failed to download the stack files."
  RELAY_VERSION="latest"
  if [ -n "$RELEASE" ]; then
    warn "Release ${RELEASE} predates this installer — installing from ${RELAY_REF} and following :latest."
  else
    warn "No published release found — installing from ${RELAY_REF} and following :latest."
  fi
fi
cp -p "$STAGE"/* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/relay-cli.sh" "$INSTALL_DIR/coturn-entrypoint.sh"
ok "Stack files downloaded"
if [ "$TLS_MODE" = "ip" ]; then ok "TLS mode: Let's Encrypt certificate for $DOMAIN"; fi

# ── 8. Write .env ────────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  warn "Existing .env backed up."
fi
{
  echo "# Generated by install.sh on $(date -u +%FT%TZ)"
  # What this installation is, and where it updates from. `relay update` reads
  # all four: the version it is moving off, the repo and ref to fetch stack
  # files from, and which of the two TLS switches to re-fetch. Written here
  # because the alternative is deciding it at install time and freezing it —
  # which is the bug this whole section exists to fix (audit B7).
  echo "RELAY_VERSION=${RELAY_VERSION}"
  echo "RELAY_REPO=${RELAY_REPO}"
  echo "RELAY_REF=${RELAY_REF}"
  echo "RELAY_TLS_MODE=${TLS_MODE}"
  echo "SITE_PASSWORD=${SITE_PASSWORD}"
  # Between api and Postgres, never typed by a person. Kept across re-installs
  # because initdb baked it into the existing data directory (see step 5b).
  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
  echo "DOMAIN=${DOMAIN}"
  echo "SERVER_HOST=${SERVER_HOST}"
  echo "TURN_USERNAME=webrtc"
  echo "TURN_CREDENTIAL=${TURN_CREDENTIAL}"
  # On cloud VMs behind 1:1 NAT the public IP differs from the local one;
  # coturn needs it advertised for relay candidates.
  if [ "$USE_TURN" = 1 ] && [ -n "$PUBIP" ]; then
    echo "TURN_EXTERNAL_IP=${PUBIP}"
  fi
  # SFU_SECRET alone switches the media server on for api; the sfu container
  # itself only runs under the profile. SFU_ANNOUNCED_IP for the same 1:1 NAT
  # reason as TURN_EXTERNAL_IP — a container address in ICE means no media.
  if [ "$USE_SFU" = 1 ]; then
    echo "SFU_SECRET=${SFU_SECRET}"
    if [ -n "$PUBIP" ]; then echo "SFU_ANNOUNCED_IP=${PUBIP}"; fi
  fi
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"
ok ".env written (chmod 600)"

# ── 9. Firewall (ufw) ────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  info "Opening firewall ports (ufw)…"
  ufw allow OpenSSH   >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp    >/dev/null 2>&1 || true
  ufw allow 443/tcp   >/dev/null 2>&1 || true
  if [ "$USE_TURN" = 1 ]; then
    ufw allow 3478/tcp >/dev/null 2>&1 || true
    ufw allow 3478/udp >/dev/null 2>&1 || true
    ufw allow 5349/tcp >/dev/null 2>&1 || true
    ufw allow 49160:49200/udp >/dev/null 2>&1 || true
  fi
  if [ "$USE_SFU" = 1 ]; then
    ufw allow 40000:40100/udp >/dev/null 2>&1 || true
    ufw allow 40000:40100/tcp >/dev/null 2>&1 || true
  fi
  ok "Firewall rules added (ufw)"
else
  warn "ufw not found — open these ports in your cloud firewall manually:"
  warn "  80/tcp, 443/tcp$([ "$USE_TURN" = 1 ] && echo ', 3478/tcp+udp, 5349/tcp, 49160-49200/udp')$([ "$USE_SFU" = 1 ] && echo ', 40000-40100/udp+tcp')"
fi
# ufw only guards the host; a cloud security group is a second, invisible wall —
# and a media server that silently gets no packets is the classic way to lose an
# evening. Say it out loud whichever firewall we just touched.
if [ "$USE_SFU" = 1 ]; then
  warn "If your provider has its own firewall (AWS/GCP/Hetzner/Yandex), open 40000-40100 UDP+TCP there too — the media server needs it."
fi

# ── 10. Launch ───────────────────────────────────────────────────────────────
hr
# `[ ... ] && VAR=…` as the last command of a line would exit the script under
# `set -e` when the test is false, so profiles are assembled with plain ifs.
PROFILE_ARGS=""
if [ "$USE_TURN" = 1 ]; then PROFILE_ARGS="--profile turn"; fi
if [ "$USE_SFU" = 1 ]; then PROFILE_ARGS="${PROFILE_ARGS:+$PROFILE_ARGS }--profile sfu"; fi
info "Pulling images and starting the stack…"
if ! ( cd "$INSTALL_DIR" && docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS pull ); then
  # A git tag exists but its images don't — the release job failed halfway, or
  # the tag was cut by hand. Better an unpinned installation that runs than a
  # pinned one that doesn't; `relay update` re-pins on the next good release.
  if [ "$RELAY_VERSION" != "latest" ]; then
    warn "No images published for ${RELAY_VERSION} — falling back to :latest."
    sed -i 's/^RELAY_VERSION=.*/RELAY_VERSION=latest/' "$ENV_FILE"
    RELAY_VERSION="latest"
    ( cd "$INSTALL_DIR" && docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS pull ) || die "docker compose pull failed."
  else
    die "docker compose pull failed."
  fi
fi
( cd "$INSTALL_DIR" && docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS up -d ) || die "docker compose up failed."
ok "Stack is up"

# ── 11. relay CLI ────────────────────────────────────────────────────────────
# The CLI itself lives in the stack directory and was downloaded with the rest
# of the stack; this is only a pointer to it. Keeping the logic in a file that
# `relay update` can replace is the whole reason it is no longer a heredoc:
# a CLI baked into the installer can never be fixed on a machine that already
# ran the installer, and the command that fixes things was the CLI (audit B7).
cat >/usr/local/bin/relay <<RELAYSHIM
#!/usr/bin/env bash
# relay — shim. The CLI is ${INSTALL_DIR}/relay-cli.sh; this file only says where.
export RELAY_DIR="${INSTALL_DIR}"
if [ ! -r "\$RELAY_DIR/relay-cli.sh" ]; then
  echo "relay: \$RELAY_DIR/relay-cli.sh is missing — re-run the installer." >&2
  exit 1
fi
exec bash "\$RELAY_DIR/relay-cli.sh" "\$@"
RELAYSHIM
chmod +x /usr/local/bin/relay
ok "Installed 'relay' CLI (try: relay logs)"

# ── 12. Health wait + summary ────────────────────────────────────────────────
info "Waiting for the server to answer…"
# What we print vs what we probe: with a self-signed cert Caddy serves the site
# under the name `localhost`, so a request for the public IP matches no site and
# comes back 404 — probe the name Caddy actually answers to.
case "$TLS_MODE" in
  domain|ip) URL_HOST="$DOMAIN"; PROBE_HOST="$DOMAIN" ;;
  *)         URL_HOST="${PUBIP:-localhost}"; PROBE_HOST="localhost" ;;
esac
UP=0
for _ in $(seq 1 30); do
  # --resolve pins the name to loopback: DNS may not have propagated yet, and a
  # NAT'd VM often cannot reach its own public IP from the inside.
  if curl -fsSk --max-time 3 --resolve "${PROBE_HOST}:443:127.0.0.1" \
       "https://${PROBE_HOST}/" >/dev/null 2>&1; then UP=1; break; fi
  sleep 2
done

hr
if [ "$UP" = 1 ]; then ok "relay is running 🎉"; else warn "Server not answering yet — check 'relay logs'. It may still be pulling a cert."; fi
hr
printf '  %sURL:%s      https://%s\n' "$B" "$N" "$URL_HOST"
printf '  %sPassword:%s %s\n' "$B" "$N" "$SITE_PASSWORD"
# Plain ifs: a false `[ ... ] && printf` is a failing last command and `set -e`
# would end the installer right here, swallowing the rest of the summary.
if [ "$TLS_MODE" = "domain" ]; then
  printf '  %s(first load may take ~30s while Let'\''s Encrypt issues the cert)%s\n' "$DIM" "$N"
elif [ "$TLS_MODE" = "ip" ]; then
  printf '  %s(trusted cert for the IP itself — first load may take ~30s while%s\n' "$DIM" "$N"
  printf '  %s Let'\''s Encrypt issues it; renewed automatically every few days)%s\n' "$DIM" "$N"
  printf '  %s(the address is tied to this IP — if it ever changes, re-run the installer)%s\n' "$DIM" "$N"
else
  printf '  %s(self-signed cert — your browser will warn on first visit)%s\n' "$DIM" "$N"
fi
if [ "$USE_SFU" = 1 ]; then
  printf '  %sMedia server: on%s %s(calls of 4+ with video; per-channel switch in the UI)%s\n' "$B" "$N" "$DIM" "$N"
fi

# ── 13. Owner link ───────────────────────────────────────────────────────────
# The one thing that cannot be decided inside the application: who owns this
# installation. Roles are handed out by the owner, and the first owner has
# nobody to be handed one by — so the claim is issued here, on the machine
# itself, where the only proof of ownership that exists is the shell you are
# already holding.
#
# Issued by `relay owner-link` rather than inline: the link a person needs in a
# year (lost key, admin gone) must come from the same place as the first one,
# and a second implementation here would be the one that rots.
OWNER_LINK=""
if [ "$UP" = 1 ]; then OWNER_LINK="$(relay owner-link 2>/dev/null || true)"; fi
if [ -n "$OWNER_LINK" ]; then
  printf '  %sOwner link:%s %s\n' "$B" "$N" "$OWNER_LINK"
  printf '  %s(open it once, from your own browser — that binds this installation%s\n' "$DIM" "$N"
  printf '  %s to your key. Valid 24h; re-issue any time with `relay owner-link`)%s\n' "$DIM" "$N"
else
  warn "Owner link not issued yet — run 'relay owner-link' once the server answers."
fi

hr
printf '  Manage it:  %srelay logs%s · %srelay update%s · %srelay config%s\n' "$B" "$N" "$B" "$N" "$B" "$N"
printf '  Files in:   %s\n' "$INSTALL_DIR"
hr

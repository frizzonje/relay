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
# Interactive: questions are read from /dev/tty so it works under `curl | bash`.
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────
RELAY_REF="${RELAY_REF:-main}"
RAW_BASE="${RELAY_RAW_BASE:-https://raw.githubusercontent.com/frizzonje/relay/${RELAY_REF}}"
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

# ── 4. Domain ────────────────────────────────────────────────────────────────
DOMAIN="localhost"   # Caddy: localhost => internal CA (self-signed)
SERVER_HOST="${PUBIP:-localhost}"
USING_DOMAIN=0
if ask_yn "Do you have a domain pointed at this server? (needed for a trusted HTTPS cert)" "Y"; then
  while :; do
    D="$(ask "  Domain (e.g. relay.example.com):" "")"
    [ -z "$D" ] && { warn "Empty domain."; continue; }
    # DNS check: does it resolve to our public IP?
    RES="$(getent ahostsv4 "$D" 2>/dev/null | awk 'NR==1{print $1}')"
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
    DOMAIN="$D"; SERVER_HOST="$D"; USING_DOMAIN=1; break
  done
else
  info "No domain → serving over IP with a self-signed cert (browsers show a warning)."
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

# ── 6. TURN ──────────────────────────────────────────────────────────────────
hr
USE_TURN=0; TURN_CREDENTIAL=""
if ask_yn "Enable TURN relay? (recommended — fixes calls on mobile/CGNAT/strict NAT)" "Y"; then
  USE_TURN=1
  TURN_CREDENTIAL="$(gen_secret)"
  ok "  TURN enabled (credential generated)."
fi

# ── 7. Fetch stack files ─────────────────────────────────────────────────────
hr
info "Installing to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
curl -fsSL "${RAW_BASE}/${COMPOSE_FILE}" -o "$INSTALL_DIR/${COMPOSE_FILE}" || die "Failed to download ${COMPOSE_FILE}."
curl -fsSL "${RAW_BASE}/infra/Caddyfile"  -o "$INSTALL_DIR/Caddyfile"       || die "Failed to download Caddyfile."
ok "Stack files downloaded"

# ── 8. Write .env ────────────────────────────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
  warn "Existing .env backed up."
fi
{
  echo "# Generated by install.sh on $(date -u +%FT%TZ)"
  echo "SITE_PASSWORD=${SITE_PASSWORD}"
  echo "DOMAIN=${DOMAIN}"
  echo "SERVER_HOST=${SERVER_HOST}"
  echo "TURN_USERNAME=webrtc"
  echo "TURN_CREDENTIAL=${TURN_CREDENTIAL}"
  # On cloud VMs behind 1:1 NAT the public IP differs from the local one;
  # coturn needs it advertised for relay candidates.
  if [ "$USE_TURN" = 1 ] && [ -n "$PUBIP" ]; then
    echo "TURN_EXTERNAL_IP=${PUBIP}"
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
  ok "Firewall rules added (ufw)"
else
  warn "ufw not found — open these ports in your cloud firewall manually:"
  warn "  80/tcp, 443/tcp$([ "$USE_TURN" = 1 ] && echo ', 3478/tcp+udp, 5349/tcp, 49160-49200/udp')"
fi

# ── 10. Launch ───────────────────────────────────────────────────────────────
hr
PROFILE_ARGS=""; [ "$USE_TURN" = 1 ] && PROFILE_ARGS="--profile turn"
info "Pulling images and starting the stack…"
( cd "$INSTALL_DIR" && docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS pull ) || die "docker compose pull failed."
( cd "$INSTALL_DIR" && docker compose -f "$COMPOSE_FILE" $PROFILE_ARGS up -d ) || die "docker compose up failed."
ok "Stack is up"

# ── 11. relay CLI ────────────────────────────────────────────────────────────
cat >/usr/local/bin/relay <<RELAYCLI
#!/usr/bin/env bash
# relay control CLI — installed by install.sh
set -euo pipefail
DIR="${INSTALL_DIR}"
CF="${COMPOSE_FILE}"
PROFILES="${PROFILE_ARGS}"
cd "\$DIR"
dc() { docker compose -f "\$CF" \$PROFILES "\$@"; }
case "\${1:-}" in
  up)      dc up -d ;;
  down)    dc down ;;
  restart) dc restart ;;
  logs)    shift; dc logs -f --tail=100 "\$@" ;;
  ps)      dc ps ;;
  pull)    dc pull ;;
  update)  dc pull && dc up -d && echo "Updated." ;;
  config)  \${EDITOR:-nano} "\$DIR/.env" && echo "Run: relay up   (to apply)" ;;
  backup)  T="\$DIR/relay-backup-\$(date +%Y%m%d-%H%M%S).tar.gz"
           docker run --rm -v relay_uploads:/u -v relay_caddy_data:/c -v "\$DIR":/out alpine \
             tar czf "/out/\$(basename "\$T")" -C / u c && echo "Backup: \$T" ;;
  *) cat <<USAGE
relay — control CLI (stack in \$DIR)
  relay up | down | restart | ps
  relay logs [service]   follow logs
  relay update           pull latest images and restart
  relay config           edit .env, then 'relay up' to apply
  relay backup           snapshot uploads + certs to a tarball
USAGE
     ;;
esac
RELAYCLI
chmod +x /usr/local/bin/relay
ok "Installed 'relay' CLI (try: relay logs)"

# ── 12. Health wait + summary ────────────────────────────────────────────────
info "Waiting for the server to answer…"
URL_HOST="$([ "$USING_DOMAIN" = 1 ] && echo "$DOMAIN" || echo "${PUBIP:-localhost}")"
UP=0
for _ in $(seq 1 30); do
  if curl -fsSk --max-time 3 "https://localhost/" >/dev/null 2>&1; then UP=1; break; fi
  sleep 2
done

hr
if [ "$UP" = 1 ]; then ok "relay is running 🎉"; else warn "Server not answering yet — check 'relay logs'. It may still be pulling a cert."; fi
hr
printf '  %sURL:%s      https://%s\n' "$B" "$N" "$URL_HOST"
printf '  %sPassword:%s %s\n' "$B" "$N" "$SITE_PASSWORD"
[ "$USING_DOMAIN" = 0 ] && printf '  %s(self-signed cert — your browser will warn on first visit)%s\n' "$DIM" "$N"
[ "$USING_DOMAIN" = 1 ] && printf '  %s(first load may take ~30s while Let'\''s Encrypt issues the cert)%s\n' "$DIM" "$N"
hr
printf '  Manage it:  %srelay logs%s · %srelay update%s · %srelay config%s\n' "$B" "$N" "$B" "$N" "$B" "$N"
printf '  Files in:   %s\n' "$INSTALL_DIR"
hr

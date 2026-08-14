#!/usr/bin/env bash
# relay — control CLI for a self-hosted installation.
#
# Installed by install.sh into the stack directory (/opt/relay/relay-cli.sh);
# /usr/local/bin/relay is a three-line shim that points here. That indirection
# is the point: a file in the stack directory can be replaced by `relay update`,
# a heredoc baked into the installer cannot, and for a year it wasn't.
#
# Two rules this file exists to hold (audit B7):
#
#   1. Nothing is decided at install time that could be decided now. Profiles,
#      the TLS mode and the pinned version are read out of .env on every run, so
#      `relay config` + `relay up` is enough to turn a feature on. Before this,
#      enabling the media server in .env did nothing at all and said nothing
#      about it, because --profile sfu was frozen into the CLI on install day.
#
#   2. Updating means the whole stack, not just the images. compose, Caddyfile,
#      the coturn entry point and this very file are re-fetched to match the
#      version being installed. Until this existed, `relay update` was
#      `docker compose pull` with a nicer name, and every fix that lived outside
#      an image — every compose change, every Caddy header — reached nobody.
set -euo pipefail

DIR="${RELAY_DIR:-/opt/relay}"
CF="docker-compose.prod.yml"
ENV_FILE="$DIR/.env"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; N=$'\033[0m'
else
  B=''; DIM=''; GRN=''; YLW=''; RED=''; CYN=''; N=''
fi
info() { printf '%s▸%s %s\n' "$CYN" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$N" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$N" >&2; exit 1; }

cd "$DIR" 2>/dev/null || die "Stack directory $DIR is gone. Re-run the installer."

# ── .env as data ─────────────────────────────────────────────────────────────
# Read, never source. Values here are passwords chosen by people, and `.` would
# execute the `$(` in one of them.
env_get() {
  if [ -f "$ENV_FILE" ]; then
    sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1
  fi
}

# Rewrite one key in place. Written through a temp file in the same directory so
# a full disk truncates the copy and not the original — .env holds every secret
# the installation has, and there is no other copy of it outside `relay backup`.
env_set() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$ENV_FILE" ]; then
    grep -v "^[[:space:]]*${key}=" "$ENV_FILE" >>"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
}

# ── compose ──────────────────────────────────────────────────────────────────
# Which profiles are on is a property of the configuration, not of the day the
# installer ran (audit B7.4). Both features are keyed off the very variables the
# compose file reads, so there is no second source of truth to drift from.
profiles() {
  local args=""
  if [ -n "$(env_get TURN_CREDENTIAL)" ]; then args="--profile turn"; fi
  if [ -n "$(env_get SFU_SECRET)" ]; then args="${args:+$args }--profile sfu"; fi
  printf '%s' "$args"
}

# Unquoted on purpose: profiles() returns zero, one or two flags, and quoting
# would hand compose a single empty argument when there are none.
# shellcheck disable=SC2046
dc() { docker compose -f "$CF" $(profiles) "$@"; }

# ── Where updates come from ──────────────────────────────────────────────────
REPO="$(env_get RELAY_REPO)"; REPO="${REPO:-frizzonje/relay}"

# The ref follows the pinned version. Pinning images to 0.8.0 and then fetching
# a compose file from `main` is how a service acquires an environment variable
# the running image has never heard of; only an installation that follows
# :latest follows a branch.
ref_for() {
  case "$1" in
    ''|latest) local r; r="$(env_get RELAY_REF)"; printf '%s' "${r:-main}" ;;
    *) printf 'v%s' "$1" ;;
  esac
}
raw_url() { printf 'https://raw.githubusercontent.com/%s/%s/%s' "$REPO" "$(ref_for "$1")" "$2"; }

# The newest published release, without jq — a fresh Debian box has curl and
# nothing else. Failure here is not fatal anywhere it is called.
latest_release() {
  curl -fsSL --max-time 10 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1
}

# Files that live on disk next to the compose file instead of inside an image.
# tls-mode.caddy is deliberately absent: which of two files it is depends on the
# installation, and it is refreshed separately below.
STACK_FILES="docker-compose.prod.yml docker-compose.prod.yml
Caddyfile infra/Caddyfile
coturn-entrypoint.sh infra/coturn-entrypoint.sh
relay-cli.sh infra/relay-cli.sh"

CONFIG_FILES=".env docker-compose.prod.yml Caddyfile tls-mode.caddy coturn-entrypoint.sh relay-cli.sh"

# Docker names volumes after the compose project (`name: relay`). In variables
# because backup and restore have to agree on them, and a typo in one of the two
# stays silent until the day it matters. The overrides exist so the pair can be
# exercised against scratch volumes instead of a live installation's data.
VOL_UPLOADS="${RELAY_VOL_UPLOADS:-relay_uploads}"
VOL_CADDY="${RELAY_VOL_CADDY:-relay_caddy_data}"
VOL_PGDATA="${RELAY_VOL_PGDATA:-relay_pgdata}"

# Database identity, fixed by the compose file. Not read out of DATABASE_URL:
# that variable may point at a database outside this stack, and none of the
# commands below (which all reach in through `docker compose exec db`) would
# mean anything if it did.
PG_USER=relay
PG_DB=relay

# Secrets the stack cannot start without, generated on demand rather than
# demanded of the user. `relay update` calls this before it validates the new
# compose file: an installation from before the database existed has no
# POSTGRES_PASSWORD in .env, and the 1.0 compose file refuses to interpolate
# without one — so the upgrade would fail at the validation step with a message
# about parsing, which is true and useless.
ensure_secret() {
  local key="$1"
  if [ -n "$(env_get "$key")" ]; then return 0; fi
  local val
  if command -v openssl >/dev/null 2>&1; then val="$(openssl rand -hex 24)"
  else val="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  [ -n "$val" ] || die "Could not generate $key (no openssl and no /dev/urandom?)."
  env_set "$key" "$val"
  info "Generated ${key} (new in this version)."
}

# Wait for the database to accept connections. initdb on a first start takes a
# few seconds, and a restore that runs psql one second too early fails in a way
# that looks like a corrupt backup.
wait_for_db() {
  local _
  for _ in $(seq 1 60); do
    if dc exec -T db pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# ── update ───────────────────────────────────────────────────────────────────
cmd_update() {
  local want="${1:-}" cur prev stage backup name path url tls_src
  cur="$(env_get RELAY_VERSION)"; cur="${cur:-latest}"
  prev="$cur"

  if [ -z "$want" ]; then
    info "Looking up the latest release…"
    want="$(latest_release || true)"
    if [ -z "$want" ]; then
      warn "Could not reach GitHub — staying on ${cur} and refreshing it."
      want="$cur"
    fi
  fi
  want="${want#v}"

  if [ "$want" = "$cur" ]; then
    info "Already on ${B}${cur}${N} — re-fetching the stack files anyway."
  else
    info "Updating ${B}${cur}${N} → ${B}${want}${N}"
  fi

  # Download everything before touching anything. A stack half-replaced by a
  # dropped connection is worse than one not replaced at all.
  stage="$(mktemp -d "$DIR/.update.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" EXIT
  while read -r name path; do
    [ -n "$name" ] || continue
    url="$(raw_url "$want" "$path")"
    curl -fsSL --max-time 60 "$url" -o "$stage/$name" \
      || die "Cannot download $path from ${want}. Nothing has been changed."
    [ -s "$stage/$name" ] || die "$path came back empty. Nothing has been changed."
  done <<<"$STACK_FILES"

  # Which TLS file this installation wants — the empty default, or the ACME
  # profile a bare-IP certificate needs. Getting this backwards costs the
  # certificate, so it is stored in .env rather than guessed from the domain.
  if [ "$(env_get RELAY_TLS_MODE)" = "ip" ]; then tls_src="infra/tls-mode-ip.caddy"; else tls_src="infra/tls-mode.caddy"; fi
  curl -fsSL --max-time 60 "$(raw_url "$want" "$tls_src")" -o "$stage/tls-mode.caddy" \
    || die "Cannot download $tls_src from ${want}. Nothing has been changed."

  # Before validation, not after: the check below runs the downloaded compose
  # file against this installation's .env, and a file that needs a secret the
  # .env has never had would be reported as unparseable.
  ensure_secret POSTGRES_PASSWORD

  # A truncated compose file passes the non-empty check and fails at `up`, by
  # which point the old one is already gone. Ask compose itself instead.
  ( cd "$stage" && cp "$ENV_FILE" .env 2>/dev/null || true
    docker compose -f "$CF" config -q >/dev/null 2>&1 ) \
    || die "The downloaded compose file does not parse. Nothing has been changed."
  rm -f "$stage/.env"

  backup="$DIR/backups/stack-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  for name in $CONFIG_FILES; do
    if [ -f "$DIR/$name" ]; then cp -p "$DIR/$name" "$backup/"; fi
  done

  # mv, never cp: this script is one of the files being replaced, and bash reads
  # a script as it runs. Renaming leaves the running copy on its own inode;
  # writing into it in place would splice new bytes into a running program.
  for name in $CONFIG_FILES; do
    if [ -f "$stage/$name" ]; then mv "$stage/$name" "$DIR/$name"; fi
  done
  chmod +x "$DIR/relay-cli.sh" "$DIR/coturn-entrypoint.sh" 2>/dev/null || true
  env_set RELAY_VERSION "$want"
  ok "Stack files now match ${want}"

  info "Pulling images…"
  if ! dc pull; then
    _rollback "$backup" "$prev" "no images published for ${want}"
  fi
  info "Restarting…"
  # --remove-orphans so a service dropped from compose, or a profile switched
  # off in .env, actually goes away instead of running on invisibly.
  if ! dc up -d --remove-orphans; then
    _rollback "$backup" "$prev" "the stack did not come up on ${want}"
  fi
  ok "Updated to ${B}${want}${N}"
  printf '  %sPrevious stack files kept in %s%s\n' "$DIM" "$backup" "$N"
}

# An update that fails is not allowed to leave a server down. Put the old files
# back, re-pin the old version and start what was running before.
_rollback() {
  local backup="$1" prev="$2" why="$3" name
  warn "Update failed: ${why}. Rolling back to ${prev}…"
  for name in $CONFIG_FILES; do
    if [ -f "$backup/$name" ]; then cp -p "$backup/$name" "$DIR/$name"; fi
  done
  env_set RELAY_VERSION "$prev"
  dc up -d --remove-orphans || die "Rollback failed too. The previous files are in ${backup}."
  die "Rolled back to ${prev}. Nothing was upgraded."
}

# ── backup / restore ─────────────────────────────────────────────────────────
# What has to be in there is decided by one question: after `rm -rf /opt/relay`
# on a fresh machine, does this tarball bring the site back? The old backup held
# the two volumes and none of the configuration — so the answer was no, and the
# secrets in .env were unrecoverable (audit B7.3). Since 1.0 the same question
# has a third part: the conversation lives in Postgres, so the archive carries a
# dump of it too.
cmd_backup() {
  local out stage name
  mkdir -p "$DIR/backups"
  out="relay-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  stage="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" EXIT
  mkdir -p "$stage/cfg"
  for name in $CONFIG_FILES; do
    if [ -f "$DIR/$name" ]; then cp -p "$DIR/$name" "$stage/cfg/"; fi
  done

  # The database goes in as a dump, not as a copy of its volume. Copying the
  # data directory of a *running* cluster gives a torn snapshot — files written
  # while the copy walks them — and the result restores, starts, and is wrong.
  # pg_dump reads inside one transaction, so it is consistent by construction.
  info "Dumping the database…"
  dc exec -T db pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists >"$stage/db.sql" 2>"$stage/db.err" \
    || die "Could not dump the database: $(tr -d '\r' <"$stage/db.err" | tail -n1). Is the stack up? ('relay up')"
  [ -s "$stage/db.sql" ] || die "The database dump came back empty. Nothing was written."
  rm -f "$stage/db.err"

  # Everything is mounted under one root so the archive needs a single -C:
  # busybox tar (this is alpine) does not take -C between file arguments.
  docker run --rm \
    -v "$VOL_UPLOADS":/snap/u:ro \
    -v "$VOL_CADDY":/snap/c:ro \
    -v "$stage/cfg":/snap/cfg:ro \
    -v "$stage/db.sql":/snap/db.sql:ro \
    -v "$DIR/backups":/out \
    alpine tar czf "/out/$out" -C /snap . \
    || die "Backup failed."
  # 0600: .env is in there, and $DIR/backups is not a private directory.
  chmod 600 "$DIR/backups/$out"
  ok "Backup: $DIR/backups/$out"
  printf '  %sRestore it with: relay restore %s/backups/%s%s\n' "$DIM" "$DIR" "$out" "$N"
}

cmd_restore() {
  local file="" yes="" tmp ans arg
  for arg in "$@"; do
    case "$arg" in
      -y|--yes) yes=1 ;;
      *) file="$arg" ;;
    esac
  done
  [ -n "$file" ] || die "Usage: relay restore [-y] <backup.tar.gz>"
  [ -f "$file" ] || die "No such file: $file"
  file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  tar xzf "$file" -C "$tmp" || die "Cannot read $file as a tar.gz archive."
  [ -d "$tmp/u" ] && [ -d "$tmp/cfg" ] || die "$file does not look like a relay backup (no u/ and cfg/ inside)."

  # /dev/tty rather than stdin, for the same reason install.sh reads from it:
  # this gets run under `curl | bash` and out of runbooks. -y is for the second
  # case — a restore driven by a script has already been decided by a person.
  if [ -z "$yes" ]; then
    warn "This replaces uploads, certificates and every config file in $DIR."
    printf 'Type %syes%s to continue: ' "$B" "$N"
    IFS= read -r ans </dev/tty || ans=''
    [ "$ans" = "yes" ] || die "Aborted."
  fi

  info "Stopping the stack…"
  dc down || true

  # Volumes are replaced whole, not merged: a restore that leaves yesterday's
  # orphans behind is not a restore. api's entry point re-chowns /app/uploads to
  # node on start, so unpacking as root here is fine.
  info "Restoring volumes…"
  docker run --rm -v "$VOL_UPLOADS":/dst -v "$tmp/u":/src:ro alpine \
    sh -c 'find /dst -mindepth 1 -delete; cp -a /src/. /dst/' || die "Restoring uploads failed."
  if [ -d "$tmp/c" ]; then
    docker run --rm -v "$VOL_CADDY":/dst -v "$tmp/c":/src:ro alpine \
      sh -c 'find /dst -mindepth 1 -delete; cp -a /src/. /dst/' || die "Restoring certificates failed."
  fi

  # The database volume is emptied rather than refilled: the dump is the only
  # copy of the data, and an empty directory is what makes the next start run
  # initdb. That matters beyond tidiness — initdb is what applies the password
  # from the .env being restored, so a cluster left over from this machine's
  # previous life cannot end up with a password api no longer knows.
  docker run --rm -v "$VOL_PGDATA":/dst alpine \
    sh -c 'find /dst -mindepth 1 -delete' || die "Clearing the database volume failed."

  info "Restoring configuration…"
  local name
  for name in $CONFIG_FILES; do
    if [ -f "$tmp/cfg/$name" ]; then cp -p "$tmp/cfg/$name" "$DIR/$name"; fi
  done
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  chmod +x "$DIR/relay-cli.sh" "$DIR/coturn-entrypoint.sh" 2>/dev/null || true

  # An archive without db.sql predates the database entirely (0.x), and there is
  # nothing to load — the empty volume above is already the right answer.
  if [ -f "$tmp/db.sql" ]; then
    info "Starting the database…"
    dc up -d db || die "Restored the files, but the database did not start. Check 'relay logs db'."
    wait_for_db || die "The database did not become ready. Check 'relay logs db'."
    info "Loading the database…"
    dc exec -T db psql -U "$PG_USER" -d "$PG_DB" -q -v ON_ERROR_STOP=1 <"$tmp/db.sql" >/dev/null \
      || die "Loading the dump failed. The stack is down; the archive is untouched."
  fi

  info "Starting…"
  dc up -d --remove-orphans || die "Restored, but the stack did not start. Check 'relay logs'."
  ok "Restored from $(basename "$file")"
}

# ── Снять владение с записей реестра ─────────────────────────────────────────
# Сервер и канал правит устройство, с которого их создали, — а устройство
# теряется: чистая история браузера, новый ноутбук, чужой уехавший коллега.
# Запись остаётся, и удалить её не может уже никто, включая хозяина машины.
# Потолок в 20 серверов при этом общий, так что достаточно накопить их, и новые
# не создаст никто.
#
# Эта команда — выход из такого тупика: она не удаляет ничего, а возвращает
# записи в общее владение, каким оно было до правила. Дальше их удаляют или
# переименовывают из интерфейса, как обычно.
#
# Реестр с 1.0 лежит в Postgres, и правится он там же — раньше эта команда
# редактировала registry.json, а после переезда тот файл читается ровно один
# раз в жизни установки. Оставить как было значило бы команду, которая пишет в
# файл, докладывает об успехе и не меняет ничего.
#
# api на время правки останавливается: реестр он держит в памяти и пишет в базу
# снимком целиком при любом изменении — правка под живым сервисом была бы
# затёрта следующим же созданием канала.
# Запрос идёт на вход psql, а не в -c: подстановку переменных (:'target')
# делает сам psql при разборе ввода, а строку из -c он отправляет серверу как
# есть — и тот спотыкается о двоеточие.
psql_q() { dc exec -T db psql -U "$PG_USER" -d "$PG_DB" -At -q -v ON_ERROR_STOP=1 "$@"; }

cmd_disown() {
  local what="${1:-}" owned n cond
  # Значение приходит от человека из командной строки и уходит в базу
  # переменной psql (:'target'), а не склейкой в текст запроса.
  if [ "$what" = "--all" ]; then cond='TRUE'; else cond="id = :'target'"; fi

  if [ -z "$what" ]; then
    owned="$(psql_q <<'SQL'
      SELECT 'server   ' || id || '  ' || name FROM servers  WHERE creator_id IS NOT NULL
      UNION ALL
      SELECT 'channel  ' || id || '  ' || name FROM channels WHERE creator_id IS NOT NULL;
SQL
    )" || die "Could not read the registry. Is the stack up? ('relay up')"
    if [ -z "$owned" ]; then ok "Every entry is already free to manage."; return 0; fi
    echo "Owned by a device — only that browser can rename or delete them:"
    printf '  %s\n' "$owned"
    cat <<'HINT'

  relay disown <id>     release one
  relay disown --all    release all of them
HINT
    return 0
  fi

  dc stop api >/dev/null || die "Could not stop api. Nothing has been changed."
  # Оба апдейта одним запросом — значит, в одной транзакции: id сервера и id
  # канала не пересекаются, но половина правки при обрыве всё равно недопустима.
  n="$(psql_q -v target="$what" <<SQL
    WITH s AS (UPDATE servers  SET creator_id = NULL WHERE creator_id IS NOT NULL AND ($cond) RETURNING 1),
         c AS (UPDATE channels SET creator_id = NULL WHERE creator_id IS NOT NULL AND ($cond) RETURNING 1)
    SELECT (SELECT count(*) FROM s) + (SELECT count(*) FROM c);
SQL
  )" || { dc up -d api >/dev/null; die "Could not write to the registry. api restarted; nothing was changed."; }

  dc up -d api >/dev/null && echo "api restarted."
  [ "${n:-0}" -gt 0 ] || die "Nothing owned matches ${what}"
  if [ "$n" = 1 ]; then ok "Released 1 entry."; else ok "Released ${n} entries."; fi
}

# ── Owner link ───────────────────────────────────────────────────────────────
# The one command that hands out power over an installation, and the only way
# to get it back. Whoever opens the link binds their own key as the owner; the
# previous owner stops being one. That is deliberate — a lost key or a departed
# admin has to be recoverable, and the only authority this system can appeal to
# is the person holding the machine.
#
# The address the link points at is decided the same way the installer decided
# what to print at the end: a domain (or an IP with a real certificate) answers
# under its own name, a self-signed installation answers under its public
# address. Getting this wrong produces a link that opens a certificate warning
# or nothing at all.
public_host() {
  local mode host
  mode="$(env_get RELAY_TLS_MODE || true)"
  case "$mode" in
    domain|ip) host="$(env_get DOMAIN || true)" ;;
    *)         host="$(env_get SERVER_HOST || true)" ;;
  esac
  # Older installations predate RELAY_TLS_MODE; fall back rather than print a
  # link to nowhere.
  printf '%s' "${host:-$(env_get DOMAIN || true)}"
}

cmd_owner_link() {
  local token host
  # A one-off container, not `exec`: this must work while api is down, and it
  # is also how the installer issues the very first link, moments after the
  # stack came up. Token generation lives in the image (dist/owner-link.js) so
  # there is exactly one implementation of it — this file only dresses it up.
  token="$(dc run --rm -T api node dist/owner-link.js | tail -n1)" \
    || die "Could not issue the owner link. Is the database up? ('relay ps')"
  [ -n "$token" ] || die "api returned no token — see 'relay logs api'."

  host="$(public_host)"
  [ -n "$host" ] || die "No DOMAIN in .env — cannot build the link. Re-run the installer."

  # The link itself goes to stdout alone, so `relay owner-link` can be captured
  # by a script (install.sh does exactly that); everything a human needs is on
  # stderr next to it.
  printf 'Open this once, from the browser you want to own this installation.\n' >&2
  printf 'It is valid for 24 hours, works once, and cancels any earlier link.\n' >&2
  printf 'https://%s/#owner=%s\n' "$host" "$token"
}

# ── Commands ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  up)      dc up -d ;;
  down)    dc down ;;
  restart) dc restart ;;
  logs)    shift; dc logs -f --tail=100 "$@" ;;
  ps)      dc ps ;;
  pull)    dc pull ;;
  update)  shift; cmd_update "${1:-}" ;;
  backup)  cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  config)  ${EDITOR:-nano} "$ENV_FILE" && echo "Run: relay up   (to apply)" ;;
  disown)  shift; cmd_disown "${1:-}" ;;
  owner-link) cmd_owner_link ;;
  version)
    printf '  %sinstalled:%s %s\n' "$B" "$N" "$(env_get RELAY_VERSION || true)"
    printf '  %slatest:%s    %s\n' "$B" "$N" "$(latest_release || echo '(GitHub unreachable)')"
    printf '  %sprofiles:%s  %s\n' "$B" "$N" "$(profiles || true)"
    ;;
  *) cat <<USAGE
relay — control CLI (stack in $DIR)
  relay up | down | restart | ps
  relay logs [service]     follow logs
  relay version            installed version, newest release, active profiles
  relay update [version]   move to the newest release (or a given one, which is
                           also how you roll back); refreshes compose, Caddy and
                           this CLI to match, then pulls images
  relay config             edit .env, then 'relay up' to apply
  relay backup             snapshot volumes AND config into backups/
  relay restore [-y] <f>   put a backup back, config included
  relay disown [id]        list servers/channels tied to a device, or
                           release one (or --all) back to everyone
  relay owner-link         issue a fresh owner link (valid 24h, single use).
                           Whoever opens it becomes the owner and the previous
                           owner stops being one — this is how you take an
                           installation back
USAGE
     ;;
esac

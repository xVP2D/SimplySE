#!/usr/bin/env bash
# Console SELinux — master installer.
#
# Usage (download then run — works on any systemd Linux distro):
#   curl -fsSLO https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install-master.sh
#   bash install-master.sh
#
# Run from a real terminal, it asks a few questions (install directory,
# ports — only if a default looks already taken, whether to install
# Docker). Every question is skipped if you already set the matching
# environment variable, and skipped (defaults used) automatically when
# stdin isn't a terminal — e.g. CI, or a piped `curl ... | bash`. Re-running
# is safe: it updates the checkout, rebuilds, and restarts the service.
#
# Secrets (Postgres and OpenSearch passwords): generated with `openssl
# rand`, never prompted for, never printed, never committed anywhere in
# this repo. They're written once to /etc/selinux-fleet-manager/secrets.env
# (mode 600, root-only) and to the systemd unit's env file (also 600) —
# systemd itself reads that file as root before dropping to the service
# user, so 600 root-only is enough even though the service runs unprivileged.
# Set POSTGRES_PASSWORD / OPENSEARCH_INITIAL_ADMIN_PASSWORD yourself before
# running this script if you'd rather supply your own (e.g. from a vault).
#
# Environment variables (all optional — see prompts above for the
# interactive equivalent of each):
#   REPO_URL, INSTALL_DIR, SERVICE_USER, GO_VERSION
#   GRPC_ADDR, HTTP_ADDR, POSTGRES_HOST_PORT, OPENSEARCH_PORT,
#   NATS_CLIENT_PORT, NATS_MONITOR_PORT
#   POSTGRES_DSN, OPENSEARCH_URL, NATS_URL (advanced: point at
#   already-running infra instead of the bundled docker compose stack)
#   POSTGRES_PASSWORD, OPENSEARCH_INITIAL_ADMIN_PASSWORD
#
# What this does NOT do (known limitations, see README.md):
#   - it generates a single shared dev-style mTLS CA/cert for all agents,
#     not a per-agent enrollment flow — fine to start with, replace before
#     running this at real scale;
#   - it assumes systemd (present on Debian/Ubuntu, RHEL/Fedora/CentOS,
#     SUSE, Arch); Alpine/OpenRC hosts need to run the binary another way.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Granola9025/selinux-fleet-manager.git}"
GO_VERSION="${GO_VERSION:-1.23.4}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

INTERACTIVE=0
[[ -t 0 && -t 1 ]] && INTERACTIVE=1

# prompt VAR "question" "default" — skipped (default used) if VAR is
# already set in the environment, or if not running interactively.
prompt() {
  local var_name="$1" question="$2" default_value="$3"
  if [[ -n "${!var_name:-}" ]]; then return; fi
  if [[ "$INTERACTIVE" -ne 1 ]]; then
    printf -v "$var_name" '%s' "$default_value"
    return
  fi
  local input
  read -r -p "${question} [${default_value}]: " input
  printf -v "$var_name" '%s' "${input:-$default_value}"
}

# confirm "question" default_yes(0/1) — same skip rules as prompt().
confirm() {
  local question="$1" default_yes="$2" input hint
  if [[ "$INTERACTIVE" -ne 1 ]]; then
    return "$((1 - default_yes))"
  fi
  hint="y/N"; [[ "$default_yes" -eq 1 ]] && hint="Y/n"
  read -r -p "${question} [${hint}]: " input
  if [[ -z "$input" ]]; then
    return "$((1 - default_yes))"
  fi
  [[ "$input" =~ ^[Yy]$ ]]
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- 3<&-
}

# resolve_port VAR "label" default_port — prompts only when the default
# looks taken (and only interactively); otherwise silent.
resolve_port() {
  local var_name="$1" label="$2" default_port="$3"
  if [[ -n "${!var_name:-}" ]]; then return; fi
  if port_in_use "$default_port"; then
    warn "port ${default_port} (${label}) looks already in use."
    if [[ "$INTERACTIVE" -eq 1 ]]; then
      local input
      read -r -p "  pick a different port for ${label} [${default_port}]: " input
      printf -v "$var_name" '%s' "${input:-$default_port}"
    else
      die "port ${default_port} (${label}) is in use and this isn't an interactive terminal — re-run with ${var_name}=<port> set."
    fi
  else
    printf -v "$var_name" '%s' "$default_port"
  fi
}

if [[ $EUID -eq 0 ]]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  die "this installs system packages and a systemd service, so it needs root; re-run as root or install sudo."
fi

if ! command -v systemctl >/dev/null 2>&1; then
  die "systemd (systemctl) not found. This installer targets systemd distros (Debian/Ubuntu, RHEL/Fedora/CentOS, SUSE, Arch). On Alpine/OpenRC, build manually (see README.md) and run the binary under your own init system."
fi

prompt INSTALL_DIR "Install directory" "/opt/selinux-fleet-manager"
prompt SERVICE_USER "System user to run the master as" "selinux-fleet"
resolve_port GRPC_PORT "master gRPC (mTLS)" "8443"
resolve_port HTTP_PORT "master HTTP API" "8080"
resolve_port POSTGRES_HOST_PORT "Postgres" "5432"
resolve_port OPENSEARCH_PORT "OpenSearch" "9200"
resolve_port NATS_CLIENT_PORT "NATS client" "4222"
resolve_port NATS_MONITOR_PORT "NATS monitor" "8222"
GRPC_ADDR="${GRPC_ADDR:-:${GRPC_PORT}}"
HTTP_ADDR="${HTTP_ADDR:-:${HTTP_PORT}}"

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  elif command -v zypper >/dev/null 2>&1; then echo zypper
  elif command -v pacman >/dev/null 2>&1; then echo pacman
  elif command -v apk >/dev/null 2>&1; then echo apk
  else echo unknown
  fi
}

install_packages() {
  local pm="$1"; shift
  log "installing base packages via ${pm}: $*"
  case "$pm" in
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    yum) $SUDO yum install -y "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    pacman) $SUDO pacman -Sy --noconfirm "$@" ;;
    apk) $SUDO apk add --no-cache "$@" ;;
    *) warn "unrecognized package manager; make sure these are installed manually: $*" ;;
  esac
}

PKG_MANAGER="$(detect_pkg_manager)"
log "detected package manager: ${PKG_MANAGER}"
install_packages "$PKG_MANAGER" git curl tar ca-certificates openssl

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker + compose plugin already present: $(docker --version)"
    return
  fi
  if ! confirm "Docker was not found. Install it via the official get.docker.com script?" 1; then
    die "Docker is required to run the bundled Postgres/OpenSearch/NATS stack. Install it yourself and re-run, or point POSTGRES_DSN/OPENSEARCH_URL/NATS_URL at infra you already have."
  fi
  log "installing Docker via get.docker.com"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
}
ensure_docker

ensure_go() {
  if command -v go >/dev/null 2>&1; then
    log "go already installed: $(go version)"
    return
  fi
  local arch goarch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) goarch=amd64 ;;
    aarch64) goarch=arm64 ;;
    *) die "no automatic Go install for architecture '${arch}' — install Go >= 1.23 manually and re-run." ;;
  esac
  log "installing Go ${GO_VERSION} (${goarch})"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" -o /tmp/go.tar.gz
  $SUDO rm -rf /usr/local/go
  $SUDO tar -C /usr/local -xzf /tmp/go.tar.gz
  rm -f /tmp/go.tar.gz
  $SUDO tee /etc/profile.d/golang.sh >/dev/null <<'EOF'
export PATH="$PATH:/usr/local/go/bin"
EOF
}
ensure_go
export PATH="/usr/local/go/bin:$PATH"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "updating existing checkout in ${INSTALL_DIR}"
  $SUDO git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
  $SUDO git -C "$INSTALL_DIR" pull --ff-only
else
  log "cloning ${REPO_URL} into ${INSTALL_DIR}"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  $SUDO git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating system user ${SERVICE_USER}"
  $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if [[ ! -f "$INSTALL_DIR/deploy/certs/ca.crt" ]]; then
  log "generating mTLS certs (dev-style shared cert — see script header for the limitation)"
  (cd "$INSTALL_DIR" && bash deploy/scripts/gen-certs.sh)
else
  log "certs already present in ${INSTALL_DIR}/deploy/certs — leaving them as-is"
fi

# --- secrets ---------------------------------------------------------
# Generated once, stored only in root-only files, never echoed to the
# terminal or a log. Re-running the installer reuses whatever is already
# in secrets.env instead of rotating it out from under a running stack.
SECRETS_FILE=/etc/selinux-fleet-manager/secrets.env
$SUDO mkdir -p /etc/selinux-fleet-manager
if [[ -f "$SECRETS_FILE" ]]; then
  log "reusing existing secrets from ${SECRETS_FILE}"
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    export "${key}=${value}"
  done < <($SUDO cat "$SECRETS_FILE")
else
  log "generating Postgres and OpenSearch passwords"
  : "${POSTGRES_PASSWORD:=$(openssl rand -hex 24)}"
  # OpenSearch's setup script enforces a complexity policy (upper + lower
  # + digit + special); a plain hex string can fail it, hence the fixed
  # prefix plus random suffix rather than openssl rand alone.
  : "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:=Aa1!$(openssl rand -hex 16)}"
  {
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
    echo "OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OPENSEARCH_INITIAL_ADMIN_PASSWORD}"
  } | $SUDO tee "$SECRETS_FILE" >/dev/null
  $SUDO chmod 600 "$SECRETS_FILE"
  $SUDO chown root:root "$SECRETS_FILE"
fi
# -----------------------------------------------------------------------

log "starting infra (Postgres, OpenSearch, NATS) via docker compose"
# `env VAR=...` (rather than `sudo -E`) so this works whether $SUDO is
# "sudo" or empty (already root); empty values still trigger docker
# compose's own ${VAR:-default} fallback in deploy/docker-compose.yml.
(cd "$INSTALL_DIR" && $SUDO env \
  "POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT}" \
  "OPENSEARCH_PORT=${OPENSEARCH_PORT}" \
  "NATS_CLIENT_PORT=${NATS_CLIENT_PORT}" \
  "NATS_MONITOR_PORT=${NATS_MONITOR_PORT}" \
  "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  "OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" \
  docker compose -f deploy/docker-compose.yml up -d)

log "building master (this can take a minute the first time)"
(cd "$INSTALL_DIR/master" && $SUDO env "PATH=$PATH" go build -o bin/master ./cmd/master)

POSTGRES_DSN="${POSTGRES_DSN:-postgres://selinux:${POSTGRES_PASSWORD}@localhost:${POSTGRES_HOST_PORT}/selinux?sslmode=disable}"
{
  echo "GRPC_ADDR=${GRPC_ADDR}"
  echo "HTTP_ADDR=${HTTP_ADDR}"
  echo "POSTGRES_DSN=${POSTGRES_DSN}"
  [[ -n "${OPENSEARCH_URL:-}" ]] && echo "OPENSEARCH_URL=${OPENSEARCH_URL}"
  [[ -n "${NATS_URL:-}" ]] && echo "NATS_URL=${NATS_URL}"
} | $SUDO tee /etc/selinux-fleet-manager/master.env >/dev/null
# Contains the Postgres password inline in the DSN above: systemd's
# EnvironmentFile is read by the (root) manager process itself, before it
# execs the unprivileged service user, so root-only 600 is sufficient —
# the service user never needs read access to this file.
$SUDO chmod 600 /etc/selinux-fleet-manager/master.env
$SUDO chown root:root /etc/selinux-fleet-manager/master.env

log "installing systemd service"
$SUDO tee /etc/systemd/system/selinux-fleet-master.service >/dev/null <<EOF
[Unit]
Description=Console SELinux -- master server
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-/etc/selinux-fleet-manager/master.env
ExecStart=${INSTALL_DIR}/master/bin/master
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

$SUDO chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now selinux-fleet-master

sleep 2
if $SUDO systemctl is-active --quiet selinux-fleet-master; then
  log "master is running."
else
  warn "master did not start cleanly — check: journalctl -u selinux-fleet-master -e"
fi

cat <<EOF

--------------------------------------------------------------------
Master installed in ${INSTALL_DIR}, running as service
'selinux-fleet-master' (user ${SERVICE_USER}).

  Health check : curl http://localhost:${HTTP_ADDR#:}/api/health
  Logs         : journalctl -u selinux-fleet-master -f
  Config       : /etc/selinux-fleet-manager/master.env (then:
                 systemctl restart selinux-fleet-master)
  Secrets      : /etc/selinux-fleet-manager/secrets.env (mode 600,
                 root-only — Postgres/OpenSearch passwords, generated,
                 not printed here; 'sudo cat' it if you need one, e.g.
                 to run psql by hand)

To enroll an agent, copy these 3 files to it (dev-style shared cert —
see this script's header comment) before running install-agent.sh there:

  scp ${INSTALL_DIR}/deploy/certs/{ca.crt,agent-dev.crt,agent-dev.key} <user>@<agent-host>:/tmp/
  # then on the agent host:
  sudo mkdir -p /etc/selinux-fleet-manager/certs
  sudo mv /tmp/{ca.crt,agent-dev.crt,agent-dev.key} /etc/selinux-fleet-manager/certs/
  sudo chmod 600 /etc/selinux-fleet-manager/certs/agent-dev.key
--------------------------------------------------------------------
EOF

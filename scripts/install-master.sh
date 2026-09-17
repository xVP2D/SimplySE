#!/usr/bin/env bash
# Console SELinux — master installer.
#
# Usage (download then run — works on any systemd Linux distro):
#   curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-master.sh
#   bash install-master.sh
#
# Run from a real terminal, it asks a few questions (install directory,
# ports — only if a default looks already taken, whether to install
# Docker). Every question is skipped if you already set the matching
# environment variable, and skipped (defaults used) automatically when
# stdin isn't a terminal — e.g. CI, or a piped `curl ... | bash`. Re-running
# is safe: it updates the checkout, rebuilds, and restarts the service.
#
# Secrets (Postgres/OpenSearch passwords, agent enrollment token):
# generated with `openssl rand`, never prompted for, never printed, never
# committed anywhere in this repo. They're written once to
# /etc/selinux-fleet-manager/secrets.env (mode 600, root-only) and to the
# systemd unit's env file (also 600) — systemd itself reads that file as
# root before dropping to the service user, so 600 root-only is enough
# even though the service runs unprivileged. Set POSTGRES_PASSWORD /
# OPENSEARCH_INITIAL_ADMIN_PASSWORD / ENROLL_TOKEN yourself before running
# this script if you'd rather supply your own (e.g. from a vault).
#
# Agent enrollment: at the end of a successful run, this script prints a
# ready-to-run install-agent.sh command (with MASTER_ADDR and ENROLL_TOKEN
# filled in) — install-agent.sh uses that token to fetch the shared agent
# mTLS identity from GET /api/enroll automatically, no manual cert copying.
#
# Dashboard: the web UI is built (npm, installed automatically if missing)
# and served by the master binary itself, on the *same* port as the HTTP
# API (HTTP_ADDR, default 8080) — no separate web server or port to manage.
#
# Environment variables (all optional — see prompts above for the
# interactive equivalent of each):
#   REPO_URL, INSTALL_DIR, SERVICE_USER, GO_VERSION, NODE_VERSION
#   GRPC_ADDR, HTTP_ADDR, POSTGRES_HOST_PORT, OPENSEARCH_PORT,
#   NATS_CLIENT_PORT, NATS_MONITOR_PORT
#   POSTGRES_DSN, OPENSEARCH_URL, NATS_URL (advanced: point at
#   already-running infra instead of the bundled docker compose stack)
#   POSTGRES_PASSWORD, OPENSEARCH_INITIAL_ADMIN_PASSWORD, ENROLL_TOKEN
#
# What this does NOT do (known limitations, see README.md):
#   - the enrollment token grants the *same* shared identity to every
#     agent that presents it — it is not a per-agent enrollment/issuance
#     flow, just automation of copying one dev-style shared cert;
#   - it assumes systemd (present on Debian/Ubuntu, RHEL/Fedora/CentOS,
#     SUSE, Arch); Alpine/OpenRC hosts need to run the binary another way.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/xVP2D/SimplySE.git}"
GO_VERSION="${GO_VERSION:-1.23.4}"
NODE_VERSION="${NODE_VERSION:-20.18.1}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

INTERACTIVE=0
# stdin alone: read -p writes its prompt to stderr, not stdout, so
# redirecting/logging stdout (e.g. `bash install-master.sh > log.txt`, or
# `| tee log.txt`) must not turn off prompting as long as stdin is still a
# real terminal.
[[ -t 0 ]] && INTERACTIVE=1

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
# xz(-utils): needed to extract the Node.js tarball below.
case "$PKG_MANAGER" in
  apt) install_packages apt git curl tar xz-utils ca-certificates openssl ;;
  *) install_packages "$PKG_MANAGER" git curl tar xz ca-certificates openssl ;;
esac

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker + compose plugin already present: $(docker --version)"
    return
  fi
  if ! confirm "Docker was not found. Install it now?" 1; then
    die "Docker is required to run the bundled Postgres/OpenSearch/NATS stack. Install it yourself and re-run, or point POSTGRES_DSN/OPENSEARCH_URL/NATS_URL at infra you already have."
  fi

  # get.docker.com's own distro detection doesn't always recognize RHEL
  # rebuilds (AlmaLinux, Rocky, ...) even though the docker-ce package
  # itself installs fine there — so on dnf/yum we go straight to Docker's
  # documented CentOS-repo install instead of depending on that script's
  # distro whitelist. https://docs.docker.com/engine/install/centos/
  case "$PKG_MANAGER" in
    dnf|yum)
      log "installing Docker CE via Docker's centos dnf/yum repo (works on RHEL-family rebuilds too)"
      if command -v dnf >/dev/null 2>&1; then
        $SUDO dnf -y install dnf-plugins-core
        $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        $SUDO dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      else
        $SUDO yum -y install yum-utils
        $SUDO yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        $SUDO yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      fi
      ;;
    *)
      log "installing Docker via get.docker.com"
      curl -fsSL https://get.docker.com | $SUDO sh
      ;;
  esac
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

ensure_node() {
  if command -v npm >/dev/null 2>&1; then
    log "node already installed: $(node --version)"
    return
  fi
  local arch nodearch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) nodearch=x64 ;;
    aarch64) nodearch=arm64 ;;
    *) die "no automatic Node install for architecture '${arch}' — install Node >= 20 manually and re-run." ;;
  esac
  log "installing Node ${NODE_VERSION} (${nodearch})"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodearch}.tar.xz" -o /tmp/node.tar.xz
  $SUDO rm -rf /usr/local/node
  $SUDO mkdir -p /usr/local/node
  $SUDO tar -C /usr/local/node --strip-components=1 -xJf /tmp/node.tar.xz
  rm -f /tmp/node.tar.xz
  $SUDO tee /etc/profile.d/nodejs.sh >/dev/null <<'EOF'
export PATH="$PATH:/usr/local/node/bin"
EOF
}
ensure_node
export PATH="/usr/local/node/bin:$PATH"

# Self-heal from older versions of this script (before commit d397e09),
# which chowned the whole tree to SERVICE_USER — breaking every plain
# [[ -d/-f ]] check below (and this repo's own re-clone detection) for
# whoever re-runs the installer without being that exact user. Ownership
# stays root:root going forward; only master.key gets a narrow exception
# near the end, for the one thing SERVICE_USER actually needs to read.
if $SUDO test -d "$INSTALL_DIR"; then
  $SUDO chown -R root:root "$INSTALL_DIR" 2>/dev/null || true
  # Also normalize permission *bits*, not just ownership: a hardened
  # default umask (seen on CIS-baselined images — e.g. root's umask set
  # to 077 instead of 022) makes every file root creates here (git clone,
  # go build, npm install) unreadable/unexecutable by anyone else,
  # including the unprivileged SERVICE_USER the master service runs as.
  # systemd then can't even exec the binary and reports the opaque
  # "203/EXEC" — no application error, because it never got that far.
  # `a+rX`: read for everyone, execute for everyone only where some
  # execute bit already existed (directories, and files already
  # executable for at least one class) — never turns a data file into an
  # executable. Re-lock the private keys right after: this grant would
  # otherwise have made an *existing* master.key/agent-dev.key
  # world-readable too.
  $SUDO chmod -R a+rX "$INSTALL_DIR" 2>/dev/null || true
  $SUDO chmod 600 "$INSTALL_DIR"/deploy/certs/*.key 2>/dev/null || true
fi
# Same reasoning, but for the *parent* of INSTALL_DIR (e.g. /opt itself):
# a hardened baseline can leave that non-traversable for anyone but root
# too, which systemd reports as "Unable to locate executable" — one level
# up from where the previous fix looks. Not recursive: this directory may
# contain unrelated things we shouldn't touch, we only need to pass
# through it, not read/write it.
$SUDO chmod o+x "$(dirname "$INSTALL_DIR")" 2>/dev/null || true

if $SUDO test -d "$INSTALL_DIR/.git"; then
  # $SUDO, not a bare [[ -d ]]: root (the owner) can always stat it, but an
  # unprivileged re-run as a different user might not be able to —
  # the plain check would then wrongly report "doesn't exist" and attempt
  # a fresh clone into a non-empty directory.
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

if ! $SUDO test -f "$INSTALL_DIR/deploy/certs/ca.crt"; then
  log "generating mTLS certs (dev-style shared cert — see script header for the limitation)"
  # Absolute path, no external `cd` needed (or wanted — the invoking user
  # may not have permission to cd into $INSTALL_DIR): gen-certs.sh finds
  # its own directory from $BASH_SOURCE regardless of caller's cwd.
  $SUDO bash "$INSTALL_DIR/deploy/scripts/gen-certs.sh"
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
  log "generating Postgres/OpenSearch passwords and an agent enrollment token"
  : "${POSTGRES_PASSWORD:=$(openssl rand -hex 24)}"
  # OpenSearch's setup script enforces a complexity policy (upper + lower
  # + digit + special); a plain hex string can fail it, hence the fixed
  # prefix plus random suffix rather than openssl rand alone.
  : "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:=Aa1!$(openssl rand -hex 16)}"
  # Bearer token gating GET /api/enroll (see internal/api.enroll) — lets
  # install-agent.sh fetch the shared agent cert automatically instead of
  # the operator scp-ing it by hand.
  : "${ENROLL_TOKEN:=$(openssl rand -hex 32)}"
  {
    echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
    echo "OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OPENSEARCH_INITIAL_ADMIN_PASSWORD}"
    echo "ENROLL_TOKEN=${ENROLL_TOKEN}"
  } | $SUDO tee "$SECRETS_FILE" >/dev/null
  $SUDO chmod 600 "$SECRETS_FILE"
  $SUDO chown root:root "$SECRETS_FILE"
fi
# -----------------------------------------------------------------------

log "starting infra (Postgres, OpenSearch, NATS) via docker compose"
# `-f <path>` (no cd needed) and `env VAR=...` (rather than `sudo -E`) so
# this works whether $SUDO is "sudo" or empty (already root); empty
# values still trigger docker compose's own ${VAR:-default} fallback in
# deploy/docker-compose.yml.
$SUDO env \
  "POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT}" \
  "OPENSEARCH_PORT=${OPENSEARCH_PORT}" \
  "NATS_CLIENT_PORT=${NATS_CLIENT_PORT}" \
  "NATS_MONITOR_PORT=${NATS_MONITOR_PORT}" \
  "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  "OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" \
  docker compose -f "$INSTALL_DIR/deploy/docker-compose.yml" up -d

log "building master (this can take a minute the first time)"
# -C (no cd needed): avoids depending on the invoking user being able to
# cd into $INSTALL_DIR at all (unlike $SUDO, a plain `cd` isn't privileged).
$SUDO env "PATH=$PATH" go build -C "$INSTALL_DIR/master" -o bin/master ./cmd/master

log "building the dashboard (npm install + build — a couple of minutes the first time)"
$SUDO env "PATH=$PATH" npm --prefix "$INSTALL_DIR/frontend" install --no-fund --no-audit
$SUDO env "PATH=$PATH" npm --prefix "$INSTALL_DIR/frontend" run build

# Re-apply the same permission fix as the self-heal block above, now that
# the build actually ran: go build/npm run build just created bin/master
# and frontend/dist fresh, as root, under whatever umask root has — on the
# same hardened hosts where the self-heal block above matters, a
# restrictive umask (e.g. 077) affects these newly created files too, and
# the earlier fix (which ran before they existed) never touched them.
# Without this, a completely fresh install (nothing to self-heal yet)
# still hits 203/EXEC on its own freshly built binary.
$SUDO chmod -R a+rX "$INSTALL_DIR" 2>/dev/null || true
$SUDO chmod 600 "$INSTALL_DIR"/deploy/certs/*.key 2>/dev/null || true

# On SELinux hosts, `go build`'s output isn't just wrong on permission
# *bits* — it also carries the wrong *label*. Go builds into a temp file
# and renames it into place; a rename preserves the source's SELinux
# context instead of inheriting the destination directory's, so the
# binary comes out labeled as a generic temp-file type (e.g. user_tmp_t)
# rather than an executable type. systemd runs services from the init_t
# domain, which has no rule allowing it to execute that type without a
# domain transition — the kernel denies it, and because that specific
# denial is dontaudit'd in the shipped policy, it never shows up in
# ausearch/journalctl at all: systemd just reports the opaque 203/EXEC,
# indistinguishable from a DAC problem from the log alone (confirmed by
# reproducing this exact box's failure, and confirming `setenforce 0`
# alone — nothing else — made it start). A manual `sudo -u <service user>
# <binary>` test is misleading here: an interactive login shell runs
# unconfined, which is allowed to execute virtually any type, so it
# "works" even though the systemd-launched service still can't.
# bin_t is the standard generic executable type nearly every domain
# (including init_t) is allowed to execute_no_trans — semanage records
# the mapping persistently so future rebuilds (which recreate the file,
# and so its label) get relabeled the same way without re-adding the rule.
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != "Disabled" ]]; then
  log "SELinux is active: relabeling the master binary as bin_t so systemd (running as init_t) is allowed to execute it"
  if ! command -v semanage >/dev/null 2>&1; then
    case "$PKG_MANAGER" in
      dnf) $SUDO dnf install -y policycoreutils-python-utils ;;
      yum) $SUDO yum install -y policycoreutils-python-utils ;;
      zypper) $SUDO zypper --non-interactive install policycoreutils-python-utils ;;
      *) warn "SELinux is active but 'semanage' isn't available and couldn't be auto-installed on this distro; the master binary may fail to start with a bare 203/EXEC. Install policycoreutils-python-utils (or equivalent) and run: semanage fcontext -a -t bin_t '${INSTALL_DIR}/master/bin/master' && restorecon -v '${INSTALL_DIR}/master/bin/master'" ;;
    esac
  fi
  if command -v semanage >/dev/null 2>&1; then
    $SUDO semanage fcontext -a -t bin_t "${INSTALL_DIR}/master/bin/master" 2>/dev/null || true
    $SUDO restorecon -v "${INSTALL_DIR}/master/bin/master" 2>/dev/null || true
  fi
fi

POSTGRES_DSN="${POSTGRES_DSN:-postgres://selinux:${POSTGRES_PASSWORD}@localhost:${POSTGRES_HOST_PORT}/selinux?sslmode=disable}"
{
  echo "GRPC_ADDR=${GRPC_ADDR}"
  echo "HTTP_ADDR=${HTTP_ADDR}"
  echo "POSTGRES_DSN=${POSTGRES_DSN}"
  echo "ENROLL_TOKEN=${ENROLL_TOKEN}"
  # `|| true` on both: under `set -e` + `pipefail`, this group's exit
  # status feeds the pipe below, and a false `[[ ]] && echo` (the normal,
  # expected case — these are both usually unset) leaves the *group*
  # exit status at 1 even though nothing actually went wrong, which
  # pipefail then reports as the whole pipeline having failed, aborting
  # the script right after `tee` — silently, no error text, since it's
  # not a "real" failure. Confirmed by reproducing this exact hang.
  [[ -n "${OPENSEARCH_URL:-}" ]] && echo "OPENSEARCH_URL=${OPENSEARCH_URL}" || true
  [[ -n "${NATS_URL:-}" ]] && echo "NATS_URL=${NATS_URL}" || true
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
# Unlimited restart attempts: after a VM crash/reboot, Postgres/OpenSearch
# inside Docker can take well over systemd's default 10s/5-try budget to
# become reachable (OpenSearch's JVM start alone can take 15-30s+) —
# without this, the default budget would exhaust and leave the unit
# permanently "failed" instead of recovering once dependencies are up.
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-/etc/selinux-fleet-manager/master.env
ExecStart=${INSTALL_DIR}/master/bin/master
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

# The service (running as SERVICE_USER, never root) only needs read
# access to its TLS private key (gen-certs.sh leaves it 600 root-only) —
# everything else it touches (binary, frontend/dist, master.crt/ca.crt)
# already has the default world-readable permissions root's own build
# steps left it with. Grant that one file group-read rather than chowning
# the whole tree to SERVICE_USER: that used to make this script unable to
# even detect/update its own checkout on a later re-run by a different
# (non-root, sudo-using) operator, since plain [[ -d/-f ]] checks run as
# the invoking user, not root.
$SUDO chgrp "${SERVICE_USER}" "${INSTALL_DIR}/deploy/certs/master.key"
$SUDO chmod 640 "${INSTALL_DIR}/deploy/certs/master.key"
# Same reasoning, for the agent identity's private key: GET
# /api/enroll/agent.key (see internal/api.enroll) reads this file at
# request time to serve it to install-agent.sh, so the service user
# needs read access to it too — gen-certs.sh leaves it 600 root-only,
# same as master.key, and for the same reason (never world-readable).
$SUDO chgrp "${SERVICE_USER}" "${INSTALL_DIR}/deploy/certs/agent-dev.key"
$SUDO chmod 640 "${INSTALL_DIR}/deploy/certs/agent-dev.key"

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now selinux-fleet-master

# Open only what agents/browsers actually need to reach (gRPC + HTTP
# API/dashboard). Postgres/OpenSearch/NATS are bound to 127.0.0.1 in
# docker-compose.yml precisely so they're never candidates for this —
# defense in depth even if a firewall rule were ever added for them by hand.
open_firewall_ports() {
  local http_port="${HTTP_ADDR#:}" grpc_port="${GRPC_ADDR#:}"
  if command -v firewall-cmd >/dev/null 2>&1 && $SUDO systemctl is-active --quiet firewalld 2>/dev/null; then
    log "opening ${http_port}/tcp (dashboard/API) and ${grpc_port}/tcp (agent gRPC) in firewalld"
    $SUDO firewall-cmd --permanent --add-port="${http_port}/tcp" >/dev/null
    $SUDO firewall-cmd --permanent --add-port="${grpc_port}/tcp" >/dev/null
    $SUDO firewall-cmd --reload >/dev/null
  elif command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "^Status: active"; then
    log "opening ${http_port}/tcp (dashboard/API) and ${grpc_port}/tcp (agent gRPC) in ufw"
    $SUDO ufw allow "${http_port}/tcp" >/dev/null
    $SUDO ufw allow "${grpc_port}/tcp" >/dev/null
  else
    warn "no active firewalld/ufw detected — if traffic is filtered elsewhere (cloud security group, upstream firewall, ...), make sure ${http_port}/tcp (dashboard/API) and ${grpc_port}/tcp (agent gRPC) are reachable from wherever your browser/agents connect from. Nothing else needs to be: Postgres/OpenSearch/NATS are bound to 127.0.0.1 only."
  fi
}
open_firewall_ports

sleep 2
if $SUDO systemctl is-active --quiet selinux-fleet-master; then
  log "master is running."
else
  warn "master did not start cleanly — check: journalctl -u selinux-fleet-master -e"
fi

DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "$DETECTED_IP" ]]; then
  MASTER_ADDR_HINT="$DETECTED_IP"
  MASTER_ADDR_NOTE="${DETECTED_IP} is this host's detected primary IP; replace it if agents reach this master through a different address instead (a public DNS name, a NAT'd/floating IP, ...)."
else
  MASTER_ADDR_HINT="<master-address>"
  MASTER_ADDR_NOTE="could not auto-detect this host's IP; replace <master-address> with one agents can reach this host on."
fi

cat <<EOF

--------------------------------------------------------------------
Master installed in ${INSTALL_DIR}, running as service
'selinux-fleet-master' (user ${SERVICE_USER}).

  Dashboard    : http://${MASTER_ADDR_HINT}:${HTTP_ADDR#:}/ (same port as the API)
  Health check : curl http://localhost:${HTTP_ADDR#:}/api/health
  Logs         : journalctl -u selinux-fleet-master -f
  Config       : /etc/selinux-fleet-manager/master.env (then:
                 systemctl restart selinux-fleet-master)
  Secrets      : /etc/selinux-fleet-manager/secrets.env (mode 600,
                 root-only — Postgres/OpenSearch passwords, generated,
                 not printed here; 'sudo cat' it if you need one, e.g.
                 to run psql by hand)

To enroll an agent, run these 2 commands on the agent host (no manual
cert copying needed — install-agent.sh fetches them automatically from
this master using the enrollment token below):

  curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-agent.sh
  MASTER_ADDR=https://${MASTER_ADDR_HINT}:${GRPC_ADDR#:} ENROLL_TOKEN=${ENROLL_TOKEN} bash install-agent.sh

  (${MASTER_ADDR_NOTE})

Enrollment is gated by ENROLL_TOKEN alone (see /etc/selinux-fleet-manager/
secrets.env) — treat it like a password: anyone with it can obtain the
shared agent identity. Known simplification (see README.md): this token
grants the *same* identity to every agent, it does not issue one per agent.
--------------------------------------------------------------------
EOF

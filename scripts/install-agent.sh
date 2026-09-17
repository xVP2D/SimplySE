#!/usr/bin/env bash
# Console SELinux — agent installer.
#
# Usage (download then run — works on any systemd Linux distro):
#   curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-agent.sh
#   bash install-agent.sh
#
# Run from a real terminal, it asks for the master's address and a couple
# of other choices (agent id, AVC source, where the certs are). Every
# question is skipped if you already set the matching environment
# variable, and skipped (defaults used, or a hard error for anything with
# no safe default like MASTER_ADDR) when stdin isn't a terminal — e.g. a
# piped `curl ... | bash`. So this also still works non-interactively:
#   MASTER_ADDR=https://master.example.com:8443 bash install-agent.sh
#
# Before running this, copy the 3 cert files the master installer
# generated into /etc/selinux-fleet-manager/certs/ on this host (the
# master installer prints the exact scp commands at the end of its run).
# This script tightens their permissions (private key: owner-only) itself,
# in case the transfer loosened them.
#
# Other overridable environment variables:
#   REPO_URL       git remote to clone (default: this project's GitHub URL)
#   INSTALL_DIR    where to clone/build the repo (default: /opt/selinux-fleet-manager)
#
# Known limitations (see README.md):
#   - the agent runs as root: setenforce/setsebool/semodule/chcon each need
#     root or a broad set of capabilities in practice, so this doesn't try
#     to carve out a partial-privilege service user;
#   - the 3 certs above are a single shared dev-style identity for every
#     agent, not per-agent enrollment;
#   - assumes systemd (see install-master.sh's header for the same note).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/xVP2D/SimplySE.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/selinux-fleet-manager}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

INTERACTIVE=0
[[ -t 0 && -t 1 ]] && INTERACTIVE=1

# prompt VAR "question" "default" — skipped (default used) if VAR is
# already set in the environment, or if not running interactively. An
# empty default means the question has no safe default: the caller must
# check the result and fail loudly if it's still empty (see MASTER_ADDR
# below) rather than silently proceeding with nothing.
prompt() {
  local var_name="$1" question="$2" default_value="${3:-}"
  if [[ -n "${!var_name:-}" ]]; then return; fi
  if [[ "$INTERACTIVE" -ne 1 ]]; then
    printf -v "$var_name" '%s' "$default_value"
    return
  fi
  local input suffix
  suffix="${default_value:+ [$default_value]}"
  read -r -p "${question}${suffix}: " input
  printf -v "$var_name" '%s' "${input:-$default_value}"
}

prompt MASTER_ADDR "Master address (e.g. https://master.example.com:8443)"
: "${MASTER_ADDR:?MASTER_ADDR is required — set it as an environment variable when running non-interactively, e.g. MASTER_ADDR=https://master.example.com:8443 bash install-agent.sh}"
prompt AGENT_ID "Agent id" "$(hostname)"
prompt AUDIT_SOURCE "AVC source: file (tail audit.log) | netlink (needs CAP_AUDIT_READ) | auto" "auto"
prompt CERT_DIR "Directory containing ca.crt / agent-dev.crt / agent-dev.key" "/etc/selinux-fleet-manager/certs"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  die "this installs system packages and a systemd service, so it needs root; re-run as root or install sudo."
fi

if ! command -v systemctl >/dev/null 2>&1; then
  die "systemd (systemctl) not found. This installer targets systemd distros (Debian/Ubuntu, RHEL/Fedora/CentOS, SUSE, Arch)."
fi

if ! command -v getenforce >/dev/null 2>&1 && [[ ! -e /etc/selinux/config ]]; then
  warn "no SELinux tooling detected on this host (no getenforce, no /etc/selinux/config)."
  warn "the agent will still install, but setenforce/setsebool/semodule/chcon will simply fail here."
fi

for f in ca.crt agent-dev.crt agent-dev.key; do
  if [[ ! -f "${CERT_DIR}/${f}" ]]; then
    die "missing ${CERT_DIR}/${f} — copy the 3 cert files from the master host first (the master installer prints the exact scp command), then re-run."
  fi
done
# Tighten permissions ourselves in case the transfer (scp, a shared
# folder, ...) left the private key group/world-readable.
$SUDO chmod 600 "${CERT_DIR}/agent-dev.key"
$SUDO chmod 644 "${CERT_DIR}/ca.crt" "${CERT_DIR}/agent-dev.crt"

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
# gcc (a C compiler) is needed to build the `ring` crate (TLS crypto) that
# tonic/rustls pull in transitively.
case "$PKG_MANAGER" in
  apt) install_packages apt git curl ca-certificates gcc pkg-config ;;
  dnf) install_packages dnf git curl ca-certificates gcc pkgconf-pkg-config ;;
  yum) install_packages yum git curl ca-certificates gcc pkgconfig ;;
  zypper) install_packages zypper git curl ca-certificates gcc pkg-config ;;
  pacman) install_packages pacman git curl ca-certificates base-devel ;;
  apk) install_packages apk git curl ca-certificates build-base ;;
  *) warn "make sure git, curl, and a C compiler (gcc) are installed manually" ;;
esac

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    log "rust already installed: $(cargo --version)"
    return
  fi
  log "installing Rust via rustup"
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
}
ensure_rust
# shellcheck disable=SC1090
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "updating existing checkout in ${INSTALL_DIR}"
  git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
  $SUDO git -C "$INSTALL_DIR" pull --ff-only
else
  log "cloning ${REPO_URL} into ${INSTALL_DIR}"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  $SUDO git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
$SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"

log "building agent in release mode (this can take a few minutes the first time)"
(cd "$INSTALL_DIR/agent" && cargo build --release)

$SUDO mkdir -p /var/lib/selinux-fleet-manager /etc/selinux-fleet-manager
$SUDO tee /etc/selinux-fleet-manager/agent.env >/dev/null <<EOF
MASTER_ADDR=${MASTER_ADDR}
AGENT_ID=${AGENT_ID}
AUDIT_SOURCE=${AUDIT_SOURCE}
AUDIT_LOG_PATH=/var/log/audit/audit.log
BUFFER_PATH=/var/lib/selinux-fleet-manager/buffer.jsonl
TLS_CA_FILE=${CERT_DIR}/ca.crt
TLS_CERT_FILE=${CERT_DIR}/agent-dev.crt
TLS_KEY_FILE=${CERT_DIR}/agent-dev.key
TLS_DOMAIN=master
EOF
$SUDO chmod 600 /etc/selinux-fleet-manager/agent.env
$SUDO chown root:root /etc/selinux-fleet-manager/agent.env

log "installing systemd service"
$SUDO tee /etc/systemd/system/selinux-fleet-agent.service >/dev/null <<EOF
[Unit]
Description=Console SELinux -- agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Root, deliberately: setenforce/setsebool/semodule/chcon each need root
# (or a broad capability set in practice) to actually take effect — see
# this script's header comment.
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=/etc/selinux-fleet-manager/agent.env
ExecStart=${INSTALL_DIR}/agent/target/release/selinux-agent
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now selinux-fleet-agent

sleep 2
if $SUDO systemctl is-active --quiet selinux-fleet-agent; then
  log "agent is running."
else
  warn "agent did not start cleanly — check: journalctl -u selinux-fleet-agent -e"
fi

cat <<EOF

--------------------------------------------------------------------
Agent '${AGENT_ID}' installed in ${INSTALL_DIR}, running as service
'selinux-fleet-agent' (root).

  Logs   : journalctl -u selinux-fleet-agent -f
  Config : /etc/selinux-fleet-manager/agent.env (then:
           systemctl restart selinux-fleet-agent)

It should appear in the master's dashboard (Agents page) within a few
seconds of the first heartbeat.
--------------------------------------------------------------------
EOF

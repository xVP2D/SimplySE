#!/usr/bin/env bash
# Console SELinux — agent installer.
#
# Usage (download then run — works on any systemd Linux distro): run the
# command install-master.sh prints at the end of a successful master
# install (it fills in MASTER_ADDR and ENROLL_TOKEN for you):
#   curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-agent.sh
#   MASTER_ADDR=https://master.example.com:8443 ENROLL_TOKEN=<token> bash install-agent.sh
#
# Certs are fetched automatically from the master's enrollment endpoint
# (GET /api/enroll/*, gated by ENROLL_TOKEN) — no manual scp needed. If
# ca.crt/agent-dev.crt/agent-dev.key already exist in CERT_DIR (e.g. you
# copied them yourself, or are re-running this script), those are reused
# instead and ENROLL_TOKEN isn't needed.
#
# Run from a real terminal, it also asks a couple of other questions
# (agent id, AVC source). Every question is skipped if you already set the
# matching environment variable, and skipped (defaults used, or a hard
# error for anything with no safe default like MASTER_ADDR) when stdin
# isn't a terminal — e.g. a piped `curl ... | bash`.
#
# Other overridable environment variables:
#   REPO_URL         git remote to clone (default: this project's GitHub URL)
#   INSTALL_DIR      where to clone/build the repo (default: /opt/selinux-fleet-manager)
#   CERT_DIR         where certs are stored (default: /etc/selinux-fleet-manager/certs)
#   ENROLL_URL       enrollment base URL (default: derived from MASTER_ADDR's
#                    host, port 8080 — override if that doesn't hold, e.g. a
#                    reverse proxy fronting the master's HTTP API elsewhere)
#   ENROLL_HTTP_PORT port to derive ENROLL_URL with, if not overriding it directly (default: 8080)
#
# Known limitations (see README.md):
#   - the agent runs as root: setenforce/setsebool/semodule/chcon each need
#     root or a broad set of capabilities in practice, so this doesn't try
#     to carve out a partial-privilege service user;
#   - the enrollment token grants the *same* shared identity to every
#     agent, it is not per-agent issuance;
#   - the enrollment fetch itself is plain HTTP by default (matching the
#     master's dashboard API) — fine over a trusted/private network; put a
#     TLS-terminating reverse proxy in front and set ENROLL_URL=https://...
#     if the network between agent and master isn't trusted;
#   - assumes systemd (see install-master.sh's header for the same note).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/xVP2D/SimplySE.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/selinux-fleet-manager}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

INTERACTIVE=0
# stdin alone: read -p writes its prompt to stderr, not stdout, so
# redirecting/logging stdout must not turn off prompting as long as stdin
# is still a real terminal.
[[ -t 0 ]] && INTERACTIVE=1

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

have_certs() {
  [[ -f "${CERT_DIR}/ca.crt" && -f "${CERT_DIR}/agent-dev.crt" && -f "${CERT_DIR}/agent-dev.key" ]]
}

if have_certs; then
  log "using existing certs already in ${CERT_DIR}"
else
  prompt ENROLL_TOKEN "Enrollment token (printed at the end of install-master.sh on the master)"
  : "${ENROLL_TOKEN:?ENROLL_TOKEN is required to fetch certs automatically (or place ca.crt/agent-dev.crt/agent-dev.key in ${CERT_DIR} yourself first and re-run) — set it as an environment variable when running non-interactively.}"

  # Same host as MASTER_ADDR (the gRPC/mTLS port), different port: the
  # master's plain HTTP dashboard API, where GET /api/enroll/* lives.
  # Override ENROLL_URL directly if that assumption doesn't hold (e.g. a
  # reverse proxy terminating TLS on a different host/port).
  MASTER_HOST="$(printf '%s' "$MASTER_ADDR" | sed -E 's#^[a-zA-Z]+://([^:/]+).*#\1#')"
  ENROLL_URL="${ENROLL_URL:-http://${MASTER_HOST}:${ENROLL_HTTP_PORT:-8080}/api/enroll}"

  log "fetching agent certs from ${ENROLL_URL}/{ca.crt,agent.crt,agent.key}"
  $SUDO mkdir -p "$CERT_DIR"
  TMP_CERT_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_CERT_DIR"' EXIT

  fetch_cert_file() {
    local remote_name="$1" local_name="$2"
    curl -fsSL -H "Authorization: Bearer ${ENROLL_TOKEN}" \
      "${ENROLL_URL}/${remote_name}" -o "${TMP_CERT_DIR}/${local_name}" \
      || die "failed to fetch ${remote_name} from ${ENROLL_URL} — check MASTER_ADDR/ENROLL_TOKEN, and that the master's HTTP API (default port 8080) is reachable from here."
  }
  fetch_cert_file "ca.crt" "ca.crt"
  fetch_cert_file "agent.crt" "agent-dev.crt"
  fetch_cert_file "agent.key" "agent-dev.key"

  $SUDO cp "$TMP_CERT_DIR"/* "$CERT_DIR"/
  rm -rf "$TMP_CERT_DIR"
  trap - EXIT
  log "certs written to ${CERT_DIR}"
fi
# Tighten permissions ourselves regardless of how the certs got here
# (fetched just now, or pre-staged by hand — e.g. an scp that left the
# private key group/world-readable).
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

if $SUDO test -d "$INSTALL_DIR/.git"; then
  # $SUDO, not a bare [[ -d ]]: e.g. a previous run under a different user
  # (or one that installed as root) may have left INSTALL_DIR unreadable
  # to the current invoking user, which would make a plain check wrongly
  # report "doesn't exist" and attempt a fresh clone into a non-empty dir.
  log "updating existing checkout in ${INSTALL_DIR}"
  # $SUDO here too: the actual `pull` below runs as root via $SUDO, so
  # it's root's global gitconfig that needs safe.directory, not the
  # invoking user's — otherwise git may refuse with "dubious ownership".
  $SUDO git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
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
# Unlimited restart attempts: keep trying to reach the master indefinitely
# after a crash/reboot rather than giving up once systemd's default
# retry budget (5 tries / 10s) is exhausted.
StartLimitIntervalSec=0

[Service]
Type=simple
# Root, deliberately: setenforce/setsebool/semodule/chcon each need root
# (or a broad capability set in practice) to actually take effect — see
# this script's header comment.
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=/etc/selinux-fleet-manager/agent.env
ExecStart=${INSTALL_DIR}/agent/target/release/selinux-agent
Restart=always
RestartSec=5

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

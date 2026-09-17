#!/usr/bin/env bash
# Generates a dev-only CA plus a server cert (master) and a shared client
# cert (agent-dev) for mutual TLS between agents and the master.
#
# NOT for production: single shared agent cert, long validity, no revocation.
# A per-agent enrollment/issuance flow is a follow-up (see plan notes).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT_DIR="certs"
DAYS=3650

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

if [[ -f ca.key ]]; then
  echo "certs already exist in deploy/certs — remove the directory first to regenerate." >&2
  exit 1
fi

echo "==> generating dev CA"
openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS" \
  -subj "/O=Console SELinux Dev/CN=console-selinux-dev-ca" \
  -out ca.crt

gen_leaf() {
  local name="$1" cn="$2" sans="$3"
  echo "==> generating ${name} cert (CN=${cn})"
  openssl genrsa -out "${name}.key" 2048 2>/dev/null
  openssl req -new -key "${name}.key" -subj "/O=Console SELinux Dev/CN=${cn}" -out "${name}.csr"
  openssl x509 -req -in "${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS" -sha256 -extfile <(printf "subjectAltName=%s" "$sans") \
    -out "${name}.crt" 2>/dev/null
  rm -f "${name}.csr"
}

gen_leaf "master" "master" "DNS:master,DNS:localhost,IP:127.0.0.1"
gen_leaf "agent-dev" "agent-dev" "DNS:agent-dev"

rm -f ca.srl

# Private keys are secrets: owner-only, regardless of the umask the caller
# happened to have. ca.key in particular can mint new agent identities —
# never copy it to an agent host (only ca.crt, agent-dev.crt and
# agent-dev.key are needed there).
chmod 600 ./*.key
chmod 644 ./*.crt

echo "==> done. Files in deploy/certs/: ca.crt, master.{crt,key}, agent-dev.{crt,key}"
echo "==> ca.key is the CA private key — keep it on the master host only."

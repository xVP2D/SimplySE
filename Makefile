.PHONY: certs infra-up infra-down proto master-build master-run agent-build agent-run frontend-install frontend-dev

# Generates the dev CA + mTLS certs into deploy/certs/ (run once).
certs:
	bash deploy/scripts/gen-certs.sh

# Starts NATS JetStream, Postgres and OpenSearch for local dev.
infra-up:
	docker compose -f deploy/docker-compose.yml up -d

infra-down:
	docker compose -f deploy/docker-compose.yml down

# Regenerates Go gRPC code from proto/selinux/v1/agent.proto.
# Requires: protoc, protoc-gen-go, protoc-gen-go-grpc (go install ...@latest).
proto:
	protoc \
		--go_out=master --go_opt=module=console-selinux/master \
		--go-grpc_out=master --go-grpc_opt=module=console-selinux/master \
		proto/selinux/v1/agent.proto

master-build:
	cd master && go build -o bin/master ./cmd/master

# Run from the repo root: default cert/config paths are relative to it.
master-run: master-build
	./master/bin/master

agent-build:
	cd agent && cargo build

# Run from the repo root, same reason as master-run. Override AUDIT_LOG_PATH
# for a non-root dev run (e.g. AUDIT_LOG_PATH=/tmp/audit.log).
agent-run: agent-build
	./agent/target/debug/selinux-agent

frontend-install:
	cd frontend && npm install

frontend-dev:
	cd frontend && npm run dev

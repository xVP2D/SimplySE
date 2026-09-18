-- Minimal bootstrap schema, executed idempotently at startup.
-- Follow-up: replace with golang-migrate once the schema needs versioned
-- migrations across environments.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    hostname        TEXT NOT NULL,
    ip              TEXT NOT NULL DEFAULT '',
    os_release      TEXT NOT NULL DEFAULT '',
    kernel_version  TEXT NOT NULL DEFAULT '',
    agent_version   TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL DEFAULT 'unknown',
    policy_name     TEXT NOT NULL DEFAULT '',
    policy_version  TEXT NOT NULL DEFAULT '',
    group_name      TEXT NOT NULL DEFAULT 'default',
    status          TEXT NOT NULL DEFAULT 'offline',
    enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,
    payload_json  JSONB NOT NULL,
    created_by    TEXT NOT NULL DEFAULT 'operator',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commands (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    rule_id         UUID REFERENCES rules(id),
    type            TEXT NOT NULL,
    payload_json    JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    result_message  TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acked_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_commands_agent_id ON commands (agent_id);
CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands (created_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type              TEXT NOT NULL,
    title             TEXT NOT NULL,
    message           TEXT NOT NULL,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    scontext          TEXT NOT NULL DEFAULT '',
    tcontext          TEXT NOT NULL DEFAULT '',
    tclass            TEXT NOT NULL DEFAULT '',
    -- low | medium | high — see rules.severityFor. Defaults to medium: an
    -- ordinary denial worth a look but not touching a known critical
    -- service type, and mode_permissive alerts (not run through
    -- severityFor at all) always set 'high' explicitly.
    severity          TEXT NOT NULL DEFAULT 'medium',
    status            TEXT NOT NULL DEFAULT 'open',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at   TIMESTAMPTZ,
    acknowledged_by   TEXT NOT NULL DEFAULT ''
);
-- Bootstrap runs `CREATE TABLE IF NOT EXISTS` only, so a column added after
-- the table already exists on a live install needs its own migration line.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium';

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);

-- Backs Idempotency-Key support on command-creating endpoints (currently
-- POST /api/rules/deploy). A row is claimed with status='in_progress'
-- before the side-effecting work runs, then flipped to 'completed' with
-- the response to replay on retry. No expiry/cleanup job yet: follow-up
-- once key volume matters (idx_..._created_at is there for that).
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             TEXT PRIMARY KEY,
    request_hash    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'in_progress',
    response_status INT,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);

-- Latest SELinux inventory snapshot per agent (booleans + loaded policy
-- modules). Overwritten in place on every SelinuxInventory message — this
-- is current state, not a time series, so there's no history to keep.
CREATE TABLE IF NOT EXISTS agent_selinux_state (
    agent_id      TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    booleans_json JSONB NOT NULL DEFAULT '[]',
    modules_json  JSONB NOT NULL DEFAULT '[]',
    collected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- audit2allow-assisted policy suggestions: generated automatically on a
-- new_signature alert (see main.go), *never* applied automatically — a
-- human must explicitly approve one (POST /api/suggested-modules/{id}/approve)
-- before its pp_base64 is ever pushed to an agent, and that push itself
-- reuses the ordinary install_module command/deploy flow, not a shortcut.
CREATE TABLE IF NOT EXISTS suggested_modules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command_id      UUID NOT NULL REFERENCES commands(id),
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    module_name     TEXT NOT NULL,
    scontext        TEXT NOT NULL DEFAULT '',
    tcontext        TEXT NOT NULL DEFAULT '',
    tclass          TEXT NOT NULL DEFAULT '',
    te_text         TEXT NOT NULL DEFAULT '',
    pp_base64       TEXT NOT NULL DEFAULT '',
    -- generating (dispatched, awaiting the agent's audit2allow run) ->
    -- pending (generated, awaiting review) | failed (audit2allow errored)
    -- -> approved | rejected (human decision, terminal).
    status          TEXT NOT NULL DEFAULT 'generating',
    error_message   TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_suggested_modules_command_id ON suggested_modules (command_id);
CREATE INDEX IF NOT EXISTS idx_suggested_modules_created_at ON suggested_modules (created_at DESC);

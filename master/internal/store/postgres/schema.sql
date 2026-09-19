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

-- How to undo this command on the machine, recorded when it was dispatched
-- (JSON {"type","payload","action"}; NULL = not revertible or unknown — see
-- internal/server/revert.go). reverts_command_id marks a command that is
-- itself the undo of another: when it is acked successfully, both rows are
-- removed. ON DELETE SET NULL so removing an original never trips the FK.
ALTER TABLE commands ADD COLUMN IF NOT EXISTS undo_json JSONB;
ALTER TABLE commands ADD COLUMN IF NOT EXISTS reverts_command_id UUID REFERENCES commands(id) ON DELETE SET NULL;
-- At most one undo in flight per command (double-click / two operators).
CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_one_inflight_revert
    ON commands (reverts_command_id)
    WHERE reverts_command_id IS NOT NULL AND status IN ('pending', 'sent');

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
    agent_id         TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    booleans_json    JSONB NOT NULL DEFAULT '[]',
    modules_json     JSONB NOT NULL DEFAULT '[]',
    -- sha256 hex per tracked path (see agent's selinux_info::TRACKED_FILES)
    -- from the *previous* snapshot — compared against each new one to
    -- raise a config_drift alert (see server.go) on an untracked change.
    file_hashes_json JSONB NOT NULL DEFAULT '{}',
    collected_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_selinux_state ADD COLUMN IF NOT EXISTS file_hashes_json JSONB NOT NULL DEFAULT '{}';
-- Confined domains with a process running under them at the last inventory
-- (see agent's selinux_info::collect_active_domains) — what a "scan every
-- rule on this machine" run can offer to make permissive one at a time.
ALTER TABLE agent_selinux_state ADD COLUMN IF NOT EXISTS domains_json JSONB NOT NULL DEFAULT '[]';

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

-- SIEM/EDR/monitoring connector settings (see internal/correlate and
-- internal/api/integrations.go), configured from the dashboard's
-- Settings page instead of master.env — one fixed row per known
-- connector ('siem_opensearch', 'librenms'). config_json holds that
-- connector's correlate.*Config struct verbatim (its own json tags
-- double as the storage format), including the secret field (password/
-- token) in plaintext — same trade-off already made for
-- /etc/selinux-fleet-manager/secrets.env (root-only file permissions,
-- no separate encryption layer); the API layer never echoes the secret
-- back out in a GET response.
CREATE TABLE IF NOT EXISTS integration_settings (
    key         TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    config_json JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Collect every denial of a domain" runs (see internal/server/collect.go):
-- the domain is made permissive on one agent for a bounded time so
-- everything it hits gets logged instead of one denial at a time. One
-- active run per (agent, domain); finished rows stay as an audit trail of
-- when a domain was loosened, by whom and for how long.
CREATE TABLE IF NOT EXISTS domain_collections (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain            TEXT NOT NULL,
    -- starting -> collecting -> stopping -> collected -> done | failed.
    -- "collected": the window is closed and lines_count denials were
    -- logged, but turning them into a suggestion is a separate, explicit
    -- operator action (POST .../generate) — never automatic, same as
    -- every other suggestion in this tool.
    status            TEXT NOT NULL DEFAULT 'starting',
    duration_secs     INT NOT NULL,
    created_by        TEXT NOT NULL DEFAULT 'operator',
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    collecting_since  TIMESTAMPTZ,
    ends_at           TIMESTAMPTZ,
    -- Fixed the moment the window actually closes, so a suggestion
    -- generated later (possibly much later) still reads exactly what was
    -- logged during the run, not whatever else has happened since.
    finished_at       TIMESTAMPTZ,
    start_command_id  UUID,
    stop_command_id   UUID,
    stop_sent_at      TIMESTAMPTZ,
    suggestion_id     UUID,
    lines_count       INT NOT NULL DEFAULT 0,
    message           TEXT NOT NULL DEFAULT ''
);
ALTER TABLE domain_collections ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
-- Non-null groups every domain started together by one "scan every rule on
-- this machine" run (see server.Collector.StartScan), so the dashboard can
-- show and stop/generate them as one unit; null for an ordinary single-domain
-- collection.
ALTER TABLE domain_collections ADD COLUMN IF NOT EXISTS scan_id UUID;
CREATE INDEX IF NOT EXISTS idx_domain_collections_scan_id ON domain_collections (scan_id) WHERE scan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_collections_one_active
    ON domain_collections (agent_id, domain)
    WHERE status IN ('starting', 'collecting', 'stopping');
CREATE INDEX IF NOT EXISTS idx_domain_collections_started_at ON domain_collections (started_at DESC);

-- The dashboard's customizable widget grid (see internal/api/dashboard.go).
-- One shared layout for the whole install, not per-operator — whoever
-- edits it last wins, same trade-off as every other setting in this tool.
-- Singleton row enforced by the boolean PK + CHECK: an INSERT of a second
-- row would violate the PK, so upserts always target id = true.
CREATE TABLE IF NOT EXISTS dashboard_layout (
    id           BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    widgets_json JSONB NOT NULL DEFAULT '[]',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Permanent history (feeds the dashboard's charts) ─────────────────────
-- Everything below is append-only from the application's point of view:
-- nothing ever decrements or deletes these rows, so a chart keeps its data
-- after a denial is resolved by a rule, quarantined or deleted, after a
-- deployment or an alert is removed from its list, or after an agent is
-- gone (which is why none of them references agents(id)). Only PurgeHistory
-- (retention, HISTORY_RETENTION_DAYS) removes old rows.
CREATE TABLE IF NOT EXISTS history_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Denials, counted at ingestion (see internal/history): one row per UTC
-- hour, agent and signature, incremented as events arrive. perms is the
-- sorted, comma-joined permission set.
CREATE TABLE IF NOT EXISTS history_denials_hourly (
    bucket   TIMESTAMPTZ NOT NULL,
    agent_id TEXT NOT NULL,
    scontext TEXT NOT NULL,
    tcontext TEXT NOT NULL,
    tclass   TEXT NOT NULL,
    perms    TEXT NOT NULL,
    count    BIGINT NOT NULL,
    PRIMARY KEY (bucket, agent_id, scontext, tcontext, tclass, perms)
);
CREATE INDEX IF NOT EXISTS idx_history_denials_agent ON history_denials_hourly (agent_id, bucket);

-- When each denial signature was first counted: what "new signatures per
-- day" reads. Kept apart from the hourly table so the question does not need
-- a scan of every hourly row. first_seen only ever moves earlier.
CREATE TABLE IF NOT EXISTS history_signatures (
    scontext   TEXT NOT NULL,
    tcontext   TEXT NOT NULL,
    tclass     TEXT NOT NULL,
    perms      TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scontext, tcontext, tclass, perms)
);
CREATE INDEX IF NOT EXISTS idx_history_signatures_first_seen ON history_signatures (first_seen);

-- Rule deployments. Filled by a trigger on commands, so it captures every
-- code path that creates or updates a command; there is deliberately no
-- DELETE trigger.
CREATE TABLE IF NOT EXISTS history_commands (
    id         UUID PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL,
    is_revert  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL,
    acked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_history_commands_created ON history_commands (created_at);
-- The agent's answer, kept (truncated) so the most frequent failures stay
-- countable after the command itself is gone.
ALTER TABLE history_commands ADD COLUMN IF NOT EXISTS result_message TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION history_track_command() RETURNS trigger AS $$
BEGIN
    INSERT INTO history_commands (id, agent_id, type, status, is_revert, created_at, acked_at, result_message)
    VALUES (NEW.id, NEW.agent_id, NEW.type, NEW.status, NEW.reverts_command_id IS NOT NULL, NEW.created_at, NEW.acked_at, LEFT(NEW.result_message, 500))
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, acked_at = EXCLUDED.acked_at, result_message = EXCLUDED.result_message;
    RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER history_commands_track
    AFTER INSERT OR UPDATE ON commands
    FOR EACH ROW EXECUTE FUNCTION history_track_command();
INSERT INTO history_commands (id, agent_id, type, status, is_revert, created_at, acked_at)
    SELECT id, agent_id, type, status, reverts_command_id IS NOT NULL, created_at, acked_at FROM commands
    ON CONFLICT (id) DO NOTHING;
UPDATE history_commands h SET result_message = LEFT(c.result_message, 500)
    FROM commands c WHERE c.id = h.id AND h.result_message = '' AND c.result_message <> '';

-- Alerts, same mechanism as deployments.
CREATE TABLE IF NOT EXISTS history_alerts (
    id              UUID PRIMARY KEY,
    type            TEXT NOT NULL,
    severity        TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    status          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_history_alerts_created ON history_alerts (created_at);
ALTER TABLE history_alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION history_track_alert() RETURNS trigger AS $$
BEGIN
    INSERT INTO history_alerts (id, type, severity, agent_id, status, created_at, acknowledged_at, acknowledged_by)
    VALUES (NEW.id, NEW.type, NEW.severity, NEW.agent_id, NEW.status, NEW.created_at, NEW.acknowledged_at, NEW.acknowledged_by)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, acknowledged_at = EXCLUDED.acknowledged_at, acknowledged_by = EXCLUDED.acknowledged_by;
    RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER history_alerts_track
    AFTER INSERT OR UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION history_track_alert();
INSERT INTO history_alerts (id, type, severity, agent_id, status, created_at, acknowledged_at)
    SELECT id, type, severity, agent_id, status, created_at, acknowledged_at FROM alerts
    ON CONFLICT (id) DO NOTHING;
UPDATE history_alerts h SET acknowledged_by = a.acknowledged_by
    FROM alerts a WHERE a.id = h.id AND h.acknowledged_by = '' AND a.acknowledged_by <> '';

-- Fleet state, sampled on a timer (see history.Sampler): one row per agent
-- and sample time, with the compliance score computed the same way the
-- dashboard's Compliance page does.
CREATE TABLE IF NOT EXISTS history_fleet_samples (
    ts          TIMESTAMPTZ NOT NULL,
    agent_id    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    policy      TEXT NOT NULL,
    connected   BOOLEAN NOT NULL,
    score       INT NOT NULL,
    open_alerts INT NOT NULL,
    PRIMARY KEY (ts, agent_id)
);

// Package postgres holds the business-data store: agents, rules and
// commands. AVC events themselves live in OpenSearch (see
// internal/store/opensearch) since they are high-volume log data.
package postgres

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed schema.sql
var schemaSQL string

type Store struct {
	db *sql.DB
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	s := &Store{db: db}
	if err := s.bootstrap(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) bootstrap(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("bootstrap schema: %w", err)
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

type Agent struct {
	ID            string     `json:"id"`
	Hostname      string     `json:"hostname"`
	IP            string     `json:"ip"`
	OSRelease     string     `json:"os_release"`
	KernelVersion string     `json:"kernel_version"`
	AgentVersion  string     `json:"agent_version"`
	Mode          string     `json:"mode"`
	PolicyName    string     `json:"policy_name"`
	PolicyVersion string     `json:"policy_version"`
	Group         string     `json:"group"`
	Status        string     `json:"status"`
	EnrolledAt    time.Time  `json:"enrolled_at"`
	LastSeenAt    *time.Time `json:"last_seen_at,omitempty"`
}

// UpsertAgentEnroll registers (or re-registers) an agent when it opens its
// connection to the master and marks it online.
func (s *Store) UpsertAgentEnroll(ctx context.Context, a Agent) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO agents (id, hostname, ip, os_release, kernel_version, agent_version, status, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'online', now())
		ON CONFLICT (id) DO UPDATE SET
			hostname = EXCLUDED.hostname,
			ip = EXCLUDED.ip,
			os_release = EXCLUDED.os_release,
			kernel_version = EXCLUDED.kernel_version,
			agent_version = EXCLUDED.agent_version,
			status = 'online',
			last_seen_at = now()
	`, a.ID, a.Hostname, a.IP, a.OSRelease, a.KernelVersion, a.AgentVersion)
	if err != nil {
		return fmt.Errorf("upsert agent enroll: %w", err)
	}
	return nil
}

func (s *Store) UpdateHeartbeat(ctx context.Context, agentID, mode, policyName, policyVersion string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE agents SET mode = $2, policy_name = $3, policy_version = $4,
			status = 'online', last_seen_at = now()
		WHERE id = $1
	`, agentID, mode, policyName, policyVersion)
	if err != nil {
		return fmt.Errorf("update heartbeat: %w", err)
	}
	return nil
}

func (s *Store) MarkOffline(ctx context.Context, agentID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agents SET status = 'offline' WHERE id = $1`, agentID)
	if err != nil {
		return fmt.Errorf("mark offline: %w", err)
	}
	return nil
}

func (s *Store) ListAgents(ctx context.Context) ([]Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, hostname, ip, os_release, kernel_version, agent_version,
			mode, policy_name, policy_version, group_name, status, enrolled_at, last_seen_at
		FROM agents ORDER BY hostname
	`)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()

	out := []Agent{} // never nil: encodes to `[]`, not `null`, when empty
	for rows.Next() {
		var a Agent
		if err := rows.Scan(&a.ID, &a.Hostname, &a.IP, &a.OSRelease, &a.KernelVersion,
			&a.AgentVersion, &a.Mode, &a.PolicyName, &a.PolicyVersion, &a.Group,
			&a.Status, &a.EnrolledAt, &a.LastSeenAt); err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetAgent(ctx context.Context, id string) (Agent, error) {
	var a Agent
	err := s.db.QueryRowContext(ctx, `
		SELECT id, hostname, ip, os_release, kernel_version, agent_version,
			mode, policy_name, policy_version, group_name, status, enrolled_at, last_seen_at
		FROM agents WHERE id = $1
	`, id).Scan(&a.ID, &a.Hostname, &a.IP, &a.OSRelease, &a.KernelVersion,
		&a.AgentVersion, &a.Mode, &a.PolicyName, &a.PolicyVersion, &a.Group,
		&a.Status, &a.EnrolledAt, &a.LastSeenAt)
	if err != nil {
		return Agent{}, fmt.Errorf("get agent %s: %w", id, err)
	}
	return a, nil
}

type Rule struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Type        string    `json:"type"`
	PayloadJSON string    `json:"payload_json"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
}

func (s *Store) CreateRule(ctx context.Context, name, ruleType, payloadJSON, createdBy string) (Rule, error) {
	var r Rule
	r.Name, r.Type, r.PayloadJSON, r.CreatedBy = name, ruleType, payloadJSON, createdBy
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO rules (name, type, payload_json, created_by)
		VALUES ($1, $2, $3::jsonb, $4)
		RETURNING id, created_at
	`, name, ruleType, payloadJSON, createdBy).Scan(&r.ID, &r.CreatedAt)
	if err != nil {
		return Rule{}, fmt.Errorf("create rule: %w", err)
	}
	return r, nil
}

type Command struct {
	ID            string     `json:"id"`
	AgentID       string     `json:"agent_id"`
	RuleID        *string    `json:"rule_id,omitempty"`
	Type          string     `json:"type"`
	PayloadJSON   string     `json:"payload_json"`
	Status        string     `json:"status"`
	ResultMessage string     `json:"result_message"`
	CreatedAt     time.Time  `json:"created_at"`
	AckedAt       *time.Time `json:"acked_at,omitempty"`
}

func (s *Store) CreateCommand(ctx context.Context, agentID string, ruleID *string, cmdType, payloadJSON string) (Command, error) {
	var c Command
	c.AgentID, c.RuleID, c.Type, c.PayloadJSON = agentID, ruleID, cmdType, payloadJSON
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO commands (agent_id, rule_id, type, payload_json)
		VALUES ($1, $2, $3, $4::jsonb)
		RETURNING id, status, created_at
	`, agentID, ruleID, cmdType, payloadJSON).Scan(&c.ID, &c.Status, &c.CreatedAt)
	if err != nil {
		return Command{}, fmt.Errorf("create command: %w", err)
	}
	return c, nil
}

func (s *Store) MarkCommandSent(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE commands SET status = 'sent' WHERE id = $1 AND status = 'pending'`, id)
	if err != nil {
		return fmt.Errorf("mark command sent: %w", err)
	}
	return nil
}

func (s *Store) UpdateCommandAck(ctx context.Context, id string, success bool, message string) error {
	status := "acked"
	if !success {
		status = "failed"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE commands SET status = $2, result_message = $3, acked_at = now() WHERE id = $1
	`, id, status, message)
	if err != nil {
		return fmt.Errorf("update command ack: %w", err)
	}
	return nil
}

func (s *Store) GetCommand(ctx context.Context, id string) (Command, error) {
	var c Command
	err := s.db.QueryRowContext(ctx, `
		SELECT id, agent_id, rule_id, type, payload_json, status, result_message, created_at, acked_at
		FROM commands WHERE id = $1
	`, id).Scan(&c.ID, &c.AgentID, &c.RuleID, &c.Type, &c.PayloadJSON, &c.Status, &c.ResultMessage, &c.CreatedAt, &c.AckedAt)
	if err != nil {
		return Command{}, fmt.Errorf("get command %s: %w", id, err)
	}
	return c, nil
}

// ListCommandsOptions filters and paginates the deployments history.
// AgentID and Status are exact matches; either may be left empty.
type ListCommandsOptions struct {
	AgentID string
	Status  string
	Offset  int
	Limit   int
}

type ListCommandsResult struct {
	Commands []Command `json:"commands"`
	Total    int       `json:"total"`
}

func (s *Store) ListCommands(ctx context.Context, opts ListCommandsOptions) (ListCommandsResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, agent_id, rule_id, type, payload_json, status, result_message, created_at, acked_at,
			count(*) OVER() AS total
		FROM commands
		WHERE ($1 = '' OR agent_id = $1) AND ($2 = '' OR status = $2)
		ORDER BY created_at DESC
		LIMIT $3 OFFSET $4
	`, opts.AgentID, opts.Status, opts.Limit, opts.Offset)
	if err != nil {
		return ListCommandsResult{}, fmt.Errorf("list commands: %w", err)
	}
	defer rows.Close()

	result := ListCommandsResult{Commands: []Command{}} // never nil: encodes to `[]`, not `null`, when empty
	for rows.Next() {
		var c Command
		if err := rows.Scan(&c.ID, &c.AgentID, &c.RuleID, &c.Type, &c.PayloadJSON, &c.Status, &c.ResultMessage, &c.CreatedAt, &c.AckedAt, &result.Total); err != nil {
			return ListCommandsResult{}, fmt.Errorf("scan command: %w", err)
		}
		result.Commands = append(result.Commands, c)
	}
	return result, rows.Err()
}

type Alert struct {
	ID             string     `json:"id"`
	Type           string     `json:"type"`
	Title          string     `json:"title"`
	Message        string     `json:"message"`
	AgentID        string     `json:"agent_id"`
	SContext       string     `json:"scontext"`
	TContext       string     `json:"tcontext"`
	TClass         string     `json:"tclass"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"created_at"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
	AcknowledgedBy string     `json:"acknowledged_by"`
}

func (s *Store) CreateAlert(ctx context.Context, a Alert) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO alerts (type, title, message, agent_id, scontext, tcontext, tclass)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, a.Type, a.Title, a.Message, a.AgentID, a.SContext, a.TContext, a.TClass)
	if err != nil {
		return fmt.Errorf("create alert: %w", err)
	}
	return nil
}

// ListAlertsOptions filters and paginates the alert center. Status is an
// exact match ("open" or "acknowledged"); left empty, all alerts match.
type ListAlertsOptions struct {
	Status string
	Offset int
	Limit  int
}

type ListAlertsResult struct {
	Alerts []Alert `json:"alerts"`
	Total  int     `json:"total"`
}

func (s *Store) ListAlerts(ctx context.Context, opts ListAlertsOptions) (ListAlertsResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, type, title, message, agent_id, scontext, tcontext, tclass, status,
			created_at, acknowledged_at, acknowledged_by, count(*) OVER() AS total
		FROM alerts
		WHERE ($1 = '' OR status = $1)
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, opts.Status, opts.Limit, opts.Offset)
	if err != nil {
		return ListAlertsResult{}, fmt.Errorf("list alerts: %w", err)
	}
	defer rows.Close()

	result := ListAlertsResult{Alerts: []Alert{}} // never nil: encodes to `[]`, not `null`, when empty
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.ID, &a.Type, &a.Title, &a.Message, &a.AgentID, &a.SContext, &a.TContext, &a.TClass,
			&a.Status, &a.CreatedAt, &a.AcknowledgedAt, &a.AcknowledgedBy, &result.Total); err != nil {
			return ListAlertsResult{}, fmt.Errorf("scan alert: %w", err)
		}
		result.Alerts = append(result.Alerts, a)
	}
	return result, rows.Err()
}

func (s *Store) AcknowledgeAlert(ctx context.Context, id, by string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
		WHERE id = $1
	`, id, by)
	if err != nil {
		return fmt.Errorf("acknowledge alert: %w", err)
	}
	return nil
}

// IdempotencyRecord describes an existing idempotency key when the caller
// did not win the claim (see BeginIdempotentRequest).
type IdempotencyRecord struct {
	Key            string
	RequestHash    string
	Status         string // in_progress | completed
	ResponseStatus int
	ResponseBody   []byte
}

// BeginIdempotentRequest tries to atomically claim key for a new
// side-effecting request. If it succeeds, claimed is true and the caller
// must run its work then call CompleteIdempotentRequest. If another
// request already holds this key, claimed is false and record describes
// its current state: the caller must not repeat the side-effecting work —
// either replay record's stored response (status == "completed") or
// reject the request (status == "in_progress", meaning a concurrent
// attempt is still running, or crashed before completing).
func (s *Store) BeginIdempotentRequest(ctx context.Context, key, requestHash string) (record IdempotencyRecord, claimed bool, err error) {
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO idempotency_keys (key, request_hash)
		VALUES ($1, $2)
		ON CONFLICT (key) DO NOTHING
	`, key, requestHash)
	if err != nil {
		return IdempotencyRecord{}, false, fmt.Errorf("claim idempotency key: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return IdempotencyRecord{}, true, nil
	}

	var rec IdempotencyRecord
	var responseStatus sql.NullInt32
	err = s.db.QueryRowContext(ctx, `
		SELECT key, request_hash, status, response_status, response_body
		FROM idempotency_keys WHERE key = $1
	`, key).Scan(&rec.Key, &rec.RequestHash, &rec.Status, &responseStatus, &rec.ResponseBody)
	if err != nil {
		return IdempotencyRecord{}, false, fmt.Errorf("read idempotency key: %w", err)
	}
	rec.ResponseStatus = int(responseStatus.Int32)
	return rec, false, nil
}

func (s *Store) CompleteIdempotentRequest(ctx context.Context, key string, status int, body []byte) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE idempotency_keys SET status = 'completed', response_status = $2, response_body = $3
		WHERE key = $1
	`, key, status, body)
	if err != nil {
		return fmt.Errorf("complete idempotency key: %w", err)
	}
	return nil
}

type SelinuxBoolean struct {
	Name  string `json:"name"`
	Value bool   `json:"value"`
}

type SelinuxModule struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type SelinuxState struct {
	AgentID     string           `json:"agent_id"`
	Booleans    []SelinuxBoolean `json:"booleans"`
	Modules     []SelinuxModule  `json:"modules"`
	CollectedAt *time.Time       `json:"collected_at,omitempty"`
}

// UpsertSelinuxState overwrites the previous snapshot for agentID — see
// the SelinuxInventory proto comment for why this isn't append-only.
func (s *Store) UpsertSelinuxState(ctx context.Context, agentID string, booleans []SelinuxBoolean, modules []SelinuxModule, collectedAt time.Time) error {
	booleansJSON, err := json.Marshal(booleans)
	if err != nil {
		return fmt.Errorf("marshal booleans: %w", err)
	}
	modulesJSON, err := json.Marshal(modules)
	if err != nil {
		return fmt.Errorf("marshal modules: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO agent_selinux_state (agent_id, booleans_json, modules_json, collected_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (agent_id) DO UPDATE SET
			booleans_json = EXCLUDED.booleans_json,
			modules_json = EXCLUDED.modules_json,
			collected_at = EXCLUDED.collected_at
	`, agentID, booleansJSON, modulesJSON, collectedAt)
	if err != nil {
		return fmt.Errorf("upsert selinux state: %w", err)
	}
	return nil
}

// GetSelinuxState returns (state, false, nil) — not an error — when the
// agent hasn't sent an inventory snapshot yet (e.g. just enrolled, or
// running an older agent build that predates this feature).
func (s *Store) GetSelinuxState(ctx context.Context, agentID string) (SelinuxState, bool, error) {
	state := SelinuxState{AgentID: agentID, Booleans: []SelinuxBoolean{}, Modules: []SelinuxModule{}}
	var booleansJSON, modulesJSON []byte
	var collectedAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT booleans_json, modules_json, collected_at
		FROM agent_selinux_state WHERE agent_id = $1
	`, agentID).Scan(&booleansJSON, &modulesJSON, &collectedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return state, false, nil
	}
	if err != nil {
		return SelinuxState{}, false, fmt.Errorf("get selinux state %s: %w", agentID, err)
	}
	if err := json.Unmarshal(booleansJSON, &state.Booleans); err != nil {
		return SelinuxState{}, false, fmt.Errorf("unmarshal booleans: %w", err)
	}
	if err := json.Unmarshal(modulesJSON, &state.Modules); err != nil {
		return SelinuxState{}, false, fmt.Errorf("unmarshal modules: %w", err)
	}
	state.CollectedAt = &collectedAt
	return state, true, nil
}

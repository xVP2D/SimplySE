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

	"github.com/jackc/pgx/v5/pgconn"
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

	// UndoJSON is the recorded way to undo this command on the machine
	// ("" = none/unknown). Internal: the API exposes a derived summary
	// instead (see server.DescribeRevert).
	UndoJSON string `json:"-"`
	// RevertsCommandID is set on a command that is itself the undo of
	// another one.
	RevertsCommandID *string `json:"reverts_command_id,omitempty"`
	// RevertPending: an undo of this command is currently in flight.
	RevertPending bool `json:"revert_pending"`
}

// commandColumns/scanCommand keep GetCommand and ListCommands reading the
// same columns in the same order.
const commandColumns = `c.id, c.agent_id, c.rule_id, c.type, c.payload_json, c.status, c.result_message,
	c.created_at, c.acked_at, COALESCE(c.undo_json::text, ''), c.reverts_command_id,
	EXISTS (SELECT 1 FROM commands r WHERE r.reverts_command_id = c.id AND r.status IN ('pending', 'sent'))`

func scanCommand(row interface{ Scan(...any) error }, extra ...any) (Command, error) {
	var c Command
	dest := append([]any{&c.ID, &c.AgentID, &c.RuleID, &c.Type, &c.PayloadJSON, &c.Status, &c.ResultMessage,
		&c.CreatedAt, &c.AckedAt, &c.UndoJSON, &c.RevertsCommandID, &c.RevertPending}, extra...)
	err := row.Scan(dest...)
	return c, err
}

// NewCommand describes a command to persist. UndoJSON and RevertsCommandID
// are optional (see Command).
type NewCommand struct {
	AgentID          string
	RuleID           *string
	Type             string
	PayloadJSON      string
	UndoJSON         string
	RevertsCommandID *string
}

// ErrRevertInProgress: an undo of that command is already pending/sent.
var ErrRevertInProgress = errors.New("an undo of this command is already in progress")

func (s *Store) CreateCommand(ctx context.Context, agentID string, ruleID *string, cmdType, payloadJSON string) (Command, error) {
	return s.CreateCommandWith(ctx, NewCommand{AgentID: agentID, RuleID: ruleID, Type: cmdType, PayloadJSON: payloadJSON})
}

func (s *Store) CreateCommandWith(ctx context.Context, n NewCommand) (Command, error) {
	c := Command{AgentID: n.AgentID, RuleID: n.RuleID, Type: n.Type, PayloadJSON: n.PayloadJSON,
		UndoJSON: n.UndoJSON, RevertsCommandID: n.RevertsCommandID}
	var undo any
	if n.UndoJSON != "" {
		undo = n.UndoJSON
	}
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO commands (agent_id, rule_id, type, payload_json, undo_json, reverts_command_id)
		VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
		RETURNING id, status, created_at
	`, n.AgentID, n.RuleID, n.Type, n.PayloadJSON, undo, n.RevertsCommandID).Scan(&c.ID, &c.Status, &c.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && n.RevertsCommandID != nil {
			return Command{}, ErrRevertInProgress
		}
		return Command{}, fmt.Errorf("create command: %w", err)
	}
	return c, nil
}

// PendingCommandsFor returns commands that were persisted but never reached
// the agent (it was disconnected when they were created), oldest first, for
// a reconnecting agent. Recent commands of any kind, plus audit2allow
// generation (harmless, whatever its age) — but never undo commands, which
// are interactive and expire on their own — and not old mutating commands,
// which shouldn't suddenly run hours later; those stay visible as pending
// where the operator can delete them.
func (s *Store) PendingCommandsFor(ctx context.Context, agentID string, limit int) ([]Command, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+commandColumns+`
		FROM commands c
		WHERE c.agent_id = $1 AND c.status = 'pending' AND c.reverts_command_id IS NULL
		  AND (c.type = 'suggest_module' OR c.created_at > now() - interval '10 minutes')
		ORDER BY c.created_at
		LIMIT $2
	`, agentID, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending commands: %w", err)
	}
	defer rows.Close()
	var out []Command
	for rows.Next() {
		c, err := scanCommand(rows)
		if err != nil {
			return nil, fmt.Errorf("scan pending command: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ExpireStaleReverts fails undo commands for originalID that have been
// pending/sent for over two minutes with no answer (agent went away), so a
// lost undo can be retried instead of blocking the unique in-flight guard
// forever.
func (s *Store) ExpireStaleReverts(ctx context.Context, originalID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE commands SET status = 'failed', acked_at = now(),
			result_message = 'no response from the agent (timed out)'
		WHERE reverts_command_id = $1 AND status IN ('pending', 'sent')
		  AND created_at < now() - interval '2 minutes'
	`, originalID)
	if err != nil {
		return fmt.Errorf("expire stale reverts: %w", err)
	}
	return nil
}

// DeleteCommandAndReverts removes a command together with any undo commands
// that point at it, in one statement.
func (s *Store) DeleteCommandAndReverts(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM commands WHERE id = $1 OR reverts_command_id = $1`, id)
	if err != nil {
		return false, fmt.Errorf("delete command: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete command: %w", err)
	}
	return n > 0, nil
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
	c, err := scanCommand(s.db.QueryRowContext(ctx, `SELECT `+commandColumns+` FROM commands c WHERE c.id = $1`, id))
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
		SELECT `+commandColumns+`, count(*) OVER() AS total
		FROM commands c
		WHERE ($1 = '' OR c.agent_id = $1) AND ($2 = '' OR c.status = $2)
		  -- audit2allow generation and permissive collection windows are not
		  -- applied rules: they are tracked on the Suggestions page (the
		  -- latter in domain_collections), and listing them here only
		  -- doubled every approved module with a row that can't be deleted.
		  AND c.type NOT IN ('suggest_module', 'permissive_start', 'permissive_stop')
		  -- An in-flight undo (remove_module/restorecon dispatched by
		  -- RevertCommand) is hidden while pending/sent: the rule it is
		  -- undoing already shows "reverting" via revert_pending, so
		  -- showing this row too just duplicated the entry on screen for
		  -- as long as the undo took. Once it fails it stays visible
		  -- (status flips to 'failed', outside this filter) so the error
		  -- remains visible and retryable; once it succeeds, both rows are
		  -- deleted together (see completeRevertIfApplicable) so there is
		  -- nothing left to filter.
		  AND NOT (c.reverts_command_id IS NOT NULL AND c.status IN ('pending', 'sent'))
		ORDER BY c.created_at DESC
		LIMIT $3 OFFSET $4
	`, opts.AgentID, opts.Status, opts.Limit, opts.Offset)
	if err != nil {
		return ListCommandsResult{}, fmt.Errorf("list commands: %w", err)
	}
	defer rows.Close()

	result := ListCommandsResult{Commands: []Command{}} // never nil: encodes to `[]`, not `null`, when empty
	for rows.Next() {
		c, err := scanCommand(rows, &result.Total)
		if err != nil {
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
	Severity       string     `json:"severity"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"created_at"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
	AcknowledgedBy string     `json:"acknowledged_by"`
}

func (s *Store) CreateAlert(ctx context.Context, a Alert) error {
	severity := a.Severity
	if severity == "" {
		severity = "medium"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO alerts (type, title, message, agent_id, scontext, tcontext, tclass, severity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, a.Type, a.Title, a.Message, a.AgentID, a.SContext, a.TContext, a.TClass, severity)
	if err != nil {
		return fmt.Errorf("create alert: %w", err)
	}
	return nil
}

// ListAlertsOptions filters and paginates the alert center. Status is an
// exact match ("open" or "acknowledged"); left empty, all alerts match.
type ListAlertsOptions struct {
	Status   string
	Severity string
	Offset   int
	Limit    int
}

type ListAlertsResult struct {
	Alerts []Alert `json:"alerts"`
	Total  int     `json:"total"`
}

func (s *Store) ListAlerts(ctx context.Context, opts ListAlertsOptions) (ListAlertsResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, type, title, message, agent_id, scontext, tcontext, tclass, severity, status,
			created_at, acknowledged_at, acknowledged_by, count(*) OVER() AS total
		FROM alerts
		WHERE ($1 = '' OR status = $1) AND ($2 = '' OR severity = $2)
		ORDER BY created_at DESC
		LIMIT $3 OFFSET $4
	`, opts.Status, opts.Severity, opts.Limit, opts.Offset)
	if err != nil {
		return ListAlertsResult{}, fmt.Errorf("list alerts: %w", err)
	}
	defer rows.Close()

	result := ListAlertsResult{Alerts: []Alert{}} // never nil: encodes to `[]`, not `null`, when empty
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.ID, &a.Type, &a.Title, &a.Message, &a.AgentID, &a.SContext, &a.TContext, &a.TClass,
			&a.Severity, &a.Status, &a.CreatedAt, &a.AcknowledgedAt, &a.AcknowledgedBy, &result.Total); err != nil {
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
	AgentID     string            `json:"agent_id"`
	Booleans    []SelinuxBoolean  `json:"booleans"`
	Modules     []SelinuxModule   `json:"modules"`
	FileHashes  map[string]string `json:"file_hashes"`
	CollectedAt *time.Time        `json:"collected_at,omitempty"`
}

// UpsertSelinuxState overwrites the previous snapshot for agentID — see
// the SelinuxInventory proto comment for why this isn't append-only.
func (s *Store) UpsertSelinuxState(ctx context.Context, agentID string, booleans []SelinuxBoolean, modules []SelinuxModule, fileHashes map[string]string, collectedAt time.Time) error {
	booleansJSON, err := json.Marshal(booleans)
	if err != nil {
		return fmt.Errorf("marshal booleans: %w", err)
	}
	modulesJSON, err := json.Marshal(modules)
	if err != nil {
		return fmt.Errorf("marshal modules: %w", err)
	}
	fileHashesJSON, err := json.Marshal(fileHashes)
	if err != nil {
		return fmt.Errorf("marshal file hashes: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO agent_selinux_state (agent_id, booleans_json, modules_json, file_hashes_json, collected_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (agent_id) DO UPDATE SET
			booleans_json = EXCLUDED.booleans_json,
			modules_json = EXCLUDED.modules_json,
			file_hashes_json = EXCLUDED.file_hashes_json,
			collected_at = EXCLUDED.collected_at
	`, agentID, booleansJSON, modulesJSON, fileHashesJSON, collectedAt)
	if err != nil {
		return fmt.Errorf("upsert selinux state: %w", err)
	}
	return nil
}

// GetSelinuxState returns (state, false, nil) — not an error — when the
// agent hasn't sent an inventory snapshot yet (e.g. just enrolled, or
// running an older agent build that predates this feature).
func (s *Store) GetSelinuxState(ctx context.Context, agentID string) (SelinuxState, bool, error) {
	state := SelinuxState{AgentID: agentID, Booleans: []SelinuxBoolean{}, Modules: []SelinuxModule{}, FileHashes: map[string]string{}}
	var booleansJSON, modulesJSON, fileHashesJSON []byte
	var collectedAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT booleans_json, modules_json, file_hashes_json, collected_at
		FROM agent_selinux_state WHERE agent_id = $1
	`, agentID).Scan(&booleansJSON, &modulesJSON, &fileHashesJSON, &collectedAt)
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
	if err := json.Unmarshal(fileHashesJSON, &state.FileHashes); err != nil {
		return SelinuxState{}, false, fmt.Errorf("unmarshal file hashes: %w", err)
	}
	state.CollectedAt = &collectedAt
	return state, true, nil
}

type SuggestedModule struct {
	ID           string     `json:"id"`
	CommandID    string     `json:"command_id"`
	AgentID      string     `json:"agent_id"`
	ModuleName   string     `json:"module_name"`
	SContext     string     `json:"scontext"`
	TContext     string     `json:"tcontext"`
	TClass       string     `json:"tclass"`
	TEText       string     `json:"te_text"`
	PPBase64     string     `json:"pp_base64,omitempty"`
	Status       string     `json:"status"`
	ErrorMessage string     `json:"error_message"`
	CreatedAt    time.Time  `json:"created_at"`
	ReviewedAt   *time.Time `json:"reviewed_at,omitempty"`
	ReviewedBy   string     `json:"reviewed_by"`
}

// CreateSuggestedModule records that a suggest_module command was
// dispatched — status starts at 'generating' until the agent's ack
// arrives (see CompleteSuggestedModule).
func (s *Store) CreateSuggestedModule(ctx context.Context, commandID, agentID, moduleName, scontext, tcontext, tclass string) (SuggestedModule, error) {
	var m SuggestedModule
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO suggested_modules (command_id, agent_id, module_name, scontext, tcontext, tclass)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, command_id, agent_id, module_name, scontext, tcontext, tclass, te_text, pp_base64,
			status, error_message, created_at, reviewed_at, reviewed_by
	`, commandID, agentID, moduleName, scontext, tcontext, tclass).Scan(
		&m.ID, &m.CommandID, &m.AgentID, &m.ModuleName, &m.SContext, &m.TContext, &m.TClass,
		&m.TEText, &m.PPBase64, &m.Status, &m.ErrorMessage, &m.CreatedAt, &m.ReviewedAt, &m.ReviewedBy)
	if err != nil {
		return SuggestedModule{}, fmt.Errorf("create suggested module: %w", err)
	}
	return m, nil
}

// CompleteSuggestedModule applies the agent's audit2allow result (or
// failure) to the suggestion created for commandID. A no-op (no error) if
// no suggestion is tracking that command — e.g. an ack for some other
// command type.
func (s *Store) CompleteSuggestedModule(ctx context.Context, commandID string, success bool, teText, ppBase64, errMsg string) error {
	status := "pending"
	if !success {
		status = "failed"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE suggested_modules SET status = $2, te_text = $3, pp_base64 = $4, error_message = $5
		WHERE command_id = $1
	`, commandID, status, teText, ppBase64, errMsg)
	if err != nil {
		return fmt.Errorf("complete suggested module: %w", err)
	}
	return nil
}

type ListSuggestedModulesOptions struct {
	Status string
	Offset int
	Limit  int
}

type ListSuggestedModulesResult struct {
	Modules []SuggestedModule `json:"modules"`
	Total   int               `json:"total"`
}

// ListSuggestedModules omits pp_base64 from each row (it's a compiled
// binary blob, only useful in bulk when actually deploying — GetSuggestedModule
// returns it for the one the operator is reviewing).
func (s *Store) ListSuggestedModules(ctx context.Context, opts ListSuggestedModulesOptions) (ListSuggestedModulesResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, command_id, agent_id, module_name, scontext, tcontext, tclass, status,
			error_message, created_at, reviewed_at, reviewed_by, count(*) OVER() AS total
		FROM suggested_modules
		WHERE ($1 = '' OR status = $1)
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, opts.Status, opts.Limit, opts.Offset)
	if err != nil {
		return ListSuggestedModulesResult{}, fmt.Errorf("list suggested modules: %w", err)
	}
	defer rows.Close()

	result := ListSuggestedModulesResult{Modules: []SuggestedModule{}}
	for rows.Next() {
		var m SuggestedModule
		if err := rows.Scan(&m.ID, &m.CommandID, &m.AgentID, &m.ModuleName, &m.SContext, &m.TContext, &m.TClass,
			&m.Status, &m.ErrorMessage, &m.CreatedAt, &m.ReviewedAt, &m.ReviewedBy, &result.Total); err != nil {
			return ListSuggestedModulesResult{}, fmt.Errorf("scan suggested module: %w", err)
		}
		result.Modules = append(result.Modules, m)
	}
	return result, rows.Err()
}

func (s *Store) GetSuggestedModule(ctx context.Context, id string) (SuggestedModule, error) {
	var m SuggestedModule
	err := s.db.QueryRowContext(ctx, `
		SELECT id, command_id, agent_id, module_name, scontext, tcontext, tclass, te_text, pp_base64,
			status, error_message, created_at, reviewed_at, reviewed_by
		FROM suggested_modules WHERE id = $1
	`, id).Scan(&m.ID, &m.CommandID, &m.AgentID, &m.ModuleName, &m.SContext, &m.TContext, &m.TClass,
		&m.TEText, &m.PPBase64, &m.Status, &m.ErrorMessage, &m.CreatedAt, &m.ReviewedAt, &m.ReviewedBy)
	if err != nil {
		return SuggestedModule{}, fmt.Errorf("get suggested module %s: %w", id, err)
	}
	return m, nil
}

// ReviewSuggestedModule records a human decision (status is "approved" or
// "rejected") — the caller is responsible for actually dispatching the
// install_module command on approval; this just records the decision.
func (s *Store) ReviewSuggestedModule(ctx context.Context, id, status, reviewedBy string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE suggested_modules SET status = $2, reviewed_at = now(), reviewed_by = $3
		WHERE id = $1
	`, id, status, reviewedBy)
	if err != nil {
		return fmt.Errorf("review suggested module: %w", err)
	}
	return nil
}

// ClaimSuggestionForApproval atomically moves a pending suggestion to
// approved, so of several simultaneous approvals exactly one wins. Returns
// false if it wasn't pending (already claimed, rejected, ...).
func (s *Store) ClaimSuggestionForApproval(ctx context.Context, id, reviewedBy string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE suggested_modules SET status = 'approved', reviewed_at = now(), reviewed_by = $2
		WHERE id = $1 AND status = 'pending'
	`, id, reviewedBy)
	if err != nil {
		return false, fmt.Errorf("claim suggestion: %w", err)
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ReleaseSuggestionClaim puts a claimed suggestion back to pending when
// nothing ended up being installed.
func (s *Store) ReleaseSuggestionClaim(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE suggested_modules SET status = 'pending', reviewed_at = NULL, reviewed_by = ''
		WHERE id = $1 AND status = 'approved'
	`, id)
	return err
}

// FindOpenSuggestion returns the newest suggestion for this agent and module
// that is still worth reusing instead of creating another: one being
// generated or awaiting review, or an approved one (the caller decides
// whether an approved module is still installed).
func (s *Store) FindOpenSuggestion(ctx context.Context, agentID, moduleName string) (SuggestedModule, bool, error) {
	var m SuggestedModule
	err := s.db.QueryRowContext(ctx, `
		SELECT id, command_id, agent_id, module_name, scontext, tcontext, tclass, te_text, pp_base64,
			status, error_message, created_at, reviewed_at, reviewed_by
		FROM suggested_modules
		WHERE agent_id = $1 AND module_name = $2 AND status IN ('generating', 'pending', 'approved')
		ORDER BY created_at DESC LIMIT 1
	`, agentID, moduleName).Scan(&m.ID, &m.CommandID, &m.AgentID, &m.ModuleName, &m.SContext, &m.TContext, &m.TClass,
		&m.TEText, &m.PPBase64, &m.Status, &m.ErrorMessage, &m.CreatedAt, &m.ReviewedAt, &m.ReviewedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return SuggestedModule{}, false, nil
	}
	if err != nil {
		return SuggestedModule{}, false, fmt.Errorf("find open suggestion: %w", err)
	}
	return m, true, nil
}

// ModuleInstallInProgress reports whether an install_module for this module
// is on its way to the agent, or finished only moments ago — a window in
// which the agent's inventory may not list the module yet, so it can't be
// relied on to tell "already installed".
func (s *Store) ModuleInstallInProgress(ctx context.Context, agentID, moduleName string) (bool, error) {
	var busy bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM commands
			WHERE agent_id = $1 AND type = 'install_module' AND payload_json->>'name' = $2
			  AND (status IN ('pending', 'sent') OR (status = 'acked' AND created_at > now() - interval '2 minutes'))
		)
	`, agentID, moduleName).Scan(&busy)
	if err != nil {
		return false, fmt.Errorf("check module install in progress: %w", err)
	}
	return busy, nil
}

type IntegrationSetting struct {
	Key        string    `json:"key"`
	Enabled    bool      `json:"enabled"`
	ConfigJSON []byte    `json:"-"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// UpsertIntegrationSetting saves (or replaces) the full config for one
// connector — always the complete config, never a partial patch; callers
// merge in whatever should be kept (e.g. an unchanged password) before
// calling this.
func (s *Store) UpsertIntegrationSetting(ctx context.Context, key string, enabled bool, configJSON []byte) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO integration_settings (key, enabled, config_json, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (key) DO UPDATE SET
			enabled = EXCLUDED.enabled,
			config_json = EXCLUDED.config_json,
			updated_at = now()
	`, key, enabled, configJSON)
	if err != nil {
		return fmt.Errorf("upsert integration setting %s: %w", key, err)
	}
	return nil
}

// GetIntegrationSetting returns (setting, false, nil) — not an error —
// when nothing has been saved for this key yet (never configured).
func (s *Store) GetIntegrationSetting(ctx context.Context, key string) (IntegrationSetting, bool, error) {
	var setting IntegrationSetting
	setting.Key = key
	err := s.db.QueryRowContext(ctx, `
		SELECT enabled, config_json, updated_at FROM integration_settings WHERE key = $1
	`, key).Scan(&setting.Enabled, &setting.ConfigJSON, &setting.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return IntegrationSetting{Key: key}, false, nil
	}
	if err != nil {
		return IntegrationSetting{}, false, fmt.Errorf("get integration setting %s: %w", key, err)
	}
	return setting, true, nil
}

// Collection is one "collect every denial of a domain" run.
type Collection struct {
	ID              string     `json:"id"`
	AgentID         string     `json:"agent_id"`
	Domain          string     `json:"domain"`
	Status          string     `json:"status"`
	DurationSecs    int        `json:"duration_secs"`
	CreatedBy       string     `json:"created_by"`
	StartedAt       time.Time  `json:"started_at"`
	CollectingSince *time.Time `json:"collecting_since,omitempty"`
	EndsAt          *time.Time `json:"ends_at,omitempty"`
	FinishedAt      *time.Time `json:"finished_at,omitempty"`
	SuggestionID    *string    `json:"suggestion_id,omitempty"`
	LinesCount      int        `json:"lines_count"`
	Message         string     `json:"message"`

	StartCommandID *string    `json:"-"`
	StopCommandID  *string    `json:"-"`
	StopSentAt     *time.Time `json:"-"`
}

// ErrCollectionActive: that agent is already collecting that domain.
var ErrCollectionActive = errors.New("this domain is already being collected on this agent")

const collectionColumns = `id, agent_id, domain, status, duration_secs, created_by, started_at, collecting_since, ends_at,
	finished_at, suggestion_id, lines_count, message, start_command_id, stop_command_id, stop_sent_at`

func scanCollection(row interface{ Scan(...any) error }) (Collection, error) {
	var c Collection
	err := row.Scan(&c.ID, &c.AgentID, &c.Domain, &c.Status, &c.DurationSecs, &c.CreatedBy, &c.StartedAt,
		&c.CollectingSince, &c.EndsAt, &c.FinishedAt, &c.SuggestionID, &c.LinesCount, &c.Message,
		&c.StartCommandID, &c.StopCommandID, &c.StopSentAt)
	return c, err
}

func (s *Store) CreateCollection(ctx context.Context, agentID, domain string, durationSecs int, by string) (Collection, error) {
	c, err := scanCollection(s.db.QueryRowContext(ctx, `
		INSERT INTO domain_collections (agent_id, domain, duration_secs, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING `+collectionColumns, agentID, domain, durationSecs, by))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Collection{}, ErrCollectionActive
		}
		return Collection{}, fmt.Errorf("create collection: %w", err)
	}
	return c, nil
}

func (s *Store) GetCollection(ctx context.Context, id string) (Collection, error) {
	c, err := scanCollection(s.db.QueryRowContext(ctx, `SELECT `+collectionColumns+` FROM domain_collections WHERE id = $1`, id))
	if err != nil {
		return Collection{}, fmt.Errorf("get collection %s: %w", id, err)
	}
	return c, nil
}

// GetCollectionByCommand finds the run a start/stop command belongs to.
func (s *Store) GetCollectionByCommand(ctx context.Context, commandID string) (Collection, bool, error) {
	c, err := scanCollection(s.db.QueryRowContext(ctx, `
		SELECT `+collectionColumns+` FROM domain_collections
		WHERE start_command_id = $1 OR stop_command_id = $1`, commandID))
	if errors.Is(err, sql.ErrNoRows) {
		return Collection{}, false, nil
	}
	if err != nil {
		return Collection{}, false, fmt.Errorf("get collection by command: %w", err)
	}
	return c, true, nil
}

func (s *Store) listCollections(ctx context.Context, where string, args ...any) ([]Collection, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+collectionColumns+` FROM domain_collections `+where, args...)
	if err != nil {
		return nil, fmt.Errorf("list collections: %w", err)
	}
	defer rows.Close()
	out := []Collection{}
	for rows.Next() {
		c, err := scanCollection(rows)
		if err != nil {
			return nil, fmt.Errorf("scan collection: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListCollections: active runs first, then the most recent. agentID == ""
// means every agent.
// ListCollections lists collections that still need attention: any active
// run, one awaiting a manual "generate" click, a failed one, or one whose
// generated suggestion hasn't been reviewed yet. A "done" collection whose
// suggestion has since been approved or rejected has nothing left to look
// at, so it drops off this list once that happens — the row itself stays in
// domain_collections as an audit trail of when a domain was loosened, by
// whom and for how long; only what the live dashboard shows is affected.
// agentID == "" means every agent.
func (s *Store) ListCollections(ctx context.Context, agentID string, limit int) ([]Collection, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT dc.id, dc.agent_id, dc.domain, dc.status, dc.duration_secs, dc.created_by, dc.started_at,
			dc.collecting_since, dc.ends_at, dc.finished_at, dc.suggestion_id, dc.lines_count, dc.message,
			dc.start_command_id, dc.stop_command_id, dc.stop_sent_at
		FROM domain_collections dc
		LEFT JOIN suggested_modules sm ON sm.id = dc.suggestion_id
		WHERE ($1 = '' OR dc.agent_id = $1)
		  AND NOT (dc.status = 'done' AND (dc.suggestion_id IS NULL OR sm.status IN ('approved', 'rejected')))
		ORDER BY (dc.status IN ('starting', 'collecting', 'stopping')) DESC, dc.started_at DESC
		LIMIT $2
	`, agentID, limit)
	if err != nil {
		return nil, fmt.Errorf("list collections: %w", err)
	}
	defer rows.Close()
	out := []Collection{}
	for rows.Next() {
		c, err := scanCollection(rows)
		if err != nil {
			return nil, fmt.Errorf("scan collection: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListActiveCollections(ctx context.Context) ([]Collection, error) {
	return s.listCollections(ctx, `WHERE status IN ('starting','collecting','stopping') ORDER BY started_at`)
}

func (s *Store) exec(ctx context.Context, what, query string, args ...any) error {
	if _, err := s.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	return nil
}

func (s *Store) SetCollectionStartCommand(ctx context.Context, id, commandID string) error {
	return s.exec(ctx, "set collection start command", `UPDATE domain_collections SET start_command_id = $2 WHERE id = $1`, id, commandID)
}

// MarkCollecting: the agent confirmed the domain is permissive.
func (s *Store) MarkCollecting(ctx context.Context, id string, endsAt time.Time) error {
	return s.exec(ctx, "mark collecting", `
		UPDATE domain_collections SET status = 'collecting', collecting_since = now(), ends_at = $2
		WHERE id = $1 AND status = 'starting'`, id, endsAt)
}

// BeginStopping records that a stop was sent (again, on a retry).
func (s *Store) BeginStopping(ctx context.Context, id, stopCommandID string) error {
	return s.exec(ctx, "begin stopping", `
		UPDATE domain_collections SET status = 'stopping', stop_command_id = $2, stop_sent_at = now()
		WHERE id = $1 AND status IN ('collecting', 'stopping')`, id, stopCommandID)
}

// CloseCollectionWindow ends the collecting/stopping phase: the window is
// shut (permissive mode is off again, or the run failed before/during
// that), and finished_at is fixed so a suggestion generated later still
// reads exactly what was logged during the run. Never sets suggestion_id:
// generating one is a separate, explicit step (see RecordSuggestion).
func (s *Store) CloseCollectionWindow(ctx context.Context, id, status, message string, lines int) error {
	return s.exec(ctx, "close collection window", `
		UPDATE domain_collections SET status = $2, message = $3, lines_count = $4, finished_at = now()
		WHERE id = $1 AND status IN ('starting', 'collecting', 'stopping')`, id, status, message, lines)
}

// RecordSuggestion attaches the suggestion generated from a "collected" run
// (status -> "done"), or records that generating one failed (status ->
// "failed", leaving lines_count as-is so the operator can retry).
func (s *Store) RecordSuggestion(ctx context.Context, id, status, message string, suggestionID *string) error {
	return s.exec(ctx, "record collection suggestion", `
		UPDATE domain_collections SET status = $2, message = $3, suggestion_id = $4
		WHERE id = $1 AND status = 'collected'`, id, status, message, suggestionID)
}

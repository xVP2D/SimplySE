package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// This file is the store side of the permanent history that feeds the
// dashboard's charts (tables: history_* in schema.sql). Nothing here ever
// deletes or decrements a row except PurgeHistory's retention sweep.

// DenialKey identifies one history_denials_hourly row.
type DenialKey struct {
	Bucket   time.Time // start of the UTC hour
	AgentID  string
	SContext string
	TContext string
	TClass   string
	Perms    string // sorted, comma-joined permission set
}

const upsertDenialSQL = `
	INSERT INTO history_denials_hourly (bucket, agent_id, scontext, tcontext, tclass, perms, count)
	VALUES ($1, $2, $3, $4, $5, $6, $7)
	ON CONFLICT (bucket, agent_id, scontext, tcontext, tclass, perms)
	DO UPDATE SET count = history_denials_hourly.count + EXCLUDED.count`

func upsertDenialCounts(ctx context.Context, tx *sql.Tx, counts map[DenialKey]int64) error {
	stmt, err := tx.PrepareContext(ctx, upsertDenialSQL)
	if err != nil {
		return fmt.Errorf("prepare denial history upsert: %w", err)
	}
	defer stmt.Close()
	for k, n := range counts {
		if _, err := stmt.ExecContext(ctx, k.Bucket.UTC(), k.AgentID, k.SContext, k.TContext, k.TClass, k.Perms, n); err != nil {
			return fmt.Errorf("upsert denial history: %w", err)
		}
	}
	return nil
}

// AddDenialCounts adds n to each row's count (creating rows as needed), all
// or nothing.
func (s *Store) AddDenialCounts(ctx context.Context, counts map[DenialKey]int64) error {
	if len(counts) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin denial history tx: %w", err)
	}
	defer tx.Rollback()
	if err := upsertDenialCounts(ctx, tx, counts); err != nil {
		return err
	}
	return tx.Commit()
}

// HistoryMeta returns a bookkeeping value, (“”, false, nil) when unset.
func (s *Store) HistoryMeta(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM history_meta WHERE key = $1`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read history meta %s: %w", key, err)
	}
	return v, true, nil
}

// ApplyDenialBackfill adds counts reconstructed from data that predates the
// history and records metaKey in the same transaction, so the backfill is
// either fully applied and marked done, or not applied at all.
func (s *Store) ApplyDenialBackfill(ctx context.Context, counts map[DenialKey]int64, metaKey string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin denial backfill tx: %w", err)
	}
	defer tx.Rollback()
	if err := upsertDenialCounts(ctx, tx, counts); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO history_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
		metaKey, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return fmt.Errorf("mark denial backfill done: %w", err)
	}
	return tx.Commit()
}

// FleetSample is one agent's state at one sample time.
type FleetSample struct {
	AgentID    string
	Mode       string
	Policy     string
	Connected  bool
	Score      int
	OpenAlerts int
}

// OpenAlertCounts returns the number of open alerts per agent.
func (s *Store) OpenAlertCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT agent_id, COUNT(*) FROM alerts WHERE status = 'open' GROUP BY agent_id`)
	if err != nil {
		return nil, fmt.Errorf("count open alerts: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scan open alert count: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// AddFleetSamples stores one sample per agent for time ts. Re-sampling the
// same instant is a no-op.
func (s *Store) AddFleetSamples(ctx context.Context, ts time.Time, samples []FleetSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin fleet sample tx: %w", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO history_fleet_samples (ts, agent_id, mode, policy, connected, score, open_alerts)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (ts, agent_id) DO NOTHING`)
	if err != nil {
		return fmt.Errorf("prepare fleet sample insert: %w", err)
	}
	defer stmt.Close()
	for _, sm := range samples {
		if _, err := stmt.ExecContext(ctx, ts.UTC(), sm.AgentID, sm.Mode, sm.Policy, sm.Connected, sm.Score, sm.OpenAlerts); err != nil {
			return fmt.Errorf("insert fleet sample: %w", err)
		}
	}
	return tx.Commit()
}

// PurgeHistory deletes history older than retentionDays (the only place
// history rows are ever removed). retentionDays <= 0 keeps everything.
func (s *Store) PurgeHistory(ctx context.Context, retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	var total int64
	for _, q := range []string{
		`DELETE FROM history_denials_hourly WHERE bucket < now() - make_interval(days => $1)`,
		`DELETE FROM history_commands WHERE created_at < now() - make_interval(days => $1)`,
		`DELETE FROM history_alerts WHERE created_at < now() - make_interval(days => $1)`,
		`DELETE FROM history_fleet_samples WHERE ts < now() - make_interval(days => $1)`,
	} {
		res, err := s.db.ExecContext(ctx, q, retentionDays)
		if err != nil {
			return total, fmt.Errorf("purge history: %w", err)
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, nil
}

// ---------------------------------------------------------------------------
// Querying

type historyDataset struct {
	table   string
	timeCol string
	// dims maps a dimension name a client may group by to the SQL expression
	// behind it. Only these fixed strings are ever concatenated into a query.
	dims         map[string]string
	measures     string // SELECT list of aggregate expressions
	orderMeasure string // alias sorted on when there is no time bucket
	totalExpr    string // aggregate behind HistoryStatus's "total"
}

var historyDatasets = map[string]historyDataset{
	"denials": {
		table:   "history_denials_hourly",
		timeCol: "bucket",
		dims: map[string]string{
			"agent": "agent_id", "scontext": "scontext", "tcontext": "tcontext", "tclass": "tclass", "perms": "perms",
		},
		// active_hours and signatures describe the shape of a group's
		// activity, not just its size: they are what the statistical and
		// correlation charts plot against the plain count.
		measures: "SUM(count)::bigint AS count, COUNT(DISTINCT bucket)::bigint AS active_hours, " +
			"COUNT(DISTINCT (scontext, tcontext, tclass, perms))::bigint AS signatures",
		orderMeasure: "count",
		totalExpr:    "COALESCE(SUM(count), 0)::bigint",
	},
	"commands": {
		table:   "history_commands",
		timeCol: "created_at",
		dims: map[string]string{
			"agent": "agent_id", "type": "type", "status": "status",
			"kind": "CASE WHEN is_revert THEN 'revert' ELSE 'deploy' END",
		},
		measures: "COUNT(*)::bigint AS count, COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed, " +
			"COUNT(DISTINCT type)::bigint AS types",
		orderMeasure: "count",
		totalExpr:    "COUNT(*)::bigint",
	},
	"alerts": {
		table:   "history_alerts",
		timeCol: "created_at",
		dims: map[string]string{
			"agent": "agent_id", "type": "type", "severity": "severity", "status": "status",
		},
		measures: "COUNT(*)::bigint AS count, COUNT(*) FILTER (WHERE severity = 'high')::bigint AS high, " +
			"COUNT(DISTINCT type)::bigint AS types",
		orderMeasure: "count",
		totalExpr:    "COUNT(*)::bigint",
	},
	"fleet": {
		table:   "history_fleet_samples",
		timeCol: "ts",
		dims:    map[string]string{"agent": "agent_id", "mode": "mode", "policy": "policy"},
		measures: "COUNT(*)::bigint AS samples, AVG(score)::float8 AS score, " +
			"AVG(CASE WHEN connected THEN 1 ELSE 0 END)::float8 AS online, AVG(open_alerts)::float8 AS open_alerts",
		orderMeasure: "samples",
		totalExpr:    "COUNT(*)::bigint",
	},
}

// HistoryDatasets lists the queryable dataset names, sorted.
func HistoryDatasets() []string {
	names := make([]string, 0, len(historyDatasets))
	for n := range historyDatasets {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// HistoryDims lists the dimensions a dataset can be grouped by, sorted.
func HistoryDims(dataset string) []string {
	def, ok := historyDatasets[dataset]
	if !ok {
		return nil
	}
	names := make([]string, 0, len(def.dims))
	for n := range def.dims {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

const (
	maxHistoryDays  = 366
	maxHistoryDims  = 4
	maxHistoryRows  = 20000
	defaultHistDays = 30
)

var historyBuckets = map[string]string{"hour": "hour", "day": "day", "week": "week", "month": "month", "none": ""}

// HistoryQuery is a validated request for aggregated history.
type HistoryQuery struct {
	Dataset string
	Days    int
	Bucket  string // hour | day | week | month | none
	Group   []string
}

// NormalizeHistoryQuery validates client input: unknown datasets, buckets
// and dimensions are rejected (never passed through), days is clamped, and a
// dimension repeated twice is dropped.
func NormalizeHistoryQuery(dataset string, days int, bucket string, group []string) (HistoryQuery, error) {
	def, ok := historyDatasets[dataset]
	if !ok {
		return HistoryQuery{}, fmt.Errorf("unknown history dataset %q (known: %s)", dataset, strings.Join(HistoryDatasets(), ", "))
	}
	if days <= 0 {
		days = defaultHistDays
	}
	if days > maxHistoryDays {
		days = maxHistoryDays
	}
	if bucket == "" {
		bucket = "day"
	}
	if _, ok := historyBuckets[bucket]; !ok {
		return HistoryQuery{}, fmt.Errorf("unknown bucket %q (known: hour, day, week, month, none)", bucket)
	}
	seen := map[string]bool{}
	var dims []string
	for _, g := range group {
		g = strings.TrimSpace(g)
		if g == "" || seen[g] {
			continue
		}
		if _, ok := def.dims[g]; !ok {
			return HistoryQuery{}, fmt.Errorf("dataset %q cannot be grouped by %q (known: %s)", dataset, g, strings.Join(HistoryDims(dataset), ", "))
		}
		seen[g] = true
		dims = append(dims, g)
	}
	if len(dims) > maxHistoryDims {
		return HistoryQuery{}, fmt.Errorf("at most %d grouping dimensions", maxHistoryDims)
	}
	return HistoryQuery{Dataset: dataset, Days: days, Bucket: bucket, Group: dims}, nil
}

// buildHistorySQL turns a validated query into SQL. Every interpolated piece
// comes from historyDatasets/historyBuckets (fixed strings), never from the
// request.
func buildHistorySQL(q HistoryQuery) (string, error) {
	def, ok := historyDatasets[q.Dataset]
	if !ok {
		return "", fmt.Errorf("unknown history dataset %q", q.Dataset)
	}
	unit, ok := historyBuckets[q.Bucket]
	if !ok {
		return "", fmt.Errorf("unknown bucket %q", q.Bucket)
	}
	var sel, group, order []string
	if unit != "" {
		sel = append(sel, fmt.Sprintf(`EXTRACT(EPOCH FROM date_trunc('%s', %s AT TIME ZONE 'UTC'))::bigint AS t`, unit, def.timeCol))
		group = append(group, "1")
		order = append(order, "1")
	}
	for _, d := range q.Group {
		expr, ok := def.dims[d]
		if !ok {
			return "", fmt.Errorf("dataset %q cannot be grouped by %q", q.Dataset, d)
		}
		sel = append(sel, fmt.Sprintf(`%s AS "%s"`, expr, d))
		pos := fmt.Sprint(len(sel))
		group = append(group, pos)
		order = append(order, pos)
	}
	sel = append(sel, def.measures)
	stmt := fmt.Sprintf(`SELECT %s FROM %s WHERE %s >= now() - make_interval(days => $1)`,
		strings.Join(sel, ", "), def.table, def.timeCol)
	if len(group) > 0 {
		stmt += " GROUP BY " + strings.Join(group, ", ")
	}
	if unit == "" {
		stmt += " ORDER BY " + def.orderMeasure + " DESC"
	} else {
		stmt += " ORDER BY " + strings.Join(order, ", ")
	}
	return stmt + fmt.Sprintf(" LIMIT %d", maxHistoryRows+1), nil
}

// HistoryResult is the aggregated rows; Truncated is set when the row cap was
// hit and the tail was dropped.
type HistoryResult struct {
	Rows      []map[string]any
	Truncated bool
}

// QueryHistory runs a validated query.
func (s *Store) QueryHistory(ctx context.Context, q HistoryQuery) (HistoryResult, error) {
	stmt, err := buildHistorySQL(q)
	if err != nil {
		return HistoryResult{}, err
	}
	rows, err := s.db.QueryContext(ctx, stmt, q.Days)
	if err != nil {
		return HistoryResult{}, fmt.Errorf("query history %s: %w", q.Dataset, err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return HistoryResult{}, fmt.Errorf("history columns: %w", err)
	}
	out := HistoryResult{Rows: []map[string]any{}} // never nil: encodes to [], not null
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return HistoryResult{}, fmt.Errorf("scan history row: %w", err)
		}
		if len(out.Rows) == maxHistoryRows {
			out.Truncated = true
			break
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				row[c] = string(b)
			} else {
				row[c] = vals[i]
			}
		}
		out.Rows = append(out.Rows, row)
	}
	return out, rows.Err()
}

// HistoryDatasetStatus tells how much history exists for one dataset.
type HistoryDatasetStatus struct {
	Dataset string     `json:"dataset"`
	Since   *time.Time `json:"since"`
	Rows    int64      `json:"rows"`
	Total   int64      `json:"total"`
}

// HistoryStatus reports, per dataset, when its history starts and how much
// there is — so a chart can say "history since ..." instead of implying data
// from before the feature existed.
func (s *Store) HistoryStatus(ctx context.Context) ([]HistoryDatasetStatus, error) {
	var out []HistoryDatasetStatus
	for _, name := range HistoryDatasets() {
		def := historyDatasets[name]
		st := HistoryDatasetStatus{Dataset: name}
		var since sql.NullTime
		q := fmt.Sprintf(`SELECT MIN(%s), COUNT(*), %s FROM %s`, def.timeCol, def.totalExpr, def.table)
		if err := s.db.QueryRowContext(ctx, q).Scan(&since, &st.Rows, &st.Total); err != nil {
			return nil, fmt.Errorf("history status %s: %w", name, err)
		}
		if since.Valid {
			t := since.Time.UTC()
			st.Since = &t
		}
		out = append(out, st)
	}
	return out, nil
}

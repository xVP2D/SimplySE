// Package history keeps the permanent record behind the dashboard's charts.
//
// The live stores answer "what is happening now": denials that a rule
// resolves disappear from OpenSearch counts, deployments and alerts can be
// deleted, OpenSearch drops indices after its retention window. Charts built
// on them would lose data exactly when it matters. This package feeds
// separate, append-only history_* tables instead (see schema.sql), through
// four independent mechanisms:
//
//   - denials are counted at ingestion (Recorder), batched in memory;
//   - deployments and alerts are copied by Postgres triggers, so every code
//     path is covered and nothing has to remember to record;
//   - the fleet's state is sampled on a timer (Run);
//   - what already existed when this shipped is reconstructed once from
//     OpenSearch (BackfillDenials).
package history

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"console-selinux/master/internal/store/opensearch"
	"console-selinux/master/internal/store/postgres"
)

const (
	backfillKey   = "denials_backfill"
	flushEvery    = 10 * time.Second
	sampleEvery   = 15 * time.Minute
	purgeEvery    = 6 * time.Hour
	firstSampleIn = 30 * time.Second // let agents reconnect after a restart before judging them offline
	firstPurgeIn  = time.Minute
	shutdownFlush = 5 * time.Second
)

// NormalizePerms is the canonical text form of a permission set: sorted and
// comma-joined, identical to the one embedded in an event signature so live
// counts and backfilled counts land on the same rows.
func NormalizePerms(perms []string) string {
	sorted := append([]string(nil), perms...)
	sort.Strings(sorted)
	return strings.Join(sorted, ",")
}

// ComplianceScore mirrors the dashboard's per-agent score (frontend
// lib/compliance.ts): four checks, "unknown" ones skipped, percent passed.
func ComplianceScore(mode, policy string, connected bool, openAlerts int) int {
	seen := mode != "unknown"
	applicable, passed := 0, 0
	check := func(ok, counts bool) {
		if !counts {
			return
		}
		applicable++
		if ok {
			passed++
		}
	}
	check(mode == "enforcing", seen)
	check(connected, true)
	check(policy == "targeted", seen)
	check(openAlerts == 0, true)
	if applicable == 0 {
		return 100
	}
	return int(math.Round(100 * float64(passed) / float64(applicable)))
}

// Connectivity says which agents currently hold a session with the master.
type Connectivity interface {
	IsConnected(agentID string) bool
}

// Recorder counts denials as they are ingested and periodically writes the
// batch to Postgres. Counts are only ever added.
type Recorder struct {
	pg  *postgres.Store
	log *slog.Logger

	mu      sync.Mutex
	pending map[postgres.DenialKey]int64
}

func NewRecorder(pg *postgres.Store, log *slog.Logger) *Recorder {
	return &Recorder{pg: pg, log: log, pending: map[postgres.DenialKey]int64{}}
}

// RecordDenial counts one ingested denial. Call it only once the event is
// safely indexed, so a redelivered message is not counted for a failed
// attempt.
func (r *Recorder) RecordDenial(agentID, scontext, tcontext, tclass string, perms []string, tsUnix int64) {
	ts := time.Now()
	if tsUnix > 0 {
		ts = time.Unix(tsUnix, 0)
	}
	key := postgres.DenialKey{
		Bucket:   ts.UTC().Truncate(time.Hour),
		AgentID:  agentID,
		SContext: scontext,
		TContext: tcontext,
		TClass:   tclass,
		Perms:    NormalizePerms(perms),
	}
	r.mu.Lock()
	r.pending[key]++
	r.mu.Unlock()
}

// Flush writes the pending counts. On failure they are put back so the next
// flush retries them.
func (r *Recorder) Flush(ctx context.Context) error {
	r.mu.Lock()
	batch := r.pending
	r.pending = map[postgres.DenialKey]int64{}
	r.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	if err := r.pg.AddDenialCounts(ctx, batch); err != nil {
		r.mu.Lock()
		for k, n := range batch {
			r.pending[k] += n
		}
		r.mu.Unlock()
		return err
	}
	return nil
}

// BackfillDenials reconstructs, once, the denial history that predates this
// feature from the events still present in OpenSearch (resolved and
// quarantined ones included). Idempotent and safe at any time: it only
// counts documents without an ingestion timestamp, which live counting
// never touches, and the whole thing commits together with its done marker.
func BackfillDenials(ctx context.Context, pg *postgres.Store, search *opensearch.Store, log *slog.Logger) error {
	if _, done, err := pg.HistoryMeta(ctx, backfillKey); err != nil {
		return err
	} else if done {
		return nil
	}
	counts, err := search.PreHistoryDenialCounts(ctx)
	if err != nil {
		return err
	}
	rows := map[postgres.DenialKey]int64{}
	var events int64
	for _, c := range counts {
		k := postgres.DenialKey{
			Bucket:   time.Unix(c.HourUnix, 0).UTC(),
			AgentID:  c.AgentID,
			SContext: c.SContext,
			TContext: c.TContext,
			TClass:   c.TClass,
			Perms:    c.Perms,
		}
		rows[k] += c.Count
		events += c.Count
	}
	if err := pg.ApplyDenialBackfill(ctx, rows, backfillKey); err != nil {
		return err
	}
	log.Info("denial history backfilled from existing events", "rows", len(rows), "events", events)
	return nil
}

// SampleFleet records one sample per enrolled agent for time ts.
func SampleFleet(ctx context.Context, pg *postgres.Store, conn Connectivity, ts time.Time) (int, error) {
	agents, err := pg.ListAgents(ctx)
	if err != nil {
		return 0, err
	}
	open, err := pg.OpenAlertCounts(ctx)
	if err != nil {
		return 0, err
	}
	samples := make([]postgres.FleetSample, 0, len(agents))
	for _, a := range agents {
		connected := conn.IsConnected(a.ID)
		n := open[a.ID]
		samples = append(samples, postgres.FleetSample{
			AgentID:    a.ID,
			Mode:       a.Mode,
			Policy:     a.PolicyName,
			Connected:  connected,
			Score:      ComplianceScore(a.Mode, a.PolicyName, connected, n),
			OpenAlerts: n,
		})
	}
	if err := pg.AddFleetSamples(ctx, ts, samples); err != nil {
		return 0, err
	}
	return len(samples), nil
}

// Run drives the background work until ctx is done: flushing denial counts,
// sampling the fleet, and purging history older than retentionDays.
func (r *Recorder) Run(ctx context.Context, conn Connectivity, retentionDays int) {
	flush := time.NewTicker(flushEvery)
	defer flush.Stop()
	sample := time.NewTicker(sampleEvery)
	defer sample.Stop()
	purge := time.NewTicker(purgeEvery)
	defer purge.Stop()
	firstSample := time.After(firstSampleIn)
	firstPurge := time.After(firstPurgeIn)

	doSample := func() {
		ts := time.Now().UTC().Truncate(time.Minute)
		if n, err := SampleFleet(ctx, r.pg, conn, ts); err != nil {
			r.log.Error("fleet history sample failed", "error", err)
		} else {
			r.log.Debug("fleet history sampled", "agents", n)
		}
	}
	doPurge := func() {
		if n, err := r.pg.PurgeHistory(ctx, retentionDays); err != nil {
			r.log.Error("history purge failed", "error", err)
		} else if n > 0 {
			r.log.Info("history purged", "rows", n, "retention_days", retentionDays)
		}
	}

	for {
		select {
		case <-ctx.Done():
			final, cancel := context.WithTimeout(context.Background(), shutdownFlush)
			if err := r.Flush(final); err != nil {
				r.log.Error("final denial history flush failed", "error", err)
			}
			cancel()
			return
		case <-flush.C:
			if err := r.Flush(ctx); err != nil {
				r.log.Error("denial history flush failed (will retry)", "error", err)
			}
		case <-firstSample:
			doSample()
		case <-sample.C:
			doSample()
		case <-firstPurge:
			doPurge()
		case <-purge.C:
			doPurge()
		}
	}
}

// Package correlate lets the master pull recent events for a given host
// from external SIEM/EDR/monitoring tools already deployed in the
// environment (Wazuh, Suricata via an ELK/OpenSearch pipeline, LibreNMS,
// ...) — on demand, for one host and a narrow time window around a
// specific denial, never as a bulk/continuous ingestion.
//
// This is a deliberate alternative to having the Rust agent collect and
// ship application/auth logs itself: those tools already collect and
// store that data, often at much greater volume and with their own
// retention; duplicating that collection through this project's own
// agent would multiply the data this master has to store and index for
// no benefit when the source system is already there. Instead, a Source
// is queried live, its result rendered to the operator, and nothing it
// returns is persisted here.
package correlate

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Event is one item from an external system, normalized enough to render
// in a single timeline regardless of source.
type Event struct {
	Source    string    `json:"source"` // e.g. "opensearch", "librenms"
	Timestamp time.Time `json:"timestamp"`
	Severity  string    `json:"severity"`
	Summary   string    `json:"summary"`
	Raw       string    `json:"raw"` // original record, JSON-encoded, for an operator who wants the full detail
}

// Source is one external system this master knows how to query.
// Implementations must be safe to call concurrently and should return a
// (possibly empty) slice rather than erroring when the query legitimately
// finds nothing.
type Source interface {
	Name() string
	Query(ctx context.Context, ip, hostname string, around time.Time, window time.Duration) ([]Event, error)
}

// Registry holds whichever Sources are currently configured (see the
// integration_settings table, loaded/updated via the /api/integrations
// endpoints — internal/api/integrations.go) and fans a correlation
// request out to all of them. A Registry with no sources is valid and
// simply returns no events for every query — the API/frontend treat that
// as "correlation not configured" rather than an error. Mutable at
// runtime via SetSources so saving new settings from the dashboard takes
// effect immediately, with no master restart needed.
type Registry struct {
	mu      sync.RWMutex
	sources []Source
}

func NewRegistry(sources ...Source) *Registry {
	r := &Registry{}
	r.SetSources(sources...)
	return r
}

// SetSources atomically replaces the whole source list — always called
// with the *complete* set (every configured, enabled connector), never
// incrementally, so a disabled/removed integration actually disappears.
func (r *Registry) SetSources(sources ...Source) {
	filtered := make([]Source, 0, len(sources))
	for _, s := range sources {
		if s != nil {
			filtered = append(filtered, s)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sources = filtered
}

func (r *Registry) SourceNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.sources))
	for _, s := range r.sources {
		names = append(names, s.Name())
	}
	return names
}

func (r *Registry) HasSources() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.sources) > 0
}

// QueryAll queries every configured source for events on this host around
// the given time, merges and sorts the results (oldest first), and
// returns whatever came back. A single source's failure is swallowed
// (not returned as an error) so one misbehaving/unreachable SIEM doesn't
// blank out results from the others — callers that want to know about a
// failure should check logs, not this return value.
func (r *Registry) QueryAll(ctx context.Context, ip, hostname string, around time.Time, window time.Duration) []Event {
	r.mu.RLock()
	sources := append([]Source(nil), r.sources...)
	r.mu.RUnlock()

	all := []Event{} // never nil: encodes to `[]`, not `null`, when empty
	for _, s := range sources {
		events, err := s.Query(ctx, ip, hostname, around, window)
		if err != nil {
			continue
		}
		all = append(all, events...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Timestamp.Before(all[j].Timestamp) })
	return all
}

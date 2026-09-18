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

// Registry holds whichever Sources were actually configured (via env
// vars — see cmd/master/main.go) and fans a correlation request out to
// all of them. A Registry with no sources is valid and simply returns no
// events for every query — the API/frontend treat that as "correlation
// not configured" rather than an error.
type Registry struct {
	sources []Source
}

func NewRegistry(sources ...Source) *Registry {
	var r Registry
	for _, s := range sources {
		if s != nil {
			r.sources = append(r.sources, s)
		}
	}
	return &r
}

func (r *Registry) SourceNames() []string {
	names := make([]string, 0, len(r.sources))
	for _, s := range r.sources {
		names = append(names, s.Name())
	}
	return names
}

func (r *Registry) HasSources() bool {
	return len(r.sources) > 0
}

// QueryAll queries every configured source for events on this host around
// the given time, merges and sorts the results (oldest first), and
// returns whatever came back. A single source's failure is swallowed
// (not returned as an error) so one misbehaving/unreachable SIEM doesn't
// blank out results from the others — callers that want to know about a
// failure should check logs, not this return value.
func (r *Registry) QueryAll(ctx context.Context, ip, hostname string, around time.Time, window time.Duration) []Event {
	all := []Event{} // never nil: encodes to `[]`, not `null`, when empty
	for _, s := range r.sources {
		events, err := s.Query(ctx, ip, hostname, around, window)
		if err != nil {
			continue
		}
		all = append(all, events...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Timestamp.Before(all[j].Timestamp) })
	return all
}

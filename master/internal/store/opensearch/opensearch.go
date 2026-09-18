// Package opensearch stores and queries high-volume AVC denial events.
// Business data (agents, rules, commands) lives in Postgres instead; see
// internal/store/postgres.
package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	opensearch "github.com/opensearch-project/opensearch-go/v2"
	opensearchapi "github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

// legacyIndexName is the single fixed index every AVC event was written to
// before daily rolling indices — kept in every read's index list (never
// written to again) so history collected before that switch stays visible
// instead of silently disappearing from Denials/Matrix/Trend.
const legacyIndexName = "avc_events"

// indexPrefix + a UTC day gives each day's events their own index (e.g.
// avc_events-2026.09.18), matching the retention policy applied by
// EnsureRetentionPolicy below — a fixed index has no natural unit to
// expire, so ISM can only delete whole day-indices, not individual old
// documents.
const indexPrefix = "avc_events-"

// retentionPolicyID/templateName back EnsureRetentionPolicy: an ISM policy
// that deletes a avc_events-* index once it's old enough (and auto-manages
// every new one via its ism_template), plus an index template pinning
// shard/replica counts for them.
const (
	retentionPolicyID = "avc-events-retention"
	templateName      = "avc-events"
)

func dailyIndexName(t time.Time) string {
	return indexPrefix + t.UTC().Format("2006.01.02")
}

// readIndices is every index name/pattern a query should search: the
// legacy fixed index (historical data, no longer written to) plus every
// daily index going forward.
func readIndices() []string {
	return []string{legacyIndexName, indexPrefix + "*"}
}

// ignoreUnavailableIndices is passed by address to every SearchRequest:
// readIndices() names the legacy index unconditionally, but a fresh
// install never creates it (only daily ones exist), so the request must
// tolerate a missing index instead of 404ing.
var ignoreUnavailableIndices = true

type Store struct {
	addr   string
	client *opensearch.Client
}

func Open(addr string) (*Store, error) {
	client, err := opensearch.NewClient(opensearch.Config{
		Addresses: []string{addr},
	})
	if err != nil {
		return nil, fmt.Errorf("open opensearch client: %w", err)
	}
	return &Store{addr: strings.TrimSuffix(addr, "/"), client: client}, nil
}

type AvcEvent struct {
	AgentID  string   `json:"agent_id"`
	TsUnix   int64    `json:"ts_unix"`
	SContext string   `json:"scontext"`
	TContext string   `json:"tcontext"`
	TClass   string   `json:"tclass"`
	Perms    []string `json:"perms"`
	Comm     string   `json:"comm"`
	Path     string   `json:"path"`
	PID      string   `json:"pid"`
	RawLine  string   `json:"raw_line"`
	// IngestedUnix is when the master indexed the event. History counting
	// (internal/history) is done at ingestion for events that carry it, and
	// reconstructed once, from the index, for the older ones that don't —
	// so no event is ever counted twice.
	IngestedUnix int64 `json:"ingested_unix,omitempty"`
	// Sig identifies "the same denial" for resolution purposes: source,
	// target, class, the exact permission set and the path (see Signature).
	// Set when indexing; never sent to the dashboard.
	Sig string `json:"sig,omitempty"`
}

// Signature is the identity under which identical denials are grouped when
// checking with an agent whether they would still be denied — permissions
// as a sorted set and the path included, because both change the answer
// (a relabeled file, a different permission).
func Signature(e AvcEvent) string {
	perms := append([]string(nil), e.Perms...)
	sort.Strings(perms)
	return strings.Join([]string{e.SContext, e.TContext, e.TClass, strings.Join(perms, ","), e.Path}, "|")
}

func (s *Store) IndexAvcEvent(ctx context.Context, e AvcEvent) error {
	e.Sig = Signature(e)
	if e.IngestedUnix == 0 {
		e.IngestedUnix = time.Now().Unix()
	}
	body, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("marshal avc event: %w", err)
	}
	req := opensearchapi.IndexRequest{
		Index: dailyIndexName(time.Unix(e.TsUnix, 0)),
		Body:  bytes.NewReader(body),
	}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return fmt.Errorf("index avc event: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return fmt.Errorf("index avc event: opensearch returned %s", res.Status())
	}
	return nil
}

// AvcEventHit carries the document's own index and id alongside the event —
// quarantining/deleting one denial needs both (each day has its own index).
type AvcEventHit struct {
	ID    string `json:"id"`
	Index string `json:"index"`
	AvcEvent
	Timestamp time.Time `json:"timestamp"`
}

// SearchOptions filters and paginates the denials browser. AgentID is an
// exact match; Query is free text matched against the human-readable
// fields (comm, path, scontext, tcontext, tclass, raw_line).
type SearchOptions struct {
	AgentID string
	Query   string
	From    int
	Size    int
	// Quarantined selects the Quarantine page's events instead of the
	// normal ones: quarantined denials are hidden from every default
	// search/aggregation (see quarantinedField) until restored.
	Quarantined bool
}

// quarantinedField is set to true on an event document to move it to the
// Quarantine page. Documents never written with it simply lack the field, so
// no mapping or migration is needed for existing data.
const quarantinedField = "quarantined"

// resolvedField is set to true on every event of a denial that the agent
// has confirmed would no longer be denied (a rule now allows it, however it
// got there). Hidden from every search/aggregation exactly like quarantined
// events, so the denial and its occurrence counts simply disappear; if the
// rule is removed later and the access is denied again, that produces brand
// new events, which show up normally.
const resolvedField = "resolved"

type SearchResult struct {
	Events []AvcEventHit `json:"events"`
	Total  int           `json:"total"`
}

// Search returns AVC events matching opts, newest first, along with the
// total number of matches (for pagination).
func (s *Store) Search(ctx context.Context, opts SearchOptions) (SearchResult, error) {
	var filters []map[string]any
	if opts.AgentID != "" {
		// agent_id gets OpenSearch's default dynamic mapping (text +
		// keyword sub-field); .keyword is required for an exact-match
		// term query.
		filters = append(filters, map[string]any{
			"term": map[string]any{"agent_id.keyword": opts.AgentID},
		})
	}
	if opts.Query != "" {
		filters = append(filters, map[string]any{
			"multi_match": map[string]any{
				"query":  opts.Query,
				"fields": []string{"comm", "path", "scontext", "tcontext", "tclass", "raw_line"},
			},
		})
	}

	quarantinedTerm := map[string]any{"term": map[string]any{quarantinedField: true}}
	resolvedTerm := map[string]any{"term": map[string]any{resolvedField: true}}
	boolClause := map[string]any{}
	if opts.Quarantined {
		filters = append(filters, quarantinedTerm)
		boolClause["must_not"] = []map[string]any{resolvedTerm}
	} else {
		boolClause["must_not"] = []map[string]any{quarantinedTerm, resolvedTerm}
	}
	boolClause["filter"] = filters
	boolQuery := map[string]any{"bool": boolClause}

	query := map[string]any{
		"query": boolQuery,
		"sort":  []map[string]any{{"ts_unix": "desc"}},
		"from":  opts.From,
		"size":  opts.Size,
	}
	body, err := json.Marshal(query)
	if err != nil {
		return SearchResult{}, fmt.Errorf("marshal search query: %w", err)
	}

	req := opensearchapi.SearchRequest{
		Index: readIndices(),
		Body:  bytes.NewReader(body),
		// OpenSearch stops counting at 10000 unless told otherwise, which
		// made the Denials page claim "1-25 of 10000" whatever the real
		// number (a single noisy host reaches that within minutes).
		TrackTotalHits: true,
		// A fresh install has no legacy avc_events index at all (only
		// daily ones start existing); without this, searching the fixed
		// list [avc_events, avc_events-*] 404s outright instead of just
		// matching whichever of the two actually exist.
		IgnoreUnavailable: &ignoreUnavailableIndices,
	}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return SearchResult{}, fmt.Errorf("search avc events: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		if res.StatusCode == 404 || strings.Contains(res.String(), "index_not_found_exception") {
			return SearchResult{}, nil
		}
		return SearchResult{}, fmt.Errorf("search avc events: opensearch returned %s", res.Status())
	}

	var parsed struct {
		Hits struct {
			Total struct {
				Value int `json:"value"`
			} `json:"total"`
			Hits []struct {
				ID     string   `json:"_id"`
				Index  string   `json:"_index"`
				Source AvcEvent `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return SearchResult{}, fmt.Errorf("decode search response: %w", err)
	}

	events := make([]AvcEventHit, 0, len(parsed.Hits.Hits))
	for _, h := range parsed.Hits.Hits {
		events = append(events, AvcEventHit{
			ID:        h.ID,
			Index:     h.Index,
			AvcEvent:  h.Source,
			Timestamp: time.Unix(h.Source.TsUnix, 0).UTC(),
		})
	}
	return SearchResult{Events: events, Total: parsed.Hits.Total.Value}, nil
}

var (
	// ErrEventNotFound: no event document has the given index/id.
	ErrEventNotFound = errors.New("denial not found")
	// ErrInvalidEventRef: index/id don't look like an AVC event document —
	// rejected up front so a caller can't point quarantine/delete at some
	// other index in the cluster (e.g. ISM's config index) or inject a path.
	ErrInvalidEventRef = errors.New("invalid denial reference")

	avcIndexRe = regexp.MustCompile(`^avc_events(-\d{4}\.\d{2}\.\d{2})?$`)
	eventIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

func validateEventRef(index, id string) error {
	if !avcIndexRe.MatchString(index) || !eventIDRe.MatchString(id) {
		return ErrInvalidEventRef
	}
	return nil
}

// SetQuarantined moves one denial to (true) or back from (false) the
// Quarantine page. Refreshes immediately so the page it was just acted on
// reflects the change on the very next fetch.
func (s *Store) SetQuarantined(ctx context.Context, index, id string, quarantined bool) error {
	if err := validateEventRef(index, id); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"doc": map[string]any{quarantinedField: quarantined}})
	if err != nil {
		return fmt.Errorf("marshal quarantine update: %w", err)
	}
	req := opensearchapi.UpdateRequest{Index: index, DocumentID: id, Body: bytes.NewReader(body), Refresh: "true"}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return fmt.Errorf("quarantine denial: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return ErrEventNotFound
	}
	if res.IsError() {
		return fmt.Errorf("quarantine denial: opensearch returned %s", res.Status())
	}
	return nil
}

// DeleteEvent permanently removes one denial document.
func (s *Store) DeleteEvent(ctx context.Context, index, id string) error {
	if err := validateEventRef(index, id); err != nil {
		return err
	}
	req := opensearchapi.DeleteRequest{Index: index, DocumentID: id, Refresh: "true"}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return fmt.Errorf("delete denial: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return ErrEventNotFound
	}
	if res.IsError() {
		return fmt.Errorf("delete denial: opensearch returned %s", res.Status())
	}
	return nil
}

// runAggregation POSTs body to _search and decodes the raw aggregations
// object into out — shared by Matrix and Trend below, which each define
// their own concrete shape for it. Treats a missing index (no AVC events
// indexed yet) as "no results" rather than an error, same as Search.
func (s *Store) runAggregation(ctx context.Context, body map[string]any, out any) error {
	// Quarantined and resolved denials are hidden from analytics too, not
	// just the list.
	body["query"] = map[string]any{"bool": map[string]any{
		"must": []any{body["query"]},
		"must_not": []map[string]any{
			{"term": map[string]any{quarantinedField: true}},
			{"term": map[string]any{resolvedField: true}},
		},
	}}
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal aggregation query: %w", err)
	}
	req := opensearchapi.SearchRequest{
		Index:             readIndices(),
		Body:              bytes.NewReader(encoded),
		IgnoreUnavailable: &ignoreUnavailableIndices,
	}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return fmt.Errorf("run aggregation: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		if res.StatusCode == 404 || strings.Contains(res.String(), "index_not_found_exception") {
			return nil
		}
		return fmt.Errorf("run aggregation: opensearch returned %s", res.Status())
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("read aggregation response: %w", err)
	}
	// OpenSearch answers 200 even when some shards failed (e.g. an
	// aggregation on a field mapped differently in one index) and simply
	// leaves those shards' data out — which would read as "nothing found".
	// Fail loudly instead of returning silently incomplete numbers.
	var shards struct {
		Shards struct {
			Failed   int `json:"failed"`
			Failures []struct {
				Reason struct {
					Reason string `json:"reason"`
				} `json:"reason"`
			} `json:"failures"`
		} `json:"_shards"`
	}
	if err := json.Unmarshal(raw, &shards); err == nil && shards.Shards.Failed > 0 {
		reason := "unknown"
		if len(shards.Shards.Failures) > 0 {
			reason = shards.Shards.Failures[0].Reason.Reason
		}
		return fmt.Errorf("run aggregation: %d shard(s) failed: %s", shards.Shards.Failed, reason)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode aggregation response: %w", err)
	}
	return nil
}

// MatrixRow is one (scontext, tcontext, tclass) signature observed across
// the fleet in the queried window, with which agents hit it — the point
// being to spot at a glance whether a denial is isolated to one host
// (probably a one-off, host-specific issue) or spans several (a sign a
// policy/boolean change is needed fleet-wide rather than per host).
type MatrixRow struct {
	SContext   string   `json:"scontext"`
	TContext   string   `json:"tcontext"`
	TClass     string   `json:"tclass"`
	Perms      []string `json:"perms"`
	Count      int      `json:"count"`
	AgentCount int      `json:"agent_count"`
	Agents     []string `json:"agents"`
}

type MatrixOptions struct {
	SinceUnix int64 // 0 means no time filter (all history)
	Limit     int   // 0 means the default below
	// ByCount orders by raw occurrence count instead of by how many
	// distinct agents hit the signature (the dashboard's "most frequent
	// signatures" wants the former).
	ByCount bool
}

func matrixOrder(byCount bool) map[string]any {
	if byCount {
		return map[string]any{"_count": "desc"}
	}
	return map[string]any{"agent_count": "desc"}
}

// Matrix aggregates AVC events into MatrixRows, ordered by how many
// distinct agents hit each signature (descending) — the rows most worth a
// fleet-wide policy fix sort first, regardless of raw occurrence count.
func (s *Store) Matrix(ctx context.Context, opts MatrixOptions) ([]MatrixRow, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}

	query := any(map[string]any{"match_all": map[string]any{}})
	if opts.SinceUnix > 0 {
		query = map[string]any{"range": map[string]any{"ts_unix": map[string]any{"gte": opts.SinceUnix}}}
	}

	body := map[string]any{
		"size":  0,
		"query": query,
		"aggs": map[string]any{
			"matrix": map[string]any{
				"multi_terms": map[string]any{
					"terms": []map[string]any{
						{"field": "scontext.keyword"},
						{"field": "tcontext.keyword"},
						{"field": "tclass.keyword"},
					},
					"size":  limit,
					"order": matrixOrder(opts.ByCount),
				},
				"aggs": map[string]any{
					"agent_count": map[string]any{"cardinality": map[string]any{"field": "agent_id.keyword"}},
					"agents":      map[string]any{"terms": map[string]any{"field": "agent_id.keyword", "size": 50}},
					"perms":       map[string]any{"terms": map[string]any{"field": "perms.keyword", "size": 20}},
				},
			},
		},
	}

	var parsed struct {
		Aggregations struct {
			Matrix struct {
				Buckets []struct {
					Key        []string `json:"key"`
					DocCount   int      `json:"doc_count"`
					AgentCount struct {
						Value int `json:"value"`
					} `json:"agent_count"`
					Agents struct {
						Buckets []struct {
							Key string `json:"key"`
						} `json:"buckets"`
					} `json:"agents"`
					Perms struct {
						Buckets []struct {
							Key string `json:"key"`
						} `json:"buckets"`
					} `json:"perms"`
				} `json:"buckets"`
			} `json:"matrix"`
		} `json:"aggregations"`
	}
	if err := s.runAggregation(ctx, body, &parsed); err != nil {
		return nil, err
	}

	rows := make([]MatrixRow, 0, len(parsed.Aggregations.Matrix.Buckets))
	for _, b := range parsed.Aggregations.Matrix.Buckets {
		if len(b.Key) != 3 {
			continue
		}
		agents := make([]string, 0, len(b.Agents.Buckets))
		for _, a := range b.Agents.Buckets {
			agents = append(agents, a.Key)
		}
		perms := make([]string, 0, len(b.Perms.Buckets))
		for _, p := range b.Perms.Buckets {
			perms = append(perms, p.Key)
		}
		rows = append(rows, MatrixRow{
			SContext:   b.Key[0],
			TContext:   b.Key[1],
			TClass:     b.Key[2],
			Perms:      perms,
			Count:      b.DocCount,
			AgentCount: b.AgentCount.Value,
			Agents:     agents,
		})
	}
	return rows, nil
}

// TrendPoint is one agent's denial count for one UTC day — enough to plot
// a per-host sparkline and spot a regression (a sudden jump right after a
// policy/boolean change went out, for instance).
type TrendPoint struct {
	AgentID string `json:"agent_id"`
	DayUnix int64  `json:"day_unix"`
	Count   int    `json:"count"`
}

type TrendOptions struct {
	SinceUnix int64  // start of the window (inclusive)
	UntilUnix int64  // end of the window (inclusive) — defaults to now if 0
	AgentID   string // "" means all agents
}

const daySeconds = 86400

// Trend returns one TrendPoint per (agent, day) in [SinceUnix, UntilUnix],
// including zero-count days — callers need those to tell "no data yet"
// apart from "a gap", and to render a fixed-width sparkline.
func (s *Store) Trend(ctx context.Context, opts TrendOptions) ([]TrendPoint, error) {
	since := opts.SinceUnix
	until := opts.UntilUnix
	if until == 0 {
		until = time.Now().Unix()
	}

	var filters []map[string]any
	filters = append(filters, map[string]any{"range": map[string]any{"ts_unix": map[string]any{"gte": since, "lte": until}}})
	if opts.AgentID != "" {
		filters = append(filters, map[string]any{"term": map[string]any{"agent_id.keyword": opts.AgentID}})
	}

	body := map[string]any{
		"size":  0,
		"query": map[string]any{"bool": map[string]any{"filter": filters}},
		"aggs": map[string]any{
			"by_agent": map[string]any{
				"terms": map[string]any{"field": "agent_id.keyword", "size": 50},
				"aggs": map[string]any{
					"by_day": map[string]any{
						"histogram": map[string]any{
							"field":           "ts_unix",
							"interval":        daySeconds,
							"min_doc_count":   0,
							"extended_bounds": map[string]any{"min": since, "max": until},
						},
					},
				},
			},
		},
	}

	var parsed struct {
		Aggregations struct {
			ByAgent struct {
				Buckets []struct {
					Key   string `json:"key"`
					ByDay struct {
						Buckets []struct {
							Key      float64 `json:"key"`
							DocCount int     `json:"doc_count"`
						} `json:"buckets"`
					} `json:"by_day"`
				} `json:"buckets"`
			} `json:"by_agent"`
		} `json:"aggregations"`
	}
	if err := s.runAggregation(ctx, body, &parsed); err != nil {
		return nil, err
	}

	points := []TrendPoint{} // never nil: encodes to `[]`, not `null`, when empty
	for _, agentBucket := range parsed.Aggregations.ByAgent.Buckets {
		for _, dayBucket := range agentBucket.ByDay.Buckets {
			points = append(points, TrendPoint{
				AgentID: agentBucket.Key,
				DayUnix: int64(dayBucket.Key),
				Count:   dayBucket.DocCount,
			})
		}
	}
	return points, nil
}

// EnsureRetentionPolicy makes sure every avc_events-* daily index gets
// deleted once it's older than retentionDays, without any per-day cleanup
// job: an Index State Management (ISM) policy does the actual deleting,
// and its ism_template makes ISM pick up each new daily index on its own
// periodic coordinator sweep (10 minutes, and only for indices at least
// 5 minutes old, by default) — nothing here needs to poll or schedule
// that itself.
//
// Idempotent and safe to call on every master startup: the template PUT
// always replaces cleanly, and the policy PUT (which OpenSearch protects
// with optimistic-concurrency versioning) falls back to a GET-then-PUT
// cycle so a changed retentionDays value takes effect on restart instead
// of being silently ignored after the first boot.
func (s *Store) EnsureRetentionPolicy(ctx context.Context, retentionDays int) error {
	if retentionDays <= 0 {
		return fmt.Errorf("retention days must be positive, got %d", retentionDays)
	}

	policy := map[string]any{
		"policy": map[string]any{
			"description":   "Delete avc_events-* daily indices once they exceed the configured retention window.",
			"default_state": "hot",
			"states": []map[string]any{
				{
					"name":    "hot",
					"actions": []any{},
					"transitions": []map[string]any{
						{
							"state_name": "delete",
							"conditions": map[string]any{"min_index_age": fmt.Sprintf("%dd", retentionDays)},
						},
					},
				},
				{
					"name":        "delete",
					"actions":     []map[string]any{{"delete": map[string]any{}}},
					"transitions": []any{},
				},
			},
			// ism_template is what ISM's coordinator actually keys off to
			// auto-manage new indices by name pattern. A policy_id index
			// setting alone (tried first, via the index template) is NOT
			// picked up by that sweep — found live: a fresh daily index
			// stayed unmanaged indefinitely.
			"ism_template": []map[string]any{
				{
					"index_patterns": []string{indexPrefix + "*"},
					"priority":       100,
				},
			},
		},
	}
	if err := s.putISMPolicy(ctx, policy); err != nil {
		return fmt.Errorf("apply ism policy: %w", err)
	}

	template := map[string]any{
		"index_patterns": []string{indexPrefix + "*"},
		"template": map[string]any{
			"settings": map[string]any{
				// Single-node cluster (see docker-compose.yml): a replica
				// here would just sit permanently unassigned and keep
				// cluster health stuck at yellow.
				"number_of_shards":   1,
				"number_of_replicas": 0,
			},
			// Only the fields this package writes/filters on itself; every
			// other field keeps OpenSearch's default dynamic mapping (which
			// the .keyword lookups elsewhere depend on).
			"mappings": map[string]any{
				"properties": map[string]any{
					// text + keyword sub-field: the same shape dynamic mapping
					// gives it in an index created before this template
					// existed, so one query (sig.keyword) works on both.
					"sig": map[string]any{
						"type":   "text",
						"fields": map[string]any{"keyword": map[string]any{"type": "keyword", "ignore_above": 2048}},
					},
					"quarantined": map[string]any{"type": "boolean"},
					"resolved":    map[string]any{"type": "boolean"},
					"resolved_at": map[string]any{"type": "long"},
				},
			},
		},
	}
	if err := s.sendJSON(ctx, http.MethodPut, "/_index_template/"+templateName, template, nil); err != nil {
		return fmt.Errorf("apply index template: %w", err)
	}

	// ism_template only matches indices created AFTER the policy's last
	// update, and this function rewrites the policy on every boot — so a
	// daily index created shortly before a restart (or before the policy
	// first existed) would never be picked up on its own. Attach the policy
	// explicitly to whatever avc_events-* indices already exist; ISM skips
	// the ones it already manages (reported as "failed", which is fine).
	// The legacy fixed avc_events index deliberately doesn't match this
	// pattern: its history is never expired automatically.
	attach := map[string]any{"policy_id": retentionPolicyID}
	if err := s.sendJSON(ctx, http.MethodPost, "/_plugins/_ism/add/"+indexPrefix+"*", attach, nil); err != nil {
		var statusErr *httpStatusError
		// No daily index exists yet (fresh install): nothing to attach to.
		if !errors.As(err, &statusErr) || statusErr.status != http.StatusNotFound {
			return fmt.Errorf("attach retention policy to existing indices: %w", err)
		}
	}
	return nil
}

// putISMPolicy PUTs the retention policy, retrying once with the current
// document's seq_no/primary_term on a version conflict (i.e. the policy
// already exists from a previous boot and this one changed retentionDays).
func (s *Store) putISMPolicy(ctx context.Context, policy map[string]any) error {
	path := "/_plugins/_ism/policies/" + retentionPolicyID
	err := s.sendJSON(ctx, http.MethodPut, path, policy, nil)
	if err == nil {
		return nil
	}
	var conflict *httpStatusError
	if !errors.As(err, &conflict) || conflict.status != http.StatusConflict {
		return err
	}

	var existing struct {
		SeqNo       int64 `json:"_seq_no"`
		PrimaryTerm int64 `json:"_primary_term"`
	}
	if getErr := s.getJSON(ctx, path, &existing); getErr != nil {
		return fmt.Errorf("re-fetch existing policy after conflict: %w", getErr)
	}
	query := map[string]string{
		"if_seq_no":       fmt.Sprintf("%d", existing.SeqNo),
		"if_primary_term": fmt.Sprintf("%d", existing.PrimaryTerm),
	}
	return s.sendJSON(ctx, http.MethodPut, path, policy, query)
}

type httpStatusError struct {
	status int
	body   string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("opensearch returned %d: %s", e.status, e.body)
}

func (s *Store) sendJSON(ctx context.Context, method, path string, body map[string]any, query map[string]string) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal request body: %w", err)
	}
	url := s.addr + path
	if len(query) > 0 {
		q := make([]string, 0, len(query))
		for k, v := range query {
			q = append(q, k+"="+v)
		}
		url += "?" + strings.Join(q, "&")
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return &httpStatusError{status: res.StatusCode, body: strings.TrimSpace(string(respBody))}
	}
	return nil
}

func (s *Store) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.addr+path, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return &httpStatusError{status: res.StatusCode, body: strings.TrimSpace(string(respBody))}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

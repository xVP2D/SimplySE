// Package opensearch stores and queries high-volume AVC denial events.
// Business data (agents, rules, commands) lives in Postgres instead; see
// internal/store/postgres.
package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	opensearch "github.com/opensearch-project/opensearch-go/v2"
	opensearchapi "github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

const indexName = "avc_events"

type Store struct {
	client *opensearch.Client
}

func Open(addr string) (*Store, error) {
	client, err := opensearch.NewClient(opensearch.Config{
		Addresses: []string{addr},
	})
	if err != nil {
		return nil, fmt.Errorf("open opensearch client: %w", err)
	}
	return &Store{client: client}, nil
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
}

func (s *Store) IndexAvcEvent(ctx context.Context, e AvcEvent) error {
	body, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("marshal avc event: %w", err)
	}
	req := opensearchapi.IndexRequest{
		Index: indexName,
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

type AvcEventHit struct {
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
}

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

	boolQuery := map[string]any{"match_all": map[string]any{}}
	if len(filters) > 0 {
		boolQuery = map[string]any{"bool": map[string]any{"filter": filters}}
	}

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
		Index: []string{indexName},
		Body:  bytes.NewReader(body),
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
			AvcEvent:  h.Source,
			Timestamp: time.Unix(h.Source.TsUnix, 0).UTC(),
		})
	}
	return SearchResult{Events: events, Total: parsed.Hits.Total.Value}, nil
}

// runAggregation POSTs body to _search and decodes the raw aggregations
// object into out — shared by Matrix and Trend below, which each define
// their own concrete shape for it. Treats a missing index (no AVC events
// indexed yet) as "no results" rather than an error, same as Search.
func (s *Store) runAggregation(ctx context.Context, body map[string]any, out any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal aggregation query: %w", err)
	}
	req := opensearchapi.SearchRequest{
		Index: []string{indexName},
		Body:  bytes.NewReader(encoded),
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
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
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
					"order": map[string]any{"agent_count": "desc"},
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

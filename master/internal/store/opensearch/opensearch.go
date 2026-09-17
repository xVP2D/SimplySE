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

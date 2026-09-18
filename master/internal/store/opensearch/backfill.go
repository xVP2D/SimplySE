package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"

	"github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

// HourlyDenialCount is a number of denials seen for one signature in one UTC
// hour on one agent.
type HourlyDenialCount struct {
	HourUnix int64
	AgentID  string
	SContext string
	TContext string
	TClass   string
	Perms    string // sorted, comma-joined
	Count    int64
}

// PermsFromSig extracts the permission set from an event signature
// ("scontext|tcontext|tclass|perms|path", see Signature). The path is last
// and may itself contain the separator, hence SplitN.
func PermsFromSig(sig string) string {
	parts := strings.SplitN(sig, "|", 5)
	if len(parts) < 4 {
		return ""
	}
	return parts[3]
}

// PreHistoryDenialCounts counts, per hour, agent and signature, every event
// that was indexed before history counting existed — that is, documents
// without ingested_unix. Unlike the dashboard's aggregations it deliberately
// includes resolved and quarantined events: they did happen, and the history
// is meant to survive exactly that. Deleted events and indices already
// purged by retention are gone and cannot be recovered.
func (s *Store) PreHistoryDenialCounts(ctx context.Context) ([]HourlyDenialCount, error) {
	type key struct {
		hour                        int64
		agent, sctx, tctx, tc, prms string
	}
	sums := map[key]int64{}

	var after map[string]any
	for {
		composite := map[string]any{
			"size": 1000,
			"sources": []map[string]any{
				{"hour": map[string]any{"histogram": map[string]any{"field": "ts_unix", "interval": 3600}}},
				{"agent": map[string]any{"terms": map[string]any{"field": "agent_id.keyword"}}},
				{"sctx": map[string]any{"terms": map[string]any{"field": "scontext.keyword", "missing_bucket": true}}},
				{"tctx": map[string]any{"terms": map[string]any{"field": "tcontext.keyword", "missing_bucket": true}}},
				{"tclass": map[string]any{"terms": map[string]any{"field": "tclass.keyword", "missing_bucket": true}}},
				{"sig": map[string]any{"terms": map[string]any{"field": "sig.keyword", "missing_bucket": true}}},
			},
		}
		if after != nil {
			composite["after"] = after
		}
		body := map[string]any{
			"size": 0,
			"query": map[string]any{"bool": map[string]any{
				"must_not": []map[string]any{{"exists": map[string]any{"field": "ingested_unix"}}},
			}},
			"aggs": map[string]any{"c": map[string]any{"composite": composite}},
		}
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal backfill query: %w", err)
		}
		req := opensearchapi.SearchRequest{
			Index:             readIndices(),
			Body:              bytes.NewReader(encoded),
			IgnoreUnavailable: &ignoreUnavailableIndices,
		}
		res, err := req.Do(ctx, s.client)
		if err != nil {
			return nil, fmt.Errorf("run backfill aggregation: %w", err)
		}
		raw, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read backfill response: %w", readErr)
		}
		if res.IsError() {
			if res.StatusCode == 404 || strings.Contains(string(raw), "index_not_found_exception") {
				return nil, nil // nothing indexed yet
			}
			return nil, fmt.Errorf("run backfill aggregation: opensearch returned %s", res.Status())
		}
		var parsed struct {
			Shards struct {
				Failed int `json:"failed"`
			} `json:"_shards"`
			Aggregations struct {
				C struct {
					AfterKey map[string]any `json:"after_key"`
					Buckets  []struct {
						Key      map[string]any `json:"key"`
						DocCount int64          `json:"doc_count"`
					} `json:"buckets"`
				} `json:"c"`
			} `json:"aggregations"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, fmt.Errorf("decode backfill response: %w", err)
		}
		if parsed.Shards.Failed > 0 {
			return nil, fmt.Errorf("run backfill aggregation: %d shard(s) failed", parsed.Shards.Failed)
		}
		str := func(v any) string {
			s, _ := v.(string)
			return s
		}
		for _, b := range parsed.Aggregations.C.Buckets {
			hour, _ := b.Key["hour"].(float64)
			k := key{
				hour:  int64(math.Round(hour)),
				agent: str(b.Key["agent"]),
				sctx:  str(b.Key["sctx"]),
				tctx:  str(b.Key["tctx"]),
				tc:    str(b.Key["tclass"]),
				prms:  PermsFromSig(str(b.Key["sig"])),
			}
			sums[k] += b.DocCount
		}
		if len(parsed.Aggregations.C.Buckets) == 0 || parsed.Aggregations.C.AfterKey == nil {
			break
		}
		after = parsed.Aggregations.C.AfterKey
	}

	out := make([]HourlyDenialCount, 0, len(sums))
	for k, n := range sums {
		out = append(out, HourlyDenialCount{
			HourUnix: k.hour, AgentID: k.agent, SContext: k.sctx, TContext: k.tctx, TClass: k.tc, Perms: k.prms, Count: n,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HourUnix < out[j].HourUnix })
	return out, nil
}

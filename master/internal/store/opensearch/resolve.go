package opensearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	opensearchapi "github.com/opensearch-project/opensearch-go/v2/opensearchapi"
)

// Probe is one distinct denial an agent should be asked about ("would this
// still be denied?"): everything needed to re-evaluate it, plus Sig, its
// identity — the same string comes back in the agent's verdict and is what
// MarkResolved matches on.
type Probe struct {
	AgentID  string
	Sig      string
	SContext string
	TContext string
	TClass   string
	Perms    []string
	Path     string
}

// UnresolvedProbes returns, per agent, up to perAgent distinct unresolved
// denials, most recently seen first, so a fresh denial is checked before
// old stragglers. agentID == "" covers every agent in one query (one
// aggregation per sweep instead of one per agent). Quarantined denials are
// left alone: the operator already set them aside.
func (s *Store) UnresolvedProbes(ctx context.Context, agentID string, perAgent int) (map[string][]Probe, error) {
	filter := []map[string]any{{"exists": map[string]any{"field": "sig"}}}
	if agentID != "" {
		filter = append(filter, map[string]any{"term": map[string]any{"agent_id.keyword": agentID}})
	}
	body := map[string]any{
		"size": 0,
		"query": map[string]any{"bool": map[string]any{
			"filter": filter,
			"must_not": []map[string]any{
				{"term": map[string]any{quarantinedField: true}},
				{"term": map[string]any{resolvedField: true}},
			},
		}},
		"aggs": map[string]any{
			"agents": map[string]any{
				"terms": map[string]any{"field": "agent_id.keyword", "size": 1000},
				"aggs": map[string]any{
					"sigs": map[string]any{
						"terms": map[string]any{"field": "sig", "size": perAgent, "order": map[string]any{"latest": "desc"}},
						"aggs": map[string]any{
							"latest": map[string]any{"max": map[string]any{"field": "ts_unix"}},
							"sample": map[string]any{"top_hits": map[string]any{
								"size":    1,
								"_source": []string{"scontext", "tcontext", "tclass", "perms", "path"},
							}},
						},
					},
				},
			},
		},
	}

	var parsed struct {
		Aggregations struct {
			Agents struct {
				Buckets []struct {
					Key  string `json:"key"`
					Sigs struct {
						Buckets []struct {
							Key    string `json:"key"`
							Sample struct {
								Hits struct {
									Hits []struct {
										Source AvcEvent `json:"_source"`
									} `json:"hits"`
								} `json:"hits"`
							} `json:"sample"`
						} `json:"buckets"`
					} `json:"sigs"`
				} `json:"buckets"`
			} `json:"agents"`
		} `json:"aggregations"`
	}
	if err := s.runAggregation(ctx, body, &parsed); err != nil {
		return nil, err
	}

	out := map[string][]Probe{}
	for _, agent := range parsed.Aggregations.Agents.Buckets {
		for _, sig := range agent.Sigs.Buckets {
			if len(sig.Sample.Hits.Hits) == 0 {
				continue
			}
			e := sig.Sample.Hits.Hits[0].Source
			out[agent.Key] = append(out[agent.Key], Probe{
				AgentID: agent.Key, Sig: sig.Key,
				SContext: e.SContext, TContext: e.TContext, TClass: e.TClass, Perms: e.Perms, Path: e.Path,
			})
		}
	}
	return out, nil
}

// MarkResolved flags every event of agentID with this signature as resolved,
// which hides them (and their occurrence counts) everywhere — see
// resolvedField. Returns how many events were flagged.
func (s *Store) MarkResolved(ctx context.Context, agentID, sig string) (int64, error) {
	body, err := json.Marshal(map[string]any{
		"query": map[string]any{"bool": map[string]any{"filter": []map[string]any{
			{"term": map[string]any{"agent_id.keyword": agentID}},
			{"term": map[string]any{"sig": sig}},
		}}},
		"script": map[string]any{
			"lang":   "painless",
			"source": "ctx._source.resolved = true; ctx._source.resolved_at = params.now",
			"params": map[string]any{"now": time.Now().Unix()},
		},
	})
	if err != nil {
		return 0, fmt.Errorf("marshal resolve update: %w", err)
	}
	refresh := true
	req := opensearchapi.UpdateByQueryRequest{
		Index:             readIndices(),
		Body:              bytes.NewReader(body),
		Conflicts:         "proceed",
		Refresh:           &refresh,
		IgnoreUnavailable: &ignoreUnavailableIndices,
	}
	res, err := req.Do(ctx, s.client)
	if err != nil {
		return 0, fmt.Errorf("mark denials resolved: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return 0, fmt.Errorf("mark denials resolved: opensearch returned %s", res.Status())
	}
	var parsed struct {
		Updated int64 `json:"updated"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return 0, fmt.Errorf("decode update-by-query response: %w", err)
	}
	return parsed.Updated, nil
}

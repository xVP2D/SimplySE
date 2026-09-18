package correlate

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OpenSearchSource queries any OpenSearch/Elasticsearch-compatible index
// for events on one host in a time window — this is the connector that
// actually reaches Wazuh (its indexer has been OpenSearch/Elasticsearch
// since Wazuh 4.x) and, just as well, a standalone Suricata deployment
// whose eve.json is shipped into an ELK-family stack, without writing a
// bespoke client for either: point it at whichever index holds the
// events and whichever field identifies the host, and the same code
// works for both. Nothing it reads is written back into this master's
// own OpenSearch — see package doc.
type OpenSearchSource struct {
	name      string // distinguishes multiple instances of this connector in the UI, e.g. "wazuh", "suricata"
	baseURL   string
	index     string // e.g. "wazuh-alerts-*" or "suricata-*"
	hostField string // e.g. "agent.ip", "src_ip" — matched against the agent's IP
	user      string
	password  string
	client    *http.Client
}

// OpenSearchSourceConfig doubles as the wire/storage format for this
// connector's settings (see internal/api/integrations.go) — Password is
// only ever populated on a save request, and the API layer is
// responsible for never echoing it back in a GET response.
type OpenSearchSourceConfig struct {
	Name               string `json:"name"`
	BaseURL            string `json:"url"`
	Index              string `json:"index"`
	HostField          string `json:"host_field"`
	User               string `json:"user"`
	Password           string `json:"password,omitempty"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify"` // self-signed certs are the norm for these stacks in the wild; opt-in only
}

func NewOpenSearchSource(cfg OpenSearchSourceConfig) *OpenSearchSource {
	transport := &http.Transport{}
	if cfg.InsecureSkipVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit opt-in, see field doc
	}
	hostField := cfg.HostField
	if hostField == "" {
		hostField = "agent.ip"
	}
	return &OpenSearchSource{
		name:      cfg.Name,
		baseURL:   strings.TrimSuffix(cfg.BaseURL, "/"),
		index:     cfg.Index,
		hostField: hostField,
		user:      cfg.User,
		password:  cfg.Password,
		client:    &http.Client{Timeout: 8 * time.Second, Transport: transport},
	}
}

func (s *OpenSearchSource) Name() string { return s.name }

// Ping runs a trivial, cheap query (match_all, size 0) against the
// configured index — enough to confirm the URL is reachable, TLS/auth
// succeed, and the index actually exists, without pulling any real data.
// Used by the "test connection" button on the integrations settings page.
func (s *OpenSearchSource) Ping(ctx context.Context) error {
	if s.baseURL == "" {
		return fmt.Errorf("url is required")
	}
	if s.index == "" {
		return fmt.Errorf("index is required")
	}
	body, err := json.Marshal(map[string]any{"size": 0, "query": map[string]any{"match_all": map[string]any{}}})
	if err != nil {
		return fmt.Errorf("marshal query: %w", err)
	}
	url := fmt.Sprintf("%s/%s/_search", s.baseURL, s.index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.user != "" {
		req.SetBasicAuth(s.user, s.password)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		respBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("unexpected status %s: %s", res.Status, strings.TrimSpace(string(respBody)))
	}
	return nil
}

func (s *OpenSearchSource) Query(ctx context.Context, ip, hostname string, around time.Time, window time.Duration) ([]Event, error) {
	if s.baseURL == "" || s.index == "" || ip == "" {
		return nil, nil
	}

	body := map[string]any{
		"size": 50,
		"sort": []map[string]any{{"@timestamp": "asc"}},
		"query": map[string]any{
			"bool": map[string]any{
				"filter": []map[string]any{
					{"term": map[string]any{s.hostField: ip}},
					{"range": map[string]any{
						"@timestamp": map[string]any{
							"gte": around.Add(-window).Format(time.RFC3339),
							"lte": around.Add(window).Format(time.RFC3339),
						},
					}},
				},
			},
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal query: %w", err)
	}

	url := fmt.Sprintf("%s/%s/_search", s.baseURL, s.index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.user != "" {
		req.SetBasicAuth(s.user, s.password)
	}

	res, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", s.name, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("query %s: unexpected status %s", s.name, res.Status)
	}

	var parsed struct {
		Hits struct {
			Hits []struct {
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode %s response: %w", s.name, err)
	}

	events := make([]Event, 0, len(parsed.Hits.Hits))
	for _, hit := range parsed.Hits.Hits {
		var doc map[string]any
		if err := json.Unmarshal(hit.Source, &doc); err != nil {
			continue
		}
		ts, ok := parseTimestamp(doc["@timestamp"])
		if !ok {
			ts = around
		}
		events = append(events, Event{
			Source:    s.name,
			Timestamp: ts,
			Severity:  summarizeSeverity(doc),
			Summary:   summarizeMessage(doc),
			Raw:       string(hit.Source),
		})
	}
	return events, nil
}

func parseTimestamp(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, time.RFC3339Nano, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// summarizeMessage picks whichever common field this document has, in
// order of preference — different products (Wazuh's rule.description,
// Suricata's alert.signature, plain ECS' message) name it differently,
// and this connector is meant to work with any of them without
// per-product code.
func summarizeMessage(doc map[string]any) string {
	for _, path := range [][]string{
		{"rule", "description"}, // Wazuh
		{"alert", "signature"},  // Suricata (eve.json)
		{"message"},             // plain ECS / most others
		{"full_log"},            // Wazuh raw log fallback
	} {
		if v, ok := digString(doc, path); ok && v != "" {
			return v
		}
	}
	return "(no summary field found)"
}

func summarizeSeverity(doc map[string]any) string {
	for _, path := range [][]string{
		{"rule", "level"},     // Wazuh: 0-15 numeric
		{"alert", "severity"}, // Suricata: 1-3 numeric (1 = highest)
		{"event", "severity"}, // ECS
	} {
		if v, ok := digString(doc, path); ok && v != "" {
			return v
		}
	}
	return ""
}

func digString(doc map[string]any, path []string) (string, bool) {
	var cur any = doc
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur, ok = m[key]
		if !ok {
			return "", false
		}
	}
	switch v := cur.(type) {
	case string:
		return v, true
	case float64:
		return fmt.Sprintf("%g", v), true
	default:
		return "", false
	}
}

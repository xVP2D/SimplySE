package correlate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// LibreNMSSource queries a LibreNMS instance's alert log for a given
// device (matched by hostname, which is how LibreNMS itself identifies
// polled devices) and filters to the requested time window client-side —
// LibreNMS's /alerts endpoint doesn't offer a documented time-range query
// param stable enough across versions to rely on, but returns a bounded,
// already-sorted-by-recency list that's cheap to filter locally.
type LibreNMSSource struct {
	baseURL string
	token   string
	client  *http.Client
}

type LibreNMSSourceConfig struct {
	BaseURL string
	Token   string
}

func NewLibreNMSSource(cfg LibreNMSSourceConfig) *LibreNMSSource {
	return &LibreNMSSource{
		baseURL: strings.TrimSuffix(cfg.BaseURL, "/"),
		token:   cfg.Token,
		client:  &http.Client{Timeout: 8 * time.Second},
	}
}

func (s *LibreNMSSource) Name() string { return "librenms" }

func (s *LibreNMSSource) Query(ctx context.Context, ip, hostname string, around time.Time, window time.Duration) ([]Event, error) {
	if s.baseURL == "" || s.token == "" || hostname == "" {
		return nil, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.baseURL+"/api/v0/alerts", nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Auth-Token", s.token)

	res, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query librenms: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("query librenms: unexpected status %s", res.Status)
	}

	var parsed struct {
		Alerts []struct {
			Hostname  string `json:"hostname"`
			Rule      string `json:"rule"`
			State     int    `json:"state"`
			Severity  string `json:"severity"`
			Timestamp string `json:"timestamp"` // "YYYY-MM-DD HH:MM:SS"
			Details   string `json:"details"`
		} `json:"alerts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode librenms response: %w", err)
	}

	from := around.Add(-window)
	until := around.Add(window)

	events := make([]Event, 0)
	for _, a := range parsed.Alerts {
		// LibreNMS identifies a device by whatever hostname it was added
		// with — usually the same FQDN/IP this agent enrolled with, but
		// match loosely (either the exact hostname or the bare IP
		// appearing in it) since operators commonly poll by IP.
		if !strings.EqualFold(a.Hostname, hostname) && !strings.Contains(a.Hostname, ip) {
			continue
		}
		ts, err := time.ParseInLocation("2006-01-02 15:04:05", a.Timestamp, time.UTC)
		if err != nil {
			continue
		}
		if ts.Before(from) || ts.After(until) {
			continue
		}
		summary := a.Rule
		if a.Details != "" {
			summary = a.Rule + ": " + a.Details
		}
		raw, _ := json.Marshal(a)
		events = append(events, Event{
			Source:    "librenms",
			Timestamp: ts,
			Severity:  severityOrState(a.Severity, a.State),
			Summary:   summary,
			Raw:       string(raw),
		})
	}
	return events, nil
}

func severityOrState(severity string, state int) string {
	if severity != "" {
		return severity
	}
	return "state:" + strconv.Itoa(state)
}

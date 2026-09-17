// Package rules is a stub anomaly-detection engine: for this first slice it
// tallies AVC signatures (scontext -> tcontext : class) so the dashboard can
// show "most frequent signatures", and raises two simple alert kinds from
// that same tally — a signature never seen before, and a signature crossing
// a fixed occurrence threshold. Real anomaly detection (statistical
// baselines, policy drift) is a follow-up; this is intentionally simple
// and explainable.
package rules

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// thresholds an in-memory signature count must cross to raise a
// "fréquence anormale" alert. Small and fixed rather than adaptive, to
// keep this first pass predictable.
var thresholds = []int{10, 50, 100, 500}

type Engine struct {
	mu    sync.Mutex
	stats map[string]*signatureStat
}

type signatureStat struct {
	SContext        string
	TContext        string
	TClass          string
	Perms           map[string]struct{}
	Count           int
	Agents          map[string]struct{}
	firedThresholds map[int]bool
}

func NewEngine() *Engine {
	return &Engine{stats: make(map[string]*signatureStat)}
}

type Observation struct {
	AgentID  string
	SContext string
	TContext string
	TClass   string
	Perms    []string
}

func key(o Observation) string {
	return o.SContext + "\x00" + o.TContext + "\x00" + o.TClass
}

// Alert is a condition the engine wants surfaced to an operator. Observe
// returns zero or more of these; the caller is responsible for persisting
// them (see internal/store/postgres.Store.CreateAlert).
type Alert struct {
	Type     string // new_signature | threshold
	Title    string
	Message  string
	AgentID  string
	SContext string
	TContext string
	TClass   string
}

func (e *Engine) Observe(o Observation) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()

	var alerts []Alert

	k := key(o)
	s, ok := e.stats[k]
	if !ok {
		s = &signatureStat{
			SContext:        o.SContext,
			TContext:        o.TContext,
			TClass:          o.TClass,
			Perms:           make(map[string]struct{}),
			Agents:          make(map[string]struct{}),
			firedThresholds: make(map[int]bool),
		}
		e.stats[k] = s
		alerts = append(alerts, Alert{
			Type:     "new_signature",
			Title:    "Nouvelle signature AVC",
			Message:  fmt.Sprintf("Premier denial observé pour %s -> %s (%s)", o.SContext, o.TContext, o.TClass),
			AgentID:  o.AgentID,
			SContext: o.SContext,
			TContext: o.TContext,
			TClass:   o.TClass,
		})
	}
	s.Count++
	s.Agents[o.AgentID] = struct{}{}
	for _, p := range o.Perms {
		s.Perms[p] = struct{}{}
	}

	for _, t := range thresholds {
		if s.Count >= t && !s.firedThresholds[t] {
			s.firedThresholds[t] = true
			alerts = append(alerts, Alert{
				Type:     "threshold",
				Title:    "Fréquence anormale",
				Message:  fmt.Sprintf("%s -> %s (%s) a dépassé %d occurrences (%d au total)", o.SContext, o.TContext, o.TClass, t, s.Count),
				AgentID:  o.AgentID,
				SContext: o.SContext,
				TContext: o.TContext,
				TClass:   o.TClass,
			})
		}
	}

	return alerts
}

type TopSignature struct {
	Pair   string `json:"pair"`
	Class  string `json:"class"`
	Perms  string `json:"perms"`
	Count  int    `json:"count"`
	Agents int    `json:"agents"`
}

func (e *Engine) TopSignatures(limit int) []TopSignature {
	e.mu.Lock()
	defer e.mu.Unlock()

	out := make([]TopSignature, 0, len(e.stats))
	for _, s := range e.stats {
		perms := make([]string, 0, len(s.Perms))
		for p := range s.Perms {
			perms = append(perms, p)
		}
		sort.Strings(perms)
		out = append(out, TopSignature{
			Pair:   fmt.Sprintf("%s -> %s", s.SContext, s.TContext),
			Class:  s.TClass,
			Perms:  strings.Join(perms, ","),
			Count:  s.Count,
			Agents: len(s.Agents),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (e *Engine) TotalCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	total := 0
	for _, s := range e.stats {
		total += s.Count
	}
	return total
}

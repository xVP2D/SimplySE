// Package rules is a stub anomaly-detection engine: for this first slice it
// tallies AVC signatures (scontext -> tcontext : class) so the dashboard can
// show "most frequent signatures", and raises two simple alert kinds from
// that same tally — a signature never seen before, and a signature crossing
// a fixed occurrence threshold. Real anomaly detection (statistical
// baselines, policy drift) is a follow-up; this is intentionally simple
// and explainable.
package rules

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// thresholds an in-memory signature count must cross to raise a
// "fréquence anormale" alert. Small and fixed rather than adaptive, to
// keep this first pass predictable.
var thresholds = []int{10, 50, 100, 500}

// criticalTypes marks SELinux domain/type names whose denials get raised
// as "high" severity regardless of how often they've occurred — a single
// denial against sshd/httpd/sudo/etc. is worth an operator's attention
// immediately, unlike a run-of-the-mill unconfined-domain denial. Not
// exhaustive (there's no single canonical list across distros/policies);
// extend as needed. Deliberately excludes types so broad they'd make this
// meaningless (e.g. unconfined_t, kernel_t, init_t alone).
var criticalTypes = map[string]bool{
	"sshd_t":           true,
	"httpd_t":          true,
	"sudo_t":           true,
	"su_t":             true,
	"crond_t":          true,
	"named_t":          true,
	"dhcpd_t":          true,
	"postgresql_t":     true,
	"mysqld_t":         true,
	"auditd_t":         true,
	"sysadm_t":         true,
	"NetworkManager_t": true,
}

// typeFromContext extracts the SELinux type from a full context string
// (user:role:type:level[:categories]) — the middle-ish field that actually
// identifies "what this is" (sshd, httpd, ...), unlike the user/role/level
// fields which are mostly constant (system_u/system_r/s0) in a targeted
// policy.
func typeFromContext(ctx string) string {
	parts := strings.Split(ctx, ":")
	if len(parts) >= 3 {
		return parts[2]
	}
	return ctx
}

// severityFor returns "high" if either side of the denial touches a known
// critical service type, "medium" otherwise. Two levels only for now —
// deliberately simple and explainable, like the rest of this package.
func severityFor(o Observation) string {
	if criticalTypes[typeFromContext(o.SContext)] || criticalTypes[typeFromContext(o.TContext)] {
		return "high"
	}
	return "medium"
}

// SuggestedModuleName derives a name safe to hand to `audit2allow -M`
// (and, on the agent side, to a shell-argument position) from a
// signature: letters/digits/underscore only, since both audit2allow and
// the agent's own validation of this same string reject anything else.
//
// The permissions are part of the name on purpose: a module generated from
// one denial only allows *that* denial's permissions, so a later denial of
// the same source/target/class with other permissions (say search after
// write) needs its own module. Sharing one name would make the second
// install replace the first and silently drop what it allowed; with the
// permissions in the name the modules simply add up.
func SuggestedModuleName(o Observation) string {
	sanitize := func(s string) string {
		var b strings.Builder
		for _, r := range s {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			}
		}
		return b.String()
	}
	name := fmt.Sprintf("suggested_%s_%s_%s", sanitize(typeFromContext(o.SContext)), sanitize(typeFromContext(o.TContext)), sanitize(o.TClass))

	perms := make([]string, 0, len(o.Perms))
	for _, p := range o.Perms {
		if clean := sanitize(p); clean != "" {
			perms = append(perms, clean)
		}
	}
	sort.Strings(perms)
	if len(perms) > 0 {
		name += "_" + strings.Join(perms, "_")
	}

	// The agent refuses module names over 64 characters: keep the readable
	// head and make the tail a hash of the whole thing so two long names
	// can't collide.
	if len(name) > 64 {
		sum := sha256.Sum256([]byte(name))
		name = name[:55] + "_" + hex.EncodeToString(sum[:4])
	}
	return name
}

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
	Severity string // low | medium | high — see severityFor
}

func (e *Engine) Observe(o Observation) []Alert {
	e.mu.Lock()
	defer e.mu.Unlock()

	var alerts []Alert
	severity := severityFor(o)

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
			Severity: severity,
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
				Severity: severity,
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


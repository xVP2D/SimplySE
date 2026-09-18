package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"console-selinux/master/internal/store/opensearch"
	"console-selinux/master/internal/store/postgres"
)

// "Collect every denial of a domain": fixing a denial only reveals the next
// (search, then addname, then create, then open...), because SELinux reports
// the first refusal of each operation. Making the domain permissive for a
// bounded time logs all of them at once without blocking anything, and one
// suggestion then covers the lot.
//
// It loosens one domain on a real machine, so the way back is the design's
// centre: the agent puts the domain back by itself at the deadline (state on
// its own disk, re-armed after a restart), independently of this master.
// The master's part is bookkeeping and the suggestion: it ends the window on
// schedule, retries an unconfirmed stop, and generates one suggestion from
// what was logged.

const (
	MinCollectSecs     = 30
	MaxCollectSecs     = 3600
	DefaultCollectSecs = 600
	maxCollectedLines  = 500
	// A start the agent never confirmed / a stop it never acknowledged must
	// not leave a run open forever.
	startConfirmTimeout = 2 * time.Minute
	stopRetryEvery      = 30 * time.Second
	stopGiveUpAfter     = 3 * time.Minute
)

var (
	ErrInvalidCollection = errors.New("invalid collection request")
	ErrCollectionState   = errors.New("this collection can't be stopped in its current state")

	domainRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}_t$`)
	// Too central to loosen: every process would lose its confinement.
	refusedDomains = map[string]bool{"kernel_t": true, "init_t": true}
)

// ValidCollectDomain: a plain lowercase type name ending in _t, and not one
// too central to be made permissive.
func ValidCollectDomain(domain string) bool {
	return domainRe.MatchString(domain) && !refusedDomains[domain]
}

// DomainOfContext returns the type field of a full SELinux context
// (user:role:type:level).
func DomainOfContext(scontext string) string {
	parts := strings.Split(scontext, ":")
	if len(parts) >= 3 {
		return parts[2]
	}
	return ""
}

// CollectedModuleName is unique per run: a later collection must not replace
// (and so drop the rules of) an earlier one's module.
func CollectedModuleName(domain string, at time.Time) string {
	var b strings.Builder
	for _, r := range domain {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	name := fmt.Sprintf("suggested_%s_collected_%x", b.String(), at.Unix())
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

type Collector struct {
	Store  *postgres.Store
	Search *opensearch.Store
	Hub    *Hub
	Log    *slog.Logger

	mu     sync.Mutex
	active map[string]struct{} // agent|domain of runs in progress
}

func collectionKey(agentID, domain string) string { return agentID + "\x00" + domain }

// Suppresses reports whether denials from this source context are being
// collected right now on this agent — the automatic per-permission
// suggestions are paused for them, since the run produces one suggestion for
// everything instead.
func (c *Collector) Suppresses(agentID, scontext string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, on := c.active[collectionKey(agentID, DomainOfContext(scontext))]
	return on
}

func (c *Collector) setActive(list []postgres.Collection) {
	next := make(map[string]struct{}, len(list))
	for _, col := range list {
		next[collectionKey(col.AgentID, col.Domain)] = struct{}{}
	}
	c.mu.Lock()
	c.active = next
	c.mu.Unlock()
}

func (c *Collector) markActive(agentID, domain string) {
	c.mu.Lock()
	if c.active == nil {
		c.active = map[string]struct{}{}
	}
	c.active[collectionKey(agentID, domain)] = struct{}{}
	c.mu.Unlock()
}

// Start makes domain permissive on agentID for dur, after which the agent
// ends it by itself.
func (c *Collector) Start(ctx context.Context, agentID, domain string, dur time.Duration, by string) (postgres.Collection, error) {
	secs := int(dur.Seconds())
	if secs == 0 {
		secs = DefaultCollectSecs
	}
	if !ValidCollectDomain(domain) || secs < MinCollectSecs || secs > MaxCollectSecs || agentID == "" {
		return postgres.Collection{}, ErrInvalidCollection
	}
	if !c.Hub.IsConnected(agentID) {
		return postgres.Collection{}, ErrAgentOffline
	}
	col, err := c.Store.CreateCollection(ctx, agentID, domain, secs, by)
	if err != nil {
		return postgres.Collection{}, err
	}
	c.markActive(agentID, domain)

	payload, _ := json.Marshal(map[string]any{"domain": domain, "duration_secs": secs})
	cmd, err := DispatchCommand(ctx, c.Store, c.Hub, agentID, nil, "permissive_start", string(payload))
	if err != nil {
		_ = c.Store.FinishCollection(ctx, col.ID, "failed", "could not send the start command: "+err.Error(), nil, 0)
		return postgres.Collection{}, err
	}
	if err := c.Store.SetCollectionStartCommand(ctx, col.ID, cmd.ID); err != nil {
		return postgres.Collection{}, err
	}
	c.Log.Warn("domain collection requested: the domain will be permissive on the agent", "agent_id", agentID, "domain", domain, "seconds", secs, "by", by)
	return c.Store.GetCollection(ctx, col.ID)
}

// Stop ends a run early; the suggestion is generated once the agent confirms.
func (c *Collector) Stop(ctx context.Context, id string) error {
	col, err := c.Store.GetCollection(ctx, id)
	if err != nil {
		return err
	}
	if col.Status != "collecting" {
		return ErrCollectionState
	}
	return c.sendStop(ctx, col)
}

func (c *Collector) sendStop(ctx context.Context, col postgres.Collection) error {
	payload, _ := json.Marshal(map[string]any{"domain": col.Domain})
	cmd, err := DispatchCommand(ctx, c.Store, c.Hub, col.AgentID, nil, "permissive_stop", string(payload))
	if err != nil {
		return err
	}
	return c.Store.BeginStopping(ctx, col.ID, cmd.ID)
}

// OnAck advances a run when the agent answers its start or stop command.
func (c *Collector) OnAck(ctx context.Context, commandID string, success bool, message string) {
	if c == nil {
		return
	}
	col, found, err := c.Store.GetCollectionByCommand(ctx, commandID)
	if err != nil || !found {
		return
	}
	switch {
	case col.StartCommandID != nil && *col.StartCommandID == commandID && col.Status == "starting":
		if !success {
			_ = c.Store.FinishCollection(ctx, col.ID, "failed", message, nil, 0)
			c.refreshActive(ctx)
			return
		}
		_ = c.Store.MarkCollecting(ctx, col.ID, time.Now().Add(time.Duration(col.DurationSecs)*time.Second))
		c.Log.Info("domain is now permissive; collecting", "agent_id", col.AgentID, "domain", col.Domain, "detail", message)
	case col.StopCommandID != nil && *col.StopCommandID == commandID && col.Status == "stopping":
		if success {
			c.finalize(ctx, col, "")
		}
		// On failure the runner retries: the domain must not stay loosened.
	}
}

func (c *Collector) refreshActive(ctx context.Context) {
	if list, err := c.Store.ListActiveCollections(ctx); err == nil {
		c.setActive(list)
	}
}

// finalize turns what was logged into one suggestion and closes the run.
func (c *Collector) finalize(ctx context.Context, col postgres.Collection, note string) {
	since := col.StartedAt.Unix() - 10
	lines, err := c.Search.CollectedLines(ctx, col.AgentID, col.Domain, since, time.Now().Unix()+30, maxCollectedLines)
	if err != nil {
		_ = c.Store.FinishCollection(ctx, col.ID, "failed", "could not read the collected denials: "+err.Error(), nil, 0)
		c.refreshActive(ctx)
		return
	}
	message := note
	var suggestionID *string
	if len(lines) == 0 {
		message = strings.TrimSpace(message + " Aucun denial collecté pour ce domaine pendant la fenêtre.")
	} else {
		sug, err := RequestCollectedSuggestion(ctx, c.Store, c.Hub, col.AgentID, col.Domain, CollectedModuleName(col.Domain, col.StartedAt), lines)
		if err != nil {
			_ = c.Store.FinishCollection(ctx, col.ID, "failed", "could not generate the suggestion: "+err.Error(), nil, len(lines))
			c.refreshActive(ctx)
			return
		}
		suggestionID = &sug.ID
	}
	_ = c.Store.FinishCollection(ctx, col.ID, "done", message, suggestionID, len(lines))
	c.refreshActive(ctx)
	c.Log.Info("domain collection finished", "agent_id", col.AgentID, "domain", col.Domain, "distinct_denials", len(lines))
}

// Run drives the runs in progress until ctx ends: ends windows on schedule,
// retries an unconfirmed stop, and closes runs whose agent went silent.
func (c *Collector) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		c.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Collector) tick(ctx context.Context) {
	list, err := c.Store.ListActiveCollections(ctx)
	if err != nil {
		c.Log.Warn("list active collections failed", "error", err)
		return
	}
	c.setActive(list)
	now := time.Now()
	for _, col := range list {
		switch col.Status {
		case "starting":
			if now.Sub(col.StartedAt) > startConfirmTimeout {
				// The agent may still have started it: its own deadline
				// will end that either way.
				_ = c.Store.FinishCollection(ctx, col.ID, "failed", "l'agent n'a pas confirmé le démarrage", nil, 0)
			}
		case "collecting":
			if col.EndsAt != nil && !now.Before(*col.EndsAt) {
				if err := c.sendStop(ctx, col); err != nil {
					c.Log.Warn("send stop failed", "collection", col.ID, "error", err)
				}
			}
		case "stopping":
			switch sent := col.StopSentAt; {
			case sent == nil || now.Sub(*sent) > stopGiveUpAfter:
				// Still generate the suggestion from what was logged; the
				// agent's own deadline is what guarantees the way back.
				c.finalize(ctx, col, "Retour à enforced non confirmé par l'agent (il le fait lui-même à l'échéance).")
			case now.Sub(*sent) > stopRetryEvery:
				if err := c.sendStop(ctx, col); err != nil {
					c.Log.Warn("resend stop failed", "collection", col.ID, "error", err)
				}
			}
		}
	}
	// Runs closed above must stop suppressing suggestions right away; the set
	// is swapped in one step (never emptied first).
	c.refreshActive(ctx)
}

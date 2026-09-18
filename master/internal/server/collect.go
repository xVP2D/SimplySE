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
// bounded time logs all of them at once without blocking anything, so one
// suggestion can cover the lot — but generating that suggestion is always a
// separate, explicit operator action (GenerateSuggestion), same as every
// other suggestion in this tool: closing the window only counts what was
// logged, it never proposes anything on its own.
//
// It loosens one domain on a real machine, so the way back is the design's
// centre: the agent puts the domain back by itself at the deadline (state on
// its own disk, re-armed after a restart), independently of this master.
// The master's part is bookkeeping: it ends the window on schedule, retries
// an unconfirmed stop, and closes runs whose agent went silent rather than
// leaving them open forever.

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
		_ = c.Store.CloseCollectionWindow(ctx, col.ID, "failed", "could not send the start command: "+err.Error(), 0)
		return postgres.Collection{}, err
	}
	if err := c.Store.SetCollectionStartCommand(ctx, col.ID, cmd.ID); err != nil {
		return postgres.Collection{}, err
	}
	c.Log.Warn("domain collection requested: the domain will be permissive on the agent", "agent_id", agentID, "domain", domain, "seconds", secs, "by", by)
	return c.Store.GetCollection(ctx, col.ID)
}

// Stop ends a run early; the window closes once the agent confirms.
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
			_ = c.Store.CloseCollectionWindow(ctx, col.ID, "failed", message, 0)
			c.refreshActive(ctx)
			return
		}
		_ = c.Store.MarkCollecting(ctx, col.ID, time.Now().Add(time.Duration(col.DurationSecs)*time.Second))
		c.Log.Info("domain is now permissive; collecting", "agent_id", col.AgentID, "domain", col.Domain, "detail", message)
	case col.StopCommandID != nil && *col.StopCommandID == commandID && col.Status == "stopping":
		if success {
			c.closeWindow(ctx, col, "")
		}
		// On failure the runner retries: the domain must not stay loosened.
	}
}

func (c *Collector) refreshActive(ctx context.Context) {
	if list, err := c.Store.ListActiveCollections(ctx); err == nil {
		c.setActive(list)
	}
}

// closeWindow ends a run's permissive window (already off on the machine by
// the time this runs) and counts what it logged. Turning that into a
// suggestion is a separate, later, explicitly-requested step (see
// GenerateSuggestion) — nothing is proposed for review without an operator
// asking for it, same as every other suggestion in this tool.
func (c *Collector) closeWindow(ctx context.Context, col postgres.Collection, note string) {
	lines, err := c.Search.CollectedLines(ctx, col.AgentID, col.Domain, col.StartedAt.Unix()-10, time.Now().Unix()+30, maxCollectedLines)
	if err != nil {
		_ = c.Store.CloseCollectionWindow(ctx, col.ID, "failed", "could not read the collected denials: "+err.Error(), 0)
		c.refreshActive(ctx)
		return
	}
	status, message := "collected", note
	if len(lines) == 0 {
		status = "done" // nothing to generate a suggestion from
		message = strings.TrimSpace(message + " Aucun denial collecté pour ce domaine pendant la fenêtre.")
	}
	_ = c.Store.CloseCollectionWindow(ctx, col.ID, status, message, len(lines))
	c.refreshActive(ctx)
	c.Log.Info("domain collection window closed", "agent_id", col.AgentID, "domain", col.Domain, "distinct_denials", len(lines))
}

// ErrCollectionNotReady: this run has no logged denials ready to turn into
// a suggestion (still in progress, none logged, or a suggestion was already
// generated for it).
var ErrCollectionNotReady = errors.New("this collection has nothing ready to generate a suggestion from")

// GenerateSuggestion turns a closed run's logged denials into one
// suggestion — an explicit operator action (POST /api/collections/{id}/generate),
// never triggered on its own when the window closes.
func (c *Collector) GenerateSuggestion(ctx context.Context, id string) (postgres.SuggestedModule, error) {
	col, err := c.Store.GetCollection(ctx, id)
	if err != nil {
		return postgres.SuggestedModule{}, err
	}
	if col.Status != "collected" || col.FinishedAt == nil {
		return postgres.SuggestedModule{}, ErrCollectionNotReady
	}
	lines, err := c.Search.CollectedLines(ctx, col.AgentID, col.Domain, col.StartedAt.Unix()-10, col.FinishedAt.Unix()+30, maxCollectedLines)
	if err != nil {
		return postgres.SuggestedModule{}, err
	}
	if len(lines) == 0 {
		_ = c.Store.RecordSuggestion(ctx, col.ID, "done", "Aucun denial collecté pour ce domaine pendant la fenêtre.", nil)
		return postgres.SuggestedModule{}, ErrCollectionNotReady
	}
	sug, err := RequestCollectedSuggestion(ctx, c.Store, c.Hub, col.AgentID, col.Domain, CollectedModuleName(col.Domain, col.StartedAt), lines)
	if err != nil {
		_ = c.Store.RecordSuggestion(ctx, col.ID, "failed", "could not generate the suggestion: "+err.Error(), nil)
		return postgres.SuggestedModule{}, err
	}
	_ = c.Store.RecordSuggestion(ctx, col.ID, "done", col.Message, &sug.ID)
	c.Log.Info("domain collection suggestion generated", "agent_id", col.AgentID, "domain", col.Domain, "distinct_denials", len(lines))
	return sug, nil
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
				_ = c.Store.CloseCollectionWindow(ctx, col.ID, "failed", "l'agent n'a pas confirmé le démarrage", 0)
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
				c.closeWindow(ctx, col, "Retour à enforced non confirmé par l'agent (il le fait lui-même à l'échéance).")
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

// LiveCount reports how many distinct denials a still-running collection has
// logged so far, for a live progress display. Returns the already-final
// lines_count for a run that isn't actively collecting (nothing left to
// recompute), so callers can use this unconditionally.
func (c *Collector) LiveCount(ctx context.Context, col postgres.Collection) int {
	if col.Status != "collecting" && col.Status != "stopping" {
		return col.LinesCount
	}
	n, err := c.Search.CountCollected(ctx, col.AgentID, col.Domain, col.StartedAt.Unix()-10, time.Now().Unix()+5)
	if err != nil {
		return col.LinesCount
	}
	return n
}

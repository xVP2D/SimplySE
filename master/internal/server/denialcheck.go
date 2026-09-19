package server

import (
	"context"
	"log/slog"
	"time"

	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
	"console-selinux/master/internal/store/opensearch"
)

const (
	// probesPerAgent bounds how many distinct denials are re-checked per
	// agent per sweep (most recently seen first). More than this many
	// distinct, still-denied signatures on one machine means the rest wait
	// for a later sweep once the head of the list resolves.
	probesPerAgent = 300
	// probesPerMessage keeps a single gRPC message small.
	probesPerMessage = 100
	maxSigLen        = 8192
)

// DenialChecker makes a denial disappear once it would no longer be denied.
// It never looks at *how* a rule got applied: it asks each agent, for every
// denial still on screen, whether the policy loaded in that machine's kernel
// would deny it now — so a deployed rule, an approved suggestion and a hand
// edit on the machine (setsebool, semodule, chcon, semanage...) all resolve
// denials the same way. Answered denials are hidden (see
// opensearch.MarkResolved), taking their occurrence counts with them.
type DenialChecker struct {
	Search *opensearch.Store
	Hub    *Hub
	Log    *slog.Logger
}

// Run sweeps every connected agent on a fixed interval until ctx ends. This
// is what catches changes made outside the tool.
func (c *DenialChecker) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.Sweep(ctx, "")
		}
	}
}

// Sweep asks the connected agents (just agentID, or all when empty) about
// their unresolved denials. Cheap when there is nothing to ask: one
// aggregation, no messages.
func (c *DenialChecker) Sweep(ctx context.Context, agentID string) {
	byAgent, err := c.Search.UnresolvedProbes(ctx, agentID, probesPerAgent)
	if err != nil {
		c.Log.Warn("list unresolved denials failed", "error", err)
		return
	}
	if len(byAgent) == 0 {
		// Silent by design when nothing is unresolved — but worth a line
		// when this sweep was asked about one specific agent (right after a
		// rule), so "nothing happened" is visible instead of indistinguishable
		// from every other 30s tick that legitimately finds nothing.
		if agentID != "" {
			c.Log.Info("denial sweep: no unresolved denial found for this agent", "agent_id", agentID)
		}
		return
	}
	for agent, probes := range byAgent {
		if !c.Hub.IsConnected(agent) {
			c.Log.Debug("denial sweep: agent has unresolved denials but is not connected", "agent_id", agent, "count", len(probes))
			continue
		}
		c.Log.Debug("denial sweep: asking agent to re-check its denials", "agent_id", agent, "count", len(probes))
		for start := 0; start < len(probes); start += probesPerMessage {
			end := min(start+probesPerMessage, len(probes))
			msg := &selinuxv1.CheckDenials{}
			for _, p := range probes[start:end] {
				msg.Probes = append(msg.Probes, &selinuxv1.DenialProbe{
					Id: p.Sig, Scontext: p.SContext, Tcontext: p.TContext, Tclass: p.TClass, Perms: p.Perms, Path: p.Path,
				})
			}
			if err := c.Hub.Dispatch(agent, &selinuxv1.ServerMessage{Payload: &selinuxv1.ServerMessage_CheckDenials{CheckDenials: msg}}); err != nil {
				c.Log.Warn("dispatch denial check failed", "agent_id", agent, "error", err)
				break
			}
		}
	}
}

// HandleVerdicts hides the denials an agent says are now allowed. The agent
// id comes from the authenticated session, never from the message, so an
// agent can only ever resolve its own denials.
func (c *DenialChecker) HandleVerdicts(ctx context.Context, agentID string, checked *selinuxv1.DenialsChecked) {
	total, allowed := 0, 0
	for _, v := range checked.GetVerdicts() {
		total++
		if !v.GetAllowed() {
			continue
		}
		allowed++
		if v.GetId() == "" || len(v.GetId()) > maxSigLen {
			c.Log.Warn("denial verdict allowed but has no usable signature, cannot mark it resolved", "agent_id", agentID, "detail", v.GetDetail())
			continue
		}
		n, err := c.Search.MarkResolved(ctx, agentID, v.GetId())
		if err != nil {
			c.Log.Error("mark denials resolved failed", "agent_id", agentID, "error", err)
			continue
		}
		if n > 0 {
			c.Log.Info("denial resolved: now allowed by the loaded policy", "agent_id", agentID, "events", n, "detail", v.GetDetail(), "signature", v.GetId())
		}
	}
	if total > 0 {
		c.Log.Debug("denial verdicts received", "agent_id", agentID, "checked", total, "allowed", allowed)
	}
}

// Rules that can make a denial go away — checked right after one is
// applied instead of waiting for the next sweep. remove_module/restorecon/
// set_mode can't add an allowance, so they aren't listed.
var ruleTypesThatMayAllow = map[string]bool{
	"set_boolean":    true,
	"install_module": true,
	"chcon":          true,
}

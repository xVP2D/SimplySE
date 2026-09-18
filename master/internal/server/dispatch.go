package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
	"console-selinux/master/internal/rules"
	"console-selinux/master/internal/store/postgres"
)

var commandTypeByName = map[string]selinuxv1.CommandType{
	"set_mode":       selinuxv1.CommandType_COMMAND_TYPE_SET_MODE,
	"set_boolean":    selinuxv1.CommandType_COMMAND_TYPE_SET_BOOLEAN,
	"install_module": selinuxv1.CommandType_COMMAND_TYPE_INSTALL_MODULE,
	"chcon":          selinuxv1.CommandType_COMMAND_TYPE_CHCON,
	"suggest_module": selinuxv1.CommandType_COMMAND_TYPE_SUGGEST_MODULE,
	"remove_module":  selinuxv1.CommandType_COMMAND_TYPE_REMOVE_MODULE,
	"restorecon":     selinuxv1.CommandType_COMMAND_TYPE_RESTORECON,

	"permissive_start": selinuxv1.CommandType_COMMAND_TYPE_PERMISSIVE_START,
	"permissive_stop":  selinuxv1.CommandType_COMMAND_TYPE_PERMISSIVE_STOP,
}

// DispatchCommand persists a command for agentID and, if the agent is
// currently connected, sends it immediately over its gRPC stream. The
// command row is created either way so the operator can see it queued.
func DispatchCommand(ctx context.Context, store *postgres.Store, hub *Hub, agentID string, ruleID *string, cmdType, payloadJSON string) (postgres.Command, error) {
	n := postgres.NewCommand{AgentID: agentID, RuleID: ruleID, Type: cmdType, PayloadJSON: payloadJSON}
	// Record how to undo it before it runs: the previous boolean value /
	// mode / "was this module already installed" is only knowable now.
	if plan := planUndo(ctx, store, agentID, cmdType, payloadJSON); plan != nil {
		encoded, err := json.Marshal(plan)
		if err != nil {
			return postgres.Command{}, fmt.Errorf("marshal undo plan: %w", err)
		}
		n.UndoJSON = string(encoded)
	}
	return dispatch(ctx, store, hub, n)
}

func commandMessage(id string, t selinuxv1.CommandType, payloadJSON string) *selinuxv1.ServerMessage {
	return &selinuxv1.ServerMessage{
		Payload: &selinuxv1.ServerMessage_Command{
			Command: &selinuxv1.Command{CommandId: id, Type: t, PayloadJson: payloadJSON},
		},
	}
}

// resendPending sends a command that was persisted but never delivered
// (the agent was offline when it was created) and marks it sent.
func resendPending(ctx context.Context, store *postgres.Store, hub *Hub, cmd postgres.Command) error {
	protoType, ok := commandTypeByName[cmd.Type]
	if !ok {
		return fmt.Errorf("unknown command type %q", cmd.Type)
	}
	if err := hub.Dispatch(cmd.AgentID, commandMessage(cmd.ID, protoType, cmd.PayloadJSON)); err != nil {
		return err
	}
	return store.MarkCommandSent(ctx, cmd.ID)
}

// FlushPendingCommands delivers what an agent missed while it was
// disconnected. Without this a command created during even a brief
// disconnect (a master restart, a network blip) stayed "pending" forever.
func FlushPendingCommands(ctx context.Context, store *postgres.Store, hub *Hub, log *slog.Logger, agentID string) {
	pending, err := store.PendingCommandsFor(ctx, agentID, 16) // the hub's per-agent queue holds 16
	if err != nil {
		log.Warn("list pending commands failed", "agent_id", agentID, "error", err)
		return
	}
	for _, cmd := range pending {
		if err := resendPending(ctx, store, hub, cmd); err != nil {
			log.Warn("resend pending command failed", "agent_id", agentID, "command_id", cmd.ID, "error", err)
			return
		}
		log.Info("delivered a command the agent missed while offline", "agent_id", agentID, "command_id", cmd.ID, "type", cmd.Type)
	}
}

// dispatch persists n and sends it if the agent is connected.
func dispatch(ctx context.Context, store *postgres.Store, hub *Hub, n postgres.NewCommand) (postgres.Command, error) {
	protoType, ok := commandTypeByName[n.Type]
	if !ok {
		return postgres.Command{}, fmt.Errorf("unknown command type %q", n.Type)
	}

	cmd, err := store.CreateCommandWith(ctx, n)
	if err != nil {
		return postgres.Command{}, err
	}

	msg := commandMessage(cmd.ID, protoType, n.PayloadJSON)

	if err := hub.Dispatch(n.AgentID, msg); err != nil {
		// Not connected right now: the command stays "pending" and will
		// need to be resent once the agent reconnects (follow-up: a
		// reconnect hook that flushes pending commands).
		return cmd, nil
	}

	if err := store.MarkCommandSent(ctx, cmd.ID); err != nil {
		return cmd, err
	}
	cmd.Status = "sent"
	return cmd, nil
}

var deniedPermsRe = regexp.MustCompile(`denied\s*\{([^}]*)\}`)

// PermsFromRawLine extracts the denied permissions from an AVC line
// ("avc: denied { read write } for ..."), so a suggestion is named and
// generated for exactly the permissions that denial was about.
func PermsFromRawLine(rawLine string) []string {
	m := deniedPermsRe.FindStringSubmatch(rawLine)
	if m == nil {
		return nil
	}
	return strings.Fields(m[1])
}

// RequestModuleSuggestion dispatches a suggest_module command for one
// specific denial (identified by its raw audit line) to agentID, and
// creates the tracking row the Suggestions page reads. This is the single
// place audit2allow generation is ever triggered from — both
// automatically, the moment a new_signature alert fires (see main.go),
// and on explicit operator request (the "fix this on this machine" button
// on a denial row, POST /api/denials/suggest) — so there's exactly one
// code path to reason about for how a suggestion comes to exist.
// Generation only: never installs anything by itself (see the proto's
// SUGGEST_MODULE comment and the agent's action::suggest_module).
func RequestModuleSuggestion(ctx context.Context, store *postgres.Store, hub *Hub, agentID, scontext, tcontext, tclass, rawLine string) (postgres.SuggestedModule, error) {
	moduleName := rules.SuggestedModuleName(rules.Observation{SContext: scontext, TContext: tcontext, TClass: tclass, Perms: PermsFromRawLine(rawLine)})

	// One suggestion per (machine, module): the automatic trigger and the
	// "fix on this machine" button both land here, and every extra click
	// used to create another identical suggestion — which could then each
	// be approved, installing the same module again and again.
	if existing, found, err := store.FindOpenSuggestion(ctx, agentID, moduleName); err != nil {
		return postgres.SuggestedModule{}, err
	} else if found && existing.Status != "approved" {
		// Still generating with its command never delivered (agent was
		// offline): give it another chance now instead of leaving the
		// suggestion "generating" forever.
		if existing.Status == "generating" {
			if cmd, err := store.GetCommand(ctx, existing.CommandID); err == nil && cmd.Status == "pending" {
				_ = resendPending(ctx, store, hub, cmd)
			}
		}
		return existing, nil
	} else if found {
		// Approved: only reusable while the module is actually still there
		// (it may have been removed since, e.g. by deleting the rule).
		if state, ok, _ := store.GetSelinuxState(ctx, agentID); ok {
			for _, m := range state.Modules {
				if m.Name == moduleName {
					return existing, nil
				}
			}
		}
	}

	payloadJSON, err := json.Marshal(map[string]any{
		"raw_lines":   []string{rawLine},
		"module_name": moduleName,
	})
	if err != nil {
		return postgres.SuggestedModule{}, fmt.Errorf("marshal suggest_module payload: %w", err)
	}
	cmd, err := DispatchCommand(ctx, store, hub, agentID, nil, "suggest_module", string(payloadJSON))
	if err != nil {
		return postgres.SuggestedModule{}, fmt.Errorf("dispatch suggest_module: %w", err)
	}
	return store.CreateSuggestedModule(ctx, cmd.ID, agentID, moduleName, scontext, tcontext, tclass)
}

// RequestCollectedSuggestion dispatches one audit2allow generation over all
// the raw lines a collection run gathered, under a name unique to that run.
func RequestCollectedSuggestion(ctx context.Context, store *postgres.Store, hub *Hub, agentID, domain, moduleName string, lines []string) (postgres.SuggestedModule, error) {
	payloadJSON, err := json.Marshal(map[string]any{"raw_lines": lines, "module_name": moduleName})
	if err != nil {
		return postgres.SuggestedModule{}, fmt.Errorf("marshal suggest_module payload: %w", err)
	}
	cmd, err := DispatchCommand(ctx, store, hub, agentID, nil, "suggest_module", string(payloadJSON))
	if err != nil {
		return postgres.SuggestedModule{}, fmt.Errorf("dispatch suggest_module: %w", err)
	}
	// One module for many targets/classes: the single-signature columns hold
	// the domain and a wildcard.
	return store.CreateSuggestedModule(ctx, cmd.ID, agentID, moduleName, "system_u:system_r:"+domain+":s0", "*", "*")
}

package server

import (
	"context"
	"encoding/json"
	"fmt"

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

	msg := &selinuxv1.ServerMessage{
		Payload: &selinuxv1.ServerMessage_Command{
			Command: &selinuxv1.Command{
				CommandId:   cmd.ID,
				Type:        protoType,
				PayloadJson: n.PayloadJSON,
			},
		},
	}

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
	moduleName := rules.SuggestedModuleName(rules.Observation{SContext: scontext, TContext: tcontext, TClass: tclass})

	// One suggestion per (machine, module): the automatic trigger and the
	// "fix on this machine" button both land here, and every extra click
	// used to create another identical suggestion — which could then each
	// be approved, installing the same module again and again.
	if existing, found, err := store.FindOpenSuggestion(ctx, agentID, moduleName); err != nil {
		return postgres.SuggestedModule{}, err
	} else if found && existing.Status != "approved" {
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

package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"console-selinux/master/internal/store/postgres"
)

// Deleting an applied rule from the dashboard really undoes it on the
// machine. What "undo" means depends on the command:
//
//	install_module -> semodule -r <name>
//	chcon          -> restorecon [-R] <path> (policy default, not the exact
//	                  label it had before)
//	set_boolean    -> setsebool -P <name> <previous value>
//	set_mode       -> setenforce <previous mode>
//
// The last two need the value from *before* the command ran, so it is
// recorded when the command is dispatched (planUndo); a module is only ever
// removable if it wasn't installed beforehand, because removing a module
// that pre-existed would delete it rather than restore the old one.

// UndoPlan is the recorded way to undo one applied command.
type UndoPlan struct {
	Type    string          `json:"type"`    // command type to dispatch
	Payload json.RawMessage `json:"payload"` // its payload
	Action  string          `json:"action"`  // human-readable, shown in the confirmation
}

const (
	RevertMachine = "machine" // undo on the agent, then remove the entry
	RevertRecord  = "record"  // nothing applied on the machine: just remove the entry
	RevertNone    = "none"    // can't be removed right now (see Reason)
)

const (
	ReasonInFlight        = "in_flight"
	ReasonUnknownPrevious = "unknown_previous"
	ReasonNotSupported    = "not_supported"
)

// RevertInfo is what the API tells the dashboard about a command's Delete
// button.
type RevertInfo struct {
	Kind   string `json:"revert"`
	Reason string `json:"revert_reason,omitempty"`
	Action string `json:"revert_action,omitempty"`
}

var (
	ErrCommandNotFound = errors.New("command not found")
	ErrAgentOffline    = errors.New("the agent is offline: an undo can only be sent to a connected agent")
)

// NotRevertibleError carries the Reason so the API can explain it.
type NotRevertibleError struct{ Reason string }

func (e *NotRevertibleError) Error() string {
	switch e.Reason {
	case ReasonInFlight:
		return "an undo or the original command is still in flight, wait for its result"
	case ReasonNotSupported:
		return "this kind of command can't be removed"
	default:
		return "the state before this rule wasn't recorded, so it can't be undone automatically"
	}
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only ever called with plain maps of strings/bools
	}
	return b
}

func onOff(v bool) string {
	if v {
		return "on"
	}
	return "off"
}

// planUndo records, at dispatch time, how to undo cmdType/payloadJSON on
// agentID — nil when it can't be undone reliably.
func planUndo(ctx context.Context, store *postgres.Store, agentID, cmdType, payloadJSON string) *UndoPlan {
	switch cmdType {
	case "install_module":
		var p struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(payloadJSON), &p) != nil || p.Name == "" {
			return nil
		}
		state, found, err := store.GetSelinuxState(ctx, agentID)
		if err != nil || !found {
			return nil // can't tell whether it was already installed
		}
		for _, m := range state.Modules {
			if m.Name == p.Name {
				return nil // pre-existing: removing would delete it, not restore it
			}
		}
		return moduleUndo(p.Name)

	case "chcon":
		return chconUndo(payloadJSON)

	case "set_boolean":
		var p struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(payloadJSON), &p) != nil || p.Name == "" {
			return nil
		}
		state, found, err := store.GetSelinuxState(ctx, agentID)
		if err != nil || !found {
			return nil
		}
		for _, b := range state.Booleans {
			if b.Name == p.Name {
				return &UndoPlan{
					Type:    "set_boolean",
					Payload: mustJSON(map[string]any{"name": p.Name, "value": b.Value}),
					Action:  fmt.Sprintf("setsebool -P %s %s", p.Name, onOff(b.Value)),
				}
			}
		}
		return nil

	case "set_mode":
		agent, err := store.GetAgent(ctx, agentID)
		if err != nil || (agent.Mode != "enforcing" && agent.Mode != "permissive") {
			return nil
		}
		return &UndoPlan{
			Type:    "set_mode",
			Payload: mustJSON(map[string]any{"mode": agent.Mode}),
			Action:  "setenforce " + agent.Mode,
		}
	}
	return nil
}

func moduleUndo(name string) *UndoPlan {
	return &UndoPlan{
		Type:    "remove_module",
		Payload: mustJSON(map[string]any{"name": name}),
		Action:  "semodule -r " + name,
	}
}

func chconUndo(payloadJSON string) *UndoPlan {
	var p struct {
		Path      string `json:"path"`
		Recursive bool   `json:"recursive"`
	}
	if json.Unmarshal([]byte(payloadJSON), &p) != nil || !strings.HasPrefix(p.Path, "/") {
		return nil
	}
	action := "restorecon "
	if p.Recursive {
		action += "-R "
	}
	return &UndoPlan{
		Type:    "restorecon",
		Payload: mustJSON(map[string]any{"path": p.Path, "recursive": p.Recursive}),
		Action:  action + p.Path,
	}
}

// planFor returns the undo plan for an applied command: the one recorded at
// dispatch, or — for commands applied before recording existed — one
// derived from the payload alone where that is safe (a chcon is always
// undoable with restorecon; a module only if it carries the generated
// suggested_ name, which can't have pre-existed).
func planFor(c postgres.Command) *UndoPlan {
	if c.UndoJSON != "" {
		var plan UndoPlan
		if json.Unmarshal([]byte(c.UndoJSON), &plan) == nil && plan.Type != "" {
			return &plan
		}
		return nil
	}
	switch c.Type {
	case "chcon":
		return chconUndo(c.PayloadJSON)
	case "install_module":
		var p struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(c.PayloadJSON), &p) == nil && strings.HasPrefix(p.Name, "suggested_") {
			return moduleUndo(p.Name)
		}
	}
	return nil
}

// DescribeRevert decides what the Delete button on c does.
func DescribeRevert(c postgres.Command) RevertInfo {
	switch {
	case c.RevertPending:
		return RevertInfo{Kind: RevertNone, Reason: ReasonInFlight}
	case c.Type == "suggest_module":
		// Tracked by the Suggestions page (FK), and nothing to undo.
		return RevertInfo{Kind: RevertNone, Reason: ReasonNotSupported}
	case c.Status == "failed" || c.Status == "pending":
		return RevertInfo{Kind: RevertRecord}
	case c.Status == "acked":
		if plan := planFor(c); plan != nil {
			return RevertInfo{Kind: RevertMachine, Action: plan.Action}
		}
		return RevertInfo{Kind: RevertNone, Reason: ReasonUnknownPrevious}
	default: // sent: result not known yet
		return RevertInfo{Kind: RevertNone, Reason: ReasonInFlight}
	}
}

// RevertResult: exactly one of Deleted / Undo is set.
type RevertResult struct {
	Deleted bool              // nothing applied on the machine, entry removed
	Undo    *postgres.Command // undo dispatched; the entry goes once the agent acks it
}

// RevertCommand is the single entry point behind the dashboard's Delete
// button on an applied rule (see DescribeRevert for what it does per case).
func RevertCommand(ctx context.Context, store *postgres.Store, hub *Hub, id string) (RevertResult, error) {
	if err := store.ExpireStaleReverts(ctx, id); err != nil {
		return RevertResult{}, err
	}
	cmd, err := store.GetCommand(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RevertResult{}, ErrCommandNotFound
		}
		return RevertResult{}, err
	}

	info := DescribeRevert(cmd)
	switch info.Kind {
	case RevertRecord:
		if _, err := store.DeleteCommandAndReverts(ctx, id); err != nil {
			return RevertResult{}, err
		}
		return RevertResult{Deleted: true}, nil

	case RevertMachine:
		if !hub.IsConnected(cmd.AgentID) {
			return RevertResult{}, ErrAgentOffline
		}
		plan := planFor(cmd)
		undo, err := dispatch(ctx, store, hub, postgres.NewCommand{
			AgentID:          cmd.AgentID,
			Type:             plan.Type,
			PayloadJSON:      string(plan.Payload),
			RevertsCommandID: &id,
		})
		if err != nil {
			return RevertResult{}, err
		}
		return RevertResult{Undo: &undo}, nil

	default:
		return RevertResult{}, &NotRevertibleError{Reason: info.Reason}
	}
}

// completeRevertIfApplicable runs on every ack: when it is the successful
// ack of an undo command, the original rule and the undo itself are both
// removed — the rule is gone from the machine, so it leaves the list. A
// failed undo leaves both in place so the error stays visible and the
// operator can retry.
func (s *AgentLinkServer) completeRevertIfApplicable(ctx context.Context, commandID string, success bool, message string) {
	cmd, err := s.Store.GetCommand(ctx, commandID)
	if err != nil || cmd.RevertsCommandID == nil {
		return
	}
	if !success {
		s.Log.Warn("undo of an applied rule failed", "agent_id", cmd.AgentID, "undo_command_id", cmd.ID, "message", message)
		return
	}
	original := *cmd.RevertsCommandID
	if _, err := s.Store.DeleteCommandAndReverts(ctx, original); err != nil {
		s.Log.Error("remove reverted rule failed", "command_id", original, "error", err)
		return
	}
	s.Log.Info("applied rule undone and removed", "agent_id", cmd.AgentID, "command_id", original, "undo_type", cmd.Type, "result", message)
}

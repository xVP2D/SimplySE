package server

import (
	"context"
	"fmt"

	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
	"console-selinux/master/internal/store/postgres"
)

var commandTypeByName = map[string]selinuxv1.CommandType{
	"set_mode":       selinuxv1.CommandType_COMMAND_TYPE_SET_MODE,
	"set_boolean":    selinuxv1.CommandType_COMMAND_TYPE_SET_BOOLEAN,
	"install_module": selinuxv1.CommandType_COMMAND_TYPE_INSTALL_MODULE,
	"chcon":          selinuxv1.CommandType_COMMAND_TYPE_CHCON,
	"suggest_module": selinuxv1.CommandType_COMMAND_TYPE_SUGGEST_MODULE,
}

// DispatchCommand persists a command for agentID and, if the agent is
// currently connected, sends it immediately over its gRPC stream. The
// command row is created either way so the operator can see it queued.
func DispatchCommand(ctx context.Context, store *postgres.Store, hub *Hub, agentID string, ruleID *string, cmdType, payloadJSON string) (postgres.Command, error) {
	protoType, ok := commandTypeByName[cmdType]
	if !ok {
		return postgres.Command{}, fmt.Errorf("unknown command type %q", cmdType)
	}

	cmd, err := store.CreateCommand(ctx, agentID, ruleID, cmdType, payloadJSON)
	if err != nil {
		return postgres.Command{}, err
	}

	msg := &selinuxv1.ServerMessage{
		Payload: &selinuxv1.ServerMessage_Command{
			Command: &selinuxv1.Command{
				CommandId:   cmd.ID,
				Type:        protoType,
				PayloadJson: payloadJSON,
			},
		},
	}

	if err := hub.Dispatch(agentID, msg); err != nil {
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

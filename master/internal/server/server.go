package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"time"

	"google.golang.org/grpc/peer"

	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
	natsq "console-selinux/master/internal/queue/nats"
	"console-selinux/master/internal/store/postgres"
)

type AgentLinkServer struct {
	selinuxv1.UnimplementedAgentLinkServer

	Store *postgres.Store
	Queue *natsq.Queue
	Hub   *Hub
	Log   *slog.Logger
}

func (s *AgentLinkServer) Session(stream selinuxv1.AgentLink_SessionServer) error {
	ctx := stream.Context()

	first, err := stream.Recv()
	if err != nil {
		return fmt.Errorf("recv enroll message: %w", err)
	}
	enroll := first.GetEnroll()
	if enroll == nil {
		return fmt.Errorf("first message on stream must be EnrollInfo")
	}
	agentID := enroll.GetAgentId()
	if agentID == "" {
		return fmt.Errorf("enroll message missing agent_id")
	}

	ip := peerAddr(ctx)
	if err := s.Store.UpsertAgentEnroll(ctx, postgres.Agent{
		ID:            agentID,
		Hostname:      enroll.GetHostname(),
		IP:            ip,
		OSRelease:     enroll.GetOsRelease(),
		KernelVersion: enroll.GetKernelVersion(),
		AgentVersion:  enroll.GetAgentVersion(),
	}); err != nil {
		return fmt.Errorf("register agent %s: %w", agentID, err)
	}
	s.Log.Info("agent connected", "agent_id", agentID, "hostname", enroll.GetHostname(), "ip", ip)

	// Flush response headers now: nothing else is guaranteed to be sent
	// back to the agent until a command is dispatched, and the client's
	// Session() call otherwise blocks waiting for headers that never
	// come.
	if err := stream.SendHeader(nil); err != nil {
		return fmt.Errorf("send header to agent %s: %w", agentID, err)
	}

	outCh, unregister := s.Hub.Register(agentID)
	defer unregister()
	defer func() {
		if err := s.Store.MarkOffline(context.Background(), agentID); err != nil {
			s.Log.Error("mark agent offline failed", "agent_id", agentID, "error", err)
		}
		s.Log.Info("agent disconnected", "agent_id", agentID)
	}()

	recvErrCh := make(chan error, 1)
	go func() {
		for {
			msg, err := stream.Recv()
			if err != nil {
				recvErrCh <- err
				return
			}
			s.handleIncoming(ctx, agentID, msg)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-recvErrCh:
			return err
		case out, ok := <-outCh:
			if !ok {
				return nil
			}
			if err := stream.Send(out); err != nil {
				return fmt.Errorf("send to agent %s: %w", agentID, err)
			}
		}
	}
}

func (s *AgentLinkServer) handleIncoming(ctx context.Context, agentID string, msg *selinuxv1.AgentMessage) {
	switch p := msg.Payload.(type) {
	case *selinuxv1.AgentMessage_Heartbeat:
		hb := p.Heartbeat
		if err := s.Queue.PublishHeartbeat(ctx, natsq.HeartbeatMsg{
			AgentID:       agentID,
			TsUnix:        hb.GetTsUnix(),
			Mode:          hb.GetMode(),
			PolicyName:    hb.GetPolicyName(),
			PolicyVersion: hb.GetPolicyVersion(),
		}); err != nil {
			s.Log.Error("publish heartbeat failed", "agent_id", agentID, "error", err)
		}

	case *selinuxv1.AgentMessage_AvcEvent:
		ev := p.AvcEvent
		if err := s.Queue.PublishAvcEvent(ctx, natsq.AvcEventMsg{
			AgentID:  agentID,
			TsUnix:   ev.GetTsUnix(),
			SContext: ev.GetScontext(),
			TContext: ev.GetTcontext(),
			TClass:   ev.GetTclass(),
			Perms:    ev.GetPerms(),
			Comm:     ev.GetComm(),
			Path:     ev.GetPath(),
			PID:      ev.GetPid(),
			RawLine:  ev.GetRawLine(),
		}); err != nil {
			s.Log.Error("publish avc event failed", "agent_id", agentID, "error", err)
		}

	case *selinuxv1.AgentMessage_Ack:
		ack := p.Ack
		if err := s.Store.UpdateCommandAck(ctx, ack.GetCommandId(), ack.GetSuccess(), ack.GetMessage()); err != nil {
			s.Log.Error("update command ack failed", "command_id", ack.GetCommandId(), "error", err)
		}
		s.completeSuggestionIfApplicable(ctx, ack)

	case *selinuxv1.AgentMessage_SelinuxInventory:
		inv := p.SelinuxInventory
		booleans := make([]postgres.SelinuxBoolean, 0, len(inv.GetBooleans()))
		for _, b := range inv.GetBooleans() {
			booleans = append(booleans, postgres.SelinuxBoolean{Name: b.GetName(), Value: b.GetValue()})
		}
		modules := make([]postgres.SelinuxModule, 0, len(inv.GetModules()))
		for _, m := range inv.GetModules() {
			modules = append(modules, postgres.SelinuxModule{Name: m.GetName(), Version: m.GetVersion()})
		}
		collectedAt := time.Unix(inv.GetTsUnix(), 0)
		if err := s.Store.UpsertSelinuxState(ctx, agentID, booleans, modules, collectedAt); err != nil {
			s.Log.Error("upsert selinux state failed", "agent_id", agentID, "error", err)
		}

	default:
		s.Log.Warn("unknown message payload from agent", "agent_id", agentID)
	}
}

// completeSuggestionIfApplicable checks whether the acked command was a
// suggest_module request (see main.go's new_signature handling) and, if
// so, applies the agent's audit2allow result (or failure) to the tracking
// row in suggested_modules. A no-op for every other command type.
func (s *AgentLinkServer) completeSuggestionIfApplicable(ctx context.Context, ack *selinuxv1.CommandAck) {
	cmd, err := s.Store.GetCommand(ctx, ack.GetCommandId())
	if err != nil || cmd.Type != "suggest_module" {
		return
	}

	var teText, ppBase64, errMsg string
	success := ack.GetSuccess()
	if success {
		var result struct {
			TE       string `json:"te"`
			PPBase64 string `json:"pp_base64"`
		}
		if err := json.Unmarshal([]byte(ack.GetMessage()), &result); err != nil {
			success = false
			errMsg = fmt.Sprintf("failed to parse audit2allow result: %v", err)
		} else {
			teText, ppBase64 = result.TE, result.PPBase64
		}
	} else {
		errMsg = ack.GetMessage()
	}

	if err := s.Store.CompleteSuggestedModule(ctx, ack.GetCommandId(), success, teText, ppBase64, errMsg); err != nil {
		s.Log.Error("complete suggested module failed", "command_id", ack.GetCommandId(), "error", err)
	}
}

func peerAddr(ctx context.Context) string {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return ""
	}
	host, _, err := net.SplitHostPort(p.Addr.String())
	if err != nil {
		return p.Addr.String()
	}
	return host
}

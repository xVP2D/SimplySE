// Package server implements the gRPC AgentLink service: one persistent
// bidirectional stream per connected agent, multiplexing heartbeats, AVC
// events, commands and acks (see proto/selinux/v1/agent.proto).
package server

import (
	"fmt"
	"sync"

	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
)

// Hub tracks which agents currently have an open stream and lets the HTTP
// API dispatch commands to them without knowing about gRPC directly.
type Hub struct {
	mu     sync.Mutex
	agents map[string]chan *selinuxv1.ServerMessage
}

func NewHub() *Hub {
	return &Hub{agents: make(map[string]chan *selinuxv1.ServerMessage)}
}

// Register returns a channel the Connect handler should drain and send to
// the agent, plus a function to call when the stream closes.
func (h *Hub) Register(agentID string) (ch chan *selinuxv1.ServerMessage, unregister func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch = make(chan *selinuxv1.ServerMessage, 16)
	h.agents[agentID] = ch
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.agents[agentID] == ch {
			delete(h.agents, agentID)
			close(ch)
		}
	}
}

// Dispatch enqueues a message for delivery to agentID. It returns an error
// if the agent has no open stream.
func (h *Hub) Dispatch(agentID string, msg *selinuxv1.ServerMessage) error {
	// The lock is held across the send (it is non-blocking): unregister
	// closes the channel under the same lock, so releasing it first would
	// let a disconnect close the channel between the lookup and the send —
	// "send on closed channel", which takes the whole master down.
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.agents[agentID]
	if !ok {
		return fmt.Errorf("agent %s is not connected", agentID)
	}
	select {
	case ch <- msg:
		return nil
	default:
		return fmt.Errorf("agent %s command channel is full", agentID)
	}
}

func (h *Hub) IsConnected(agentID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.agents[agentID]
	return ok
}

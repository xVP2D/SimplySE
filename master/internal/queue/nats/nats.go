// Package nats publishes AVC events and heartbeats received over gRPC onto
// a JetStream stream, decoupling ingestion from processing (rules engine,
// Postgres/OpenSearch writes) as in the target architecture.
package nats

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

const (
	StreamName       = "EVENTS"
	SubjectHeartbeat = "agents.heartbeat"
	SubjectAvcEvent  = "avc.events"
)

type Queue struct {
	nc *nats.Conn
	js jetstream.JetStream
}

func Connect(ctx context.Context, url string) (*Queue, error) {
	nc, err := nats.Connect(url, nats.Name("console-selinux-master"))
	if err != nil {
		return nil, fmt.Errorf("connect nats: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("create jetstream context: %w", err)
	}

	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     StreamName,
		Subjects: []string{"agents.>", "avc.events"},
		Storage:  jetstream.FileStorage,
	})
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("create jetstream stream: %w", err)
	}

	return &Queue{nc: nc, js: js}, nil
}

func (q *Queue) Close() {
	q.nc.Close()
}

func (q *Queue) publish(ctx context.Context, subject string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal message for %s: %w", subject, err)
	}
	if _, err := q.js.Publish(ctx, subject, data); err != nil {
		return fmt.Errorf("publish to %s: %w", subject, err)
	}
	return nil
}

type HeartbeatMsg struct {
	AgentID       string `json:"agent_id"`
	TsUnix        int64  `json:"ts_unix"`
	Mode          string `json:"mode"`
	PolicyName    string `json:"policy_name"`
	PolicyVersion string `json:"policy_version"`
}

func (q *Queue) PublishHeartbeat(ctx context.Context, m HeartbeatMsg) error {
	return q.publish(ctx, SubjectHeartbeat, m)
}

type AvcEventMsg struct {
	AgentID  string   `json:"agent_id"`
	TsUnix   int64    `json:"ts_unix"`
	SContext string   `json:"scontext"`
	TContext string   `json:"tcontext"`
	TClass   string   `json:"tclass"`
	Perms    []string `json:"perms"`
	Comm     string   `json:"comm"`
	Path     string   `json:"path"`
	PID      string   `json:"pid"`
	RawLine  string   `json:"raw_line"`
}

func (q *Queue) PublishAvcEvent(ctx context.Context, m AvcEventMsg) error {
	return q.publish(ctx, SubjectAvcEvent, m)
}

// ConsumeHeartbeats and ConsumeAvcEvents each create a durable pull
// consumer and invoke handler for every message, acking on success.

func (q *Queue) ConsumeHeartbeats(ctx context.Context, handler func(HeartbeatMsg) error) error {
	return consume(ctx, q.js, "worker-heartbeat", SubjectHeartbeat, handler)
}

func (q *Queue) ConsumeAvcEvents(ctx context.Context, handler func(AvcEventMsg) error) error {
	return consume(ctx, q.js, "worker-avc-events", SubjectAvcEvent, handler)
}

func consume[T any](ctx context.Context, js jetstream.JetStream, durable, subject string, handler func(T) error) error {
	stream, err := js.Stream(ctx, StreamName)
	if err != nil {
		return fmt.Errorf("get stream %s: %w", StreamName, err)
	}
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       durable,
		FilterSubject: subject,
		AckPolicy:     jetstream.AckExplicitPolicy,
	})
	if err != nil {
		return fmt.Errorf("create consumer %s: %w", durable, err)
	}

	_, err = consumer.Consume(func(msg jetstream.Msg) {
		var v T
		if err := json.Unmarshal(msg.Data(), &v); err != nil {
			_ = msg.Nak()
			return
		}
		if err := handler(v); err != nil {
			_ = msg.NakWithDelay(2 * time.Second)
			return
		}
		_ = msg.Ack()
	})
	if err != nil {
		return fmt.Errorf("start consuming %s: %w", subject, err)
	}
	return nil
}

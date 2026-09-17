// Command master is the Console SELinux master server: it terminates
// mTLS gRPC connections from agents, relays their events through NATS
// JetStream into Postgres/OpenSearch, and exposes an HTTP/JSON API for the
// dashboard to browse agents/denials and deploy rules.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	"console-selinux/master/internal/api"
	"console-selinux/master/internal/certs"
	selinuxv1 "console-selinux/master/internal/gen/selinuxv1"
	natsq "console-selinux/master/internal/queue/nats"
	"console-selinux/master/internal/rules"
	"console-selinux/master/internal/server"
	"console-selinux/master/internal/store/opensearch"
	"console-selinux/master/internal/store/postgres"
)

type config struct {
	GRPCAddr      string
	HTTPAddr      string
	CertFile      string
	KeyFile       string
	CAFile        string
	PostgresDSN   string
	OpenSearchURL string
	NatsURL       string
}

func loadConfig() config {
	return config{
		GRPCAddr:      getenv("GRPC_ADDR", ":8443"),
		HTTPAddr:      getenv("HTTP_ADDR", ":8080"),
		CertFile:      getenv("TLS_CERT_FILE", "deploy/certs/master.crt"),
		KeyFile:       getenv("TLS_KEY_FILE", "deploy/certs/master.key"),
		CAFile:        getenv("TLS_CA_FILE", "deploy/certs/ca.crt"),
		PostgresDSN:   getenv("POSTGRES_DSN", "postgres://selinux:selinux@localhost:5432/selinux?sslmode=disable"),
		OpenSearchURL: getenv("OPENSEARCH_URL", "http://localhost:9200"),
		NatsURL:       getenv("NATS_URL", "nats://localhost:4222"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg := loadConfig()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pg, err := postgres.Open(ctx, cfg.PostgresDSN)
	if err != nil {
		return err
	}
	defer pg.Close()
	log.Info("connected to postgres")

	search, err := opensearch.Open(cfg.OpenSearchURL)
	if err != nil {
		return err
	}
	log.Info("connected to opensearch")

	queue, err := natsq.Connect(ctx, cfg.NatsURL)
	if err != nil {
		return err
	}
	defer queue.Close()
	log.Info("connected to nats jetstream")

	engine := rules.NewEngine()
	hub := server.NewHub()

	if err := queue.ConsumeHeartbeats(ctx, func(m natsq.HeartbeatMsg) error {
		return pg.UpdateHeartbeat(ctx, m.AgentID, m.Mode, m.PolicyName, m.PolicyVersion)
	}); err != nil {
		return err
	}
	if err := queue.ConsumeAvcEvents(ctx, func(m natsq.AvcEventMsg) error {
		for _, alert := range engine.Observe(rules.Observation{
			AgentID:  m.AgentID,
			SContext: m.SContext,
			TContext: m.TContext,
			TClass:   m.TClass,
			Perms:    m.Perms,
		}) {
			if err := pg.CreateAlert(ctx, postgres.Alert{
				Type:     alert.Type,
				Title:    alert.Title,
				Message:  alert.Message,
				AgentID:  alert.AgentID,
				SContext: alert.SContext,
				TContext: alert.TContext,
				TClass:   alert.TClass,
			}); err != nil {
				log.Error("create alert failed", "type", alert.Type, "error", err)
			}
		}
		return search.IndexAvcEvent(ctx, opensearch.AvcEvent{
			AgentID:  m.AgentID,
			TsUnix:   m.TsUnix,
			SContext: m.SContext,
			TContext: m.TContext,
			TClass:   m.TClass,
			Perms:    m.Perms,
			Comm:     m.Comm,
			Path:     m.Path,
			PID:      m.PID,
			RawLine:  m.RawLine,
		})
	}); err != nil {
		return err
	}
	log.Info("nats consumers started")

	tlsCfg, err := certs.ServerTLSConfig(cfg.CertFile, cfg.KeyFile, cfg.CAFile)
	if err != nil {
		return err
	}
	grpcServer := grpc.NewServer(grpc.Creds(credentials.NewTLS(tlsCfg)))
	selinuxv1.RegisterAgentLinkServer(grpcServer, &server.AgentLinkServer{
		Store: pg,
		Queue: queue,
		Hub:   hub,
		Log:   log,
	})

	grpcLis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		return err
	}
	go func() {
		log.Info("grpc server listening", "addr", cfg.GRPCAddr)
		if err := grpcServer.Serve(grpcLis); err != nil {
			log.Error("grpc server stopped", "error", err)
		}
	}()

	apiHandler := (&api.API{Store: pg, Search: search, Hub: hub, Rules: engine, Log: log}).Handler()
	httpServer := &http.Server{Addr: cfg.HTTPAddr, Handler: apiHandler}
	go func() {
		log.Info("http api listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server stopped", "error", err)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)

	// GracefulStop waits for active RPCs to finish on their own, which
	// never happens for an agent's long-lived Session stream. Force-close
	// after the shutdown deadline instead of hanging forever.
	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-shutdownCtx.Done():
		grpcServer.Stop()
	}

	return nil
}

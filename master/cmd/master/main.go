// Command master is the Console SELinux master server: it terminates
// mTLS gRPC connections from agents, relays their events through NATS
// JetStream into Postgres/OpenSearch, and exposes an HTTP/JSON API for the
// dashboard to browse agents/denials and deploy rules.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	// Enrollment: lets install-agent.sh fetch the shared agent mTLS
	// identity automatically instead of the operator scp-ing it by hand.
	// Empty EnrollToken disables the endpoint entirely. Known
	// simplification: one shared identity handed to every agent, not
	// per-agent issuance — see README.md.
	EnrollToken   string
	AgentCertFile string
	AgentKeyFile  string

	// FrontendDist points at the built dashboard (frontend/dist); empty
	// disables serving it (e.g. local dev, where it runs via its own
	// `npm run dev`). See api.API.FrontendDist.
	FrontendDist string
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
		EnrollToken:   getenv("ENROLL_TOKEN", ""),
		AgentCertFile: getenv("AGENT_CERT_FILE", "deploy/certs/agent-dev.crt"),
		AgentKeyFile:  getenv("AGENT_KEY_FILE", "deploy/certs/agent-dev.key"),
		FrontendDist:  getenv("FRONTEND_DIST", "frontend/dist"),
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
		// Fetched before the update so it reflects the mode as of the
		// *previous* heartbeat (or enrollment) — the only way to detect a
		// transition rather than just the current snapshot.
		prev, prevErr := pg.GetAgent(ctx, m.AgentID)
		if err := pg.UpdateHeartbeat(ctx, m.AgentID, m.Mode, m.PolicyName, m.PolicyVersion); err != nil {
			return err
		}
		if prevErr == nil && prev.Mode != "permissive" && m.Mode == "permissive" {
			if err := pg.CreateAlert(ctx, postgres.Alert{
				Type:     "mode_permissive",
				Title:    "Passage en mode permissive",
				Message:  fmt.Sprintf("L'agent %s est passé en mode permissive (était %s)", m.AgentID, prev.Mode),
				AgentID:  m.AgentID,
				Severity: "high",
			}); err != nil {
				log.Error("create mode_permissive alert failed", "agent_id", m.AgentID, "error", err)
			}
		}
		return nil
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
				Severity: alert.Severity,
			}); err != nil {
				log.Error("create alert failed", "type", alert.Type, "error", err)
			}

			// A signature never seen before is exactly the case audit2allow
			// assistance is for: generate a suggested module right away so
			// an operator has something to review without waiting for it
			// to recur. Generation only (see proto's SUGGEST_MODULE comment
			// and agent's action::suggest_module) — this never installs
			// anything on its own.
			if alert.Type == "new_signature" {
				moduleName := rules.SuggestedModuleName(rules.Observation{
					SContext: m.SContext, TContext: m.TContext, TClass: m.TClass,
				})
				payloadJSON, err := json.Marshal(map[string]any{
					"raw_lines":   []string{m.RawLine},
					"module_name": moduleName,
				})
				if err != nil {
					log.Error("marshal suggest_module payload failed", "error", err)
				} else if cmd, err := server.DispatchCommand(ctx, pg, hub, m.AgentID, nil, "suggest_module", string(payloadJSON)); err != nil {
					log.Error("dispatch suggest_module failed", "agent_id", m.AgentID, "error", err)
				} else if _, err := pg.CreateSuggestedModule(ctx, cmd.ID, m.AgentID, moduleName, m.SContext, m.TContext, m.TClass); err != nil {
					log.Error("create suggested module failed", "agent_id", m.AgentID, "error", err)
				}
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

	if cfg.EnrollToken == "" {
		log.Warn("ENROLL_TOKEN not set: automatic agent enrollment (GET /api/enroll) is disabled; agents need certs copied by hand")
	}
	if _, err := os.Stat(cfg.FrontendDist); err != nil {
		log.Warn("frontend dist not found, dashboard will not be served (API only)", "path", cfg.FrontendDist)
	} else {
		log.Info("serving dashboard", "path", cfg.FrontendDist)
	}
	apiHandler := (&api.API{
		Store: pg, Search: search, Hub: hub, Rules: engine, Log: log,
		EnrollToken:   cfg.EnrollToken,
		EnrollCAFile:  cfg.CAFile,
		EnrollCrtFile: cfg.AgentCertFile,
		EnrollKeyFile: cfg.AgentKeyFile,
		FrontendDist:  cfg.FrontendDist,
	}).Handler()
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

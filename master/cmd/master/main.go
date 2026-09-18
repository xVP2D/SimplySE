// Command master is the Console SELinux master server: it terminates
// mTLS gRPC connections from agents, relays their events through NATS
// JetStream into Postgres/OpenSearch, and exposes an HTTP/JSON API for the
// dashboard to browse agents/denials and deploy rules.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"

	"console-selinux/master/internal/api"
	"console-selinux/master/internal/certs"
	"console-selinux/master/internal/correlate"
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

	// OpenSearchAVCRetentionDays: how long a avc_events-* daily index
	// (see internal/store/opensearch) is kept before an ISM policy
	// deletes it — the knob for "large volume" deployments where keeping
	// every AVC event forever would eventually fill the disk.
	OpenSearchAVCRetentionDays int

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

		OpenSearchAVCRetentionDays: getenvInt("OPENSEARCH_AVC_RETENTION_DAYS", 30),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
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

	// Idempotent: safe (and necessary) to re-apply on every boot so a
	// changed OPENSEARCH_AVC_RETENTION_DAYS actually takes effect. Never
	// fatal — an OpenSearch build without the ISM plugin, or one that's
	// briefly unreachable, shouldn't block the whole master from starting.
	if err := search.EnsureRetentionPolicy(ctx, cfg.OpenSearchAVCRetentionDays); err != nil {
		log.Warn("opensearch avc_events retention policy not applied", "error", err)
	} else {
		log.Info("opensearch avc_events retention policy applied", "retention_days", cfg.OpenSearchAVCRetentionDays)
	}

	queue, err := natsq.Connect(ctx, cfg.NatsURL)
	if err != nil {
		return err
	}
	defer queue.Close()
	log.Info("connected to nats jetstream")

	engine := rules.NewEngine()
	hub := server.NewHub()
	collector := &server.Collector{Store: pg, Search: search, Hub: hub, Log: log}
	go collector.Run(ctx)

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
		obs := rules.Observation{
			AgentID:  m.AgentID,
			SContext: m.SContext,
			TContext: m.TContext,
			TClass:   m.TClass,
			Perms:    m.Perms,
		}
		for _, alert := range engine.Observe(obs) {
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
		}

		// A (machine, signature, permissions) never seen before is exactly
		// the case audit2allow assistance is for: generate a suggested
		// module right away so an operator has something to review without
		// waiting for it to recur — the same request an operator can also
		// trigger by hand from a denial row (see server.RequestModuleSuggestion).
		// Separate from the new-signature alert on purpose: a new permission
		// on a known signature, or the same signature on another machine,
		// needs its own suggestion but isn't a "new signature".
		// Paused for a domain under a "collect all denials" run: that run
		// produces one suggestion for everything instead.
		if !collector.Suppresses(m.AgentID, m.SContext) && engine.NeedsSuggestion(obs) {
			if _, err := server.RequestModuleSuggestion(ctx, pg, hub, m.AgentID, m.SContext, m.TContext, m.TClass, m.RawLine); err != nil {
				log.Error("request module suggestion failed", "agent_id", m.AgentID, "error", err)
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
	// Without an explicit EnforcementPolicy, grpc-go's server-side default
	// MinTime is 5 minutes — far above the agent's own 15s HTTP/2 keepalive
	// ping interval (agent/src/grpc.rs's http2_keep_alive_interval). The
	// server was treating every one of those pings as a flood ("too many
	// pings") and forcibly closing the connection with GOAWAY once enough
	// accumulated, which is exactly what the agent logged as a recurring
	// "h2 protocol error ... broken pipe" every ~60-70s — confirmed by
	// checking real agent logs showing this cycle repeating continuously
	// since enrollment. MinTime here must be <= the agent's actual ping
	// interval; PermitWithoutStream is harmless to allow too, in case a
	// future client ever pings between streams.
	grpcServer := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(tlsCfg)),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	// Hides denials the moment the policy on their machine would allow them
	// (see server.DenialChecker) — 30s covers changes made by hand on a
	// machine; rules applied from here are checked immediately on their ack.
	checker := &server.DenialChecker{Search: search, Hub: hub, Log: log}
	go checker.Run(ctx, 30*time.Second)
	selinuxv1.RegisterAgentLinkServer(grpcServer, &server.AgentLinkServer{
		Store:     pg,
		Queue:     queue,
		Hub:       hub,
		Log:       log,
		Checker:   checker,
		Collector: collector,
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

	// Correlation (Phase E) connectors are configured from the dashboard's
	// Settings page (Postgres-backed, see internal/api/integrations.go),
	// not env vars — loaded once here at startup and reloaded in place by
	// every settings save, so a save takes effect immediately with no
	// restart.
	correlateRegistry := correlate.NewRegistry()
	if err := api.RebuildCorrelateRegistry(ctx, pg, correlateRegistry, log); err != nil {
		log.Error("load correlation settings failed", "error", err)
	}
	if !correlateRegistry.HasSources() {
		log.Info("no correlation sources configured (Paramètres > Intégrations) — cross-source correlation disabled")
	}

	apiHandler := (&api.API{
		Store: pg, Search: search, Hub: hub, Rules: engine, Log: log,
		EnrollToken:   cfg.EnrollToken,
		EnrollCAFile:  cfg.CAFile,
		EnrollCrtFile: cfg.AgentCertFile,
		EnrollKeyFile: cfg.AgentKeyFile,
		FrontendDist:  cfg.FrontendDist,
		Correlate:     correlateRegistry,
		Collector:     collector,
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

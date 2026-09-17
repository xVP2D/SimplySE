// Package api exposes the HTTP/JSON API the dashboard talks to: agent
// inventory, denial browsing, rule deployment and command status.
package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"

	"console-selinux/master/internal/rules"
	"console-selinux/master/internal/server"
	"console-selinux/master/internal/store/opensearch"
	"console-selinux/master/internal/store/postgres"
)

var errBadDeployRequest = errors.New("name, type and agent_ids are required")

type API struct {
	Store  *postgres.Store
	Search *opensearch.Store
	Hub    *server.Hub
	Rules  *rules.Engine
	Log    *slog.Logger

	// Enrollment: serves the shared agent mTLS identity to
	// install-agent.sh over GET /api/enroll, gated by a bearer token so
	// this cert material isn't handed to anyone who can merely reach this
	// port. EnrollToken == "" disables the endpoint entirely. Known
	// simplification: one shared identity for every agent, not per-agent
	// issuance — see README.md.
	EnrollToken   string
	EnrollCAFile  string
	EnrollCrtFile string
	EnrollKeyFile string
}

func (a *API) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/agents", a.listAgents)
	mux.HandleFunc("GET /api/agents/{id}", a.getAgent)
	mux.HandleFunc("GET /api/denials", a.listDenials)
	mux.HandleFunc("GET /api/denials/top", a.topSignatures)
	mux.HandleFunc("POST /api/rules/deploy", a.deployRule)
	mux.HandleFunc("GET /api/commands/{id}", a.getCommand)
	mux.HandleFunc("GET /api/commands/recent", a.listRecentCommands)
	mux.HandleFunc("GET /api/alerts", a.listAlerts)
	mux.HandleFunc("POST /api/alerts/{id}/ack", a.acknowledgeAlert)
	mux.HandleFunc("GET /api/enroll/{file}", a.enroll)
	mux.HandleFunc("GET /api/health", a.health)
	return mux
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Handler returns the CORS-wrapped mux, ready to be passed to http.Server.
func (a *API) Handler() http.Handler {
	return withCORS(a.Routes())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// enrollFileByName maps the {file} path segment of GET /api/enroll/{file}
// to the local path it should serve — plain text, one file per request,
// so install-agent.sh can fetch each with a single `curl -o`, no JSON
// parsing needed on a shell script's part.
func (a *API) enrollFileByName(name string) string {
	switch name {
	case "ca.crt":
		return a.EnrollCAFile
	case "agent.crt":
		return a.EnrollCrtFile
	case "agent.key":
		return a.EnrollKeyFile
	default:
		return ""
	}
}

// enroll serves the shared agent mTLS identity (ca.crt, agent-dev.crt,
// agent-dev.key, requested as ca.crt/agent.crt/agent.key respectively) so
// install-agent.sh can fetch it automatically instead of the operator
// copying files by hand. Gated by a bearer token generated once by
// install-master.sh (ENROLL_TOKEN) — never logged, compared in constant
// time to avoid a timing side-channel.
func (a *API) enroll(w http.ResponseWriter, r *http.Request) {
	if a.EnrollToken == "" {
		writeError(w, http.StatusServiceUnavailable, errors.New("enrollment is disabled on this master (no ENROLL_TOKEN configured)"))
		return
	}

	token := bearerToken(r)
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.EnrollToken)) != 1 {
		a.Log.Warn("enrollment request rejected: invalid or missing token", "remote_addr", r.RemoteAddr)
		writeError(w, http.StatusUnauthorized, errors.New("invalid or missing enrollment token"))
		return
	}

	path := a.enrollFileByName(r.PathValue("file"))
	if path == "" {
		writeError(w, http.StatusNotFound, fmt.Errorf("unknown enrollment file %q (expected ca.crt, agent.crt or agent.key)", r.PathValue("file")))
		return
	}

	content, err := os.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("read %s: %w", r.PathValue("file"), err))
		return
	}

	a.Log.Info("agent enrollment file served", "file", r.PathValue("file"), "remote_addr", r.RemoteAddr)
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, prefix) {
		return strings.TrimPrefix(h, prefix)
	}
	return r.URL.Query().Get("token")
}

func (a *API) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := a.Store.ListAgents(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	type agentOut struct {
		postgres.Agent
		Connected bool `json:"connected"`
	}
	out := make([]agentOut, 0, len(agents))
	for _, ag := range agents {
		out = append(out, agentOut{Agent: ag, Connected: a.Hub.IsConnected(ag.ID)})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) getAgent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	agent, err := a.Store.GetAgent(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agent":     agent,
		"connected": a.Hub.IsConnected(id),
	})
}

func (a *API) listDenials(w http.ResponseWriter, r *http.Request) {
	result, err := a.Search.Search(r.Context(), opensearch.SearchOptions{
		AgentID: r.URL.Query().Get("agent_id"),
		Query:   r.URL.Query().Get("q"),
		From:    parseNonNegativeInt(r, "offset", 0),
		Size:    parseLimit(r, 50),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) topSignatures(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 10)
	writeJSON(w, http.StatusOK, a.Rules.TopSignatures(limit))
}

type deployRuleRequest struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"` // set_mode | set_boolean | install_module | chcon
	PayloadJSON string   `json:"payload_json"`
	AgentIDs    []string `json:"agent_ids"`
	CreatedBy   string   `json:"created_by"`
}

// deployRule creates a rule and dispatches one command per target agent.
// It supports an optional Idempotency-Key header: retrying the same
// request with the same key (e.g. after a client-side timeout that left
// the outcome ambiguous) replays the original response instead of
// deploying the rule again. Concurrent requests racing on the same key are
// also rejected rather than double-deployed (see
// postgres.BeginIdempotentRequest).
func (a *API) deployRule(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	var req deployRuleRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Name == "" || req.Type == "" || len(req.AgentIDs) == 0 {
		writeError(w, http.StatusBadRequest, errBadDeployRequest)
		return
	}

	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		status, body := a.executeDeployRule(r.Context(), req)
		writeJSON(w, status, body)
		return
	}

	requestHash := hashIdempotentRequest(r.Method, r.URL.Path, bodyBytes)
	existing, claimed, err := a.Store.BeginIdempotentRequest(r.Context(), idemKey, requestHash)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !claimed {
		if existing.RequestHash != requestHash {
			writeError(w, http.StatusConflict, fmt.Errorf("idempotency key %q was already used for a different request", idemKey))
			return
		}
		if existing.Status == "completed" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(existing.ResponseStatus)
			_, _ = w.Write(existing.ResponseBody)
			return
		}
		writeError(w, http.StatusConflict, fmt.Errorf("a request with idempotency key %q is already in progress", idemKey))
		return
	}

	status, body := a.executeDeployRule(r.Context(), req)
	respBytes, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.Store.CompleteIdempotentRequest(r.Context(), idemKey, status, respBytes); err != nil {
		a.Log.Error("complete idempotency record failed", "key", idemKey, "error", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(respBytes)
}

// executeDeployRule is the actual side-effecting work behind deployRule,
// separated out so it runs exactly once per idempotency key.
func (a *API) executeDeployRule(ctx context.Context, req deployRuleRequest) (int, any) {
	createdBy := req.CreatedBy
	if createdBy == "" {
		createdBy = "operator"
	}

	rule, err := a.Store.CreateRule(ctx, req.Name, req.Type, req.PayloadJSON, createdBy)
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"error": err.Error()}
	}

	commands := make([]postgres.Command, 0, len(req.AgentIDs))
	for _, agentID := range req.AgentIDs {
		cmd, err := server.DispatchCommand(ctx, a.Store, a.Hub, agentID, &rule.ID, req.Type, req.PayloadJSON)
		if err != nil {
			a.Log.Error("dispatch command failed", "agent_id", agentID, "error", err)
			continue
		}
		commands = append(commands, cmd)
	}

	return http.StatusCreated, map[string]any{
		"rule":     rule,
		"commands": commands,
	}
}

func hashIdempotentRequest(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte(path))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func (a *API) getCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cmd, err := a.Store.GetCommand(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, cmd)
}

func (a *API) listRecentCommands(w http.ResponseWriter, r *http.Request) {
	result, err := a.Store.ListCommands(r.Context(), postgres.ListCommandsOptions{
		AgentID: r.URL.Query().Get("agent_id"),
		Status:  r.URL.Query().Get("status"),
		Offset:  parseNonNegativeInt(r, "offset", 0),
		Limit:   parseLimit(r, 20),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) listAlerts(w http.ResponseWriter, r *http.Request) {
	result, err := a.Store.ListAlerts(r.Context(), postgres.ListAlertsOptions{
		Status: r.URL.Query().Get("status"),
		Offset: parseNonNegativeInt(r, "offset", 0),
		Limit:  parseLimit(r, 20),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type acknowledgeAlertRequest struct {
	By string `json:"by"`
}

func (a *API) acknowledgeAlert(w http.ResponseWriter, r *http.Request) {
	var req acknowledgeAlertRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body is optional
	by := req.By
	if by == "" {
		by = "operator"
	}
	if err := a.Store.AcknowledgeAlert(r.Context(), r.PathValue("id"), by); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "acknowledged"})
}

func parseLimit(r *http.Request, def int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func parseNonNegativeInt(r *http.Request, param string, def int) int {
	raw := r.URL.Query().Get(param)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return def
	}
	return n
}

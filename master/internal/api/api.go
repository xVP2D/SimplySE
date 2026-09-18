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
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"console-selinux/master/internal/correlate"
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

	// FrontendDist, if non-empty, serves the built dashboard (a Vite SPA)
	// from this directory at "/" — everything not matched by a more
	// specific /api/* pattern falls through to it, with unknown paths
	// resolving to index.html so client-side routing (react-router) works
	// on a hard refresh. Left empty, only the API is served (e.g. local
	// dev, where the frontend runs via its own `npm run dev` instead).
	FrontendDist string

	// Correlate holds whichever external SIEM/EDR/monitoring connectors
	// are enabled on the dashboard's Settings page (see
	// RebuildCorrelateRegistry) — may be an empty, non-nil registry when
	// none are.
	Correlate *correlate.Registry
}

func (a *API) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/agents", a.listAgents)
	mux.HandleFunc("GET /api/agents/{id}", a.getAgent)
	mux.HandleFunc("GET /api/agents/{id}/selinux", a.getAgentSelinux)
	mux.HandleFunc("GET /api/agents/{id}/correlate", a.correlateAgent)
	mux.HandleFunc("GET /api/correlate/sources", a.correlateSources)
	mux.HandleFunc("GET /api/integrations", a.getIntegrations)
	mux.HandleFunc("PUT /api/integrations/siem-opensearch", a.putSIEMOpenSearch)
	mux.HandleFunc("POST /api/integrations/siem-opensearch/test", a.testSIEMOpenSearch)
	mux.HandleFunc("PUT /api/integrations/librenms", a.putLibreNMS)
	mux.HandleFunc("POST /api/integrations/librenms/test", a.testLibreNMS)
	mux.HandleFunc("GET /api/denials", a.listDenials)
	mux.HandleFunc("GET /api/denials/top", a.topSignatures)
	mux.HandleFunc("GET /api/denials/matrix", a.denialMatrix)
	mux.HandleFunc("GET /api/denials/trend", a.denialTrend)
	mux.HandleFunc("POST /api/denials/suggest", a.suggestModuleForDenial)
	mux.HandleFunc("POST /api/denials/quarantine", a.quarantineDenial)
	mux.HandleFunc("POST /api/denials/restore", a.restoreDenial)
	mux.HandleFunc("DELETE /api/denials/{index}/{id}", a.deleteDenial)
	mux.HandleFunc("GET /api/suggested-modules", a.listSuggestedModules)
	mux.HandleFunc("GET /api/suggested-modules/{id}", a.getSuggestedModule)
	mux.HandleFunc("POST /api/suggested-modules/{id}/approve", a.approveSuggestedModule)
	mux.HandleFunc("POST /api/suggested-modules/{id}/reject", a.rejectSuggestedModule)
	mux.HandleFunc("POST /api/rules/deploy", a.deployRule)
	mux.HandleFunc("GET /api/commands/{id}", a.getCommand)
	mux.HandleFunc("GET /api/commands/recent", a.listRecentCommands)
	mux.HandleFunc("POST /api/commands/{id}/revert", a.revertCommand)
	mux.HandleFunc("GET /api/alerts", a.listAlerts)
	mux.HandleFunc("POST /api/alerts/{id}/ack", a.acknowledgeAlert)
	mux.HandleFunc("GET /api/enroll/{file}", a.enroll)
	mux.HandleFunc("GET /api/health", a.health)
	if a.FrontendDist != "" {
		mux.Handle("/", spaHandler(a.FrontendDist))
	}
	return mux
}

// spaHandler serves static files from dist, falling back to
// dist/index.html for any path that isn't an existing file — so a hard
// refresh on e.g. /agents/xyz still loads the app and lets react-router
// take over client-side, instead of 404ing.
func spaHandler(dist string) http.HandlerFunc {
	fileServer := http.FileServer(http.Dir(dist))
	return func(w http.ResponseWriter, r *http.Request) {
		cleaned := filepath.Clean(r.URL.Path)
		full := filepath.Join(dist, cleaned)
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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

// getAgentSelinux returns the latest SELinux inventory snapshot (booleans +
// loaded policy modules) reported by this agent. An agent that hasn't sent
// one yet (just enrolled, or running a pre-inventory build) isn't an
// error: it returns empty lists rather than 404, since "no data yet" is a
// normal, expected state here.
func (a *API) getAgentSelinux(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	state, _, err := a.Store.GetSelinuxState(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// correlateSources reports which external SIEM/EDR/monitoring connectors
// are actually configured, so the dashboard only shows the "correlate"
// action where it would do something.
func (a *API) correlateSources(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	if a.Correlate != nil {
		names = a.Correlate.SourceNames()
	}
	writeJSON(w, http.StatusOK, names)
}

// correlateAgent queries every configured source live for events on this
// agent's host around the given time — on demand, for this one host and
// a narrow window, never a bulk/continuous fetch (see internal/correlate's
// package doc). ?around= is a unix timestamp (default: now); ?window= is
// the +/- seconds around it to search (default 60).
func (a *API) correlateAgent(w http.ResponseWriter, r *http.Request) {
	if a.Correlate == nil || !a.Correlate.HasSources() {
		writeJSON(w, http.StatusOK, []correlate.Event{})
		return
	}
	agent, err := a.Store.GetAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	around := time.Unix(int64(parseNonNegativeInt(r, "around", int(time.Now().Unix()))), 0)
	window := time.Duration(parseNonNegativeInt(r, "window", 60)) * time.Second

	events := a.Correlate.QueryAll(r.Context(), agent.IP, agent.Hostname, around, window)
	writeJSON(w, http.StatusOK, events)
}

func (a *API) listDenials(w http.ResponseWriter, r *http.Request) {
	result, err := a.Search.Search(r.Context(), opensearch.SearchOptions{
		AgentID: r.URL.Query().Get("agent_id"),
		Query:   r.URL.Query().Get("q"),
		From:    parseNonNegativeInt(r, "offset", 0),
		Size:    parseLimit(r, 50),
		// ?quarantined=true lists the Quarantine page's denials instead.
		Quarantined: r.URL.Query().Get("quarantined") == "true",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type denialRef struct {
	Index string `json:"index"`
	ID    string `json:"id"`
}

// denialStateChange maps the store's typed errors to HTTP statuses: a
// malformed reference is the caller's mistake (400), a missing document 404.
func denialStateChange(w http.ResponseWriter, err error, status string) {
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]string{"status": status})
	case errors.Is(err, opensearch.ErrInvalidEventRef):
		writeError(w, http.StatusBadRequest, err)
	case errors.Is(err, opensearch.ErrEventNotFound):
		writeError(w, http.StatusNotFound, err)
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
}

func (a *API) setDenialQuarantined(w http.ResponseWriter, r *http.Request, quarantined bool, status string) {
	var ref denialRef
	if err := json.NewDecoder(r.Body).Decode(&ref); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	denialStateChange(w, a.Search.SetQuarantined(r.Context(), ref.Index, ref.ID, quarantined), status)
}

func (a *API) quarantineDenial(w http.ResponseWriter, r *http.Request) {
	a.setDenialQuarantined(w, r, true, "quarantined")
}

func (a *API) restoreDenial(w http.ResponseWriter, r *http.Request) {
	a.setDenialQuarantined(w, r, false, "restored")
}

func (a *API) deleteDenial(w http.ResponseWriter, r *http.Request) {
	denialStateChange(w, a.Search.DeleteEvent(r.Context(), r.PathValue("index"), r.PathValue("id")), "deleted")
}

func (a *API) topSignatures(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 10)
	writeJSON(w, http.StatusOK, a.Rules.TopSignatures(limit))
}

// denialMatrix aggregates AVC events fleet-wide by (scontext, tcontext,
// tclass), ordered by how many distinct agents hit each signature — see
// opensearch.Store.Matrix. ?days= bounds the window (default 30, 0 means
// "all history").
func (a *API) denialMatrix(w http.ResponseWriter, r *http.Request) {
	days := parseNonNegativeInt(r, "days", 30)
	var sinceUnix int64
	if days > 0 {
		sinceUnix = time.Now().AddDate(0, 0, -days).Unix()
	}
	rows, err := a.Search.Matrix(r.Context(), opensearch.MatrixOptions{
		SinceUnix: sinceUnix,
		Limit:     parseLimit(r, 50),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// denialTrend returns a per-agent, per-day denial count over the window
// (default last 14 days) — plotted as a small sparkline per host on the
// dashboard to catch a regression right after a policy/boolean change.
func (a *API) denialTrend(w http.ResponseWriter, r *http.Request) {
	days := parseNonNegativeInt(r, "days", 14)
	if days <= 0 {
		days = 14
	}
	now := time.Now()
	points, err := a.Search.Trend(r.Context(), opensearch.TrendOptions{
		SinceUnix: now.AddDate(0, 0, -days).Unix(),
		UntilUnix: now.Unix(),
		AgentID:   r.URL.Query().Get("agent_id"),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, points)
}

type suggestModuleForDenialRequest struct {
	AgentID  string `json:"agent_id"`
	SContext string `json:"scontext"`
	TContext string `json:"tcontext"`
	TClass   string `json:"tclass"`
	RawLine  string `json:"raw_line"`
}

// suggestModuleForDenial is the "fix this on this machine" button on a
// denial row: an operator-triggered equivalent of the automatic
// new_signature suggestion, for a denial that's already been seen before
// (so it never got one automatically) or one the operator just wants
// addressed now rather than waiting. Same generation-only guarantee: see
// server.RequestModuleSuggestion.
func (a *API) suggestModuleForDenial(w http.ResponseWriter, r *http.Request) {
	var req suggestModuleForDenialRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.AgentID == "" || req.SContext == "" || req.TContext == "" || req.TClass == "" || req.RawLine == "" {
		writeError(w, http.StatusBadRequest, errors.New("agent_id, scontext, tcontext, tclass and raw_line are required"))
		return
	}
	m, err := server.RequestModuleSuggestion(r.Context(), a.Store, a.Hub, req.AgentID, req.SContext, req.TContext, req.TClass, req.RawLine)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *API) listSuggestedModules(w http.ResponseWriter, r *http.Request) {
	result, err := a.Store.ListSuggestedModules(r.Context(), postgres.ListSuggestedModulesOptions{
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

func (a *API) getSuggestedModule(w http.ResponseWriter, r *http.Request) {
	m, err := a.Store.GetSuggestedModule(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

type reviewSuggestedModuleRequest struct {
	AgentIDs   []string `json:"agent_ids"`
	ReviewedBy string   `json:"reviewed_by"`
}

// approveSuggestedModule is the only place a suggested module's pp_base64
// ever gets pushed anywhere — it dispatches an ordinary install_module
// command (the same one the manual "deploy a rule" flow uses) to each
// agent_id the operator picked, then records the approval. There is no
// path that installs a suggestion without this explicit, human-triggered
// call.
func (a *API) approveSuggestedModule(w http.ResponseWriter, r *http.Request) {
	var req reviewSuggestedModuleRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body is optional except for agent_ids, checked below
	reviewedBy := req.ReviewedBy
	if reviewedBy == "" {
		reviewedBy = "operator"
	}
	if len(req.AgentIDs) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("agent_ids is required"))
		return
	}

	m, err := a.Store.GetSuggestedModule(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if m.Status != "pending" {
		writeError(w, http.StatusConflict, fmt.Errorf("suggestion is %q, not pending", m.Status))
		return
	}

	payloadJSON, err := json.Marshal(map[string]any{"name": m.ModuleName, "content_base64": m.PPBase64})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	commands := make([]postgres.Command, 0, len(req.AgentIDs))
	for _, agentID := range req.AgentIDs {
		cmd, err := server.DispatchCommand(r.Context(), a.Store, a.Hub, agentID, nil, "install_module", string(payloadJSON))
		if err != nil {
			a.Log.Error("dispatch install_module for approved suggestion failed", "agent_id", agentID, "error", err)
			continue
		}
		commands = append(commands, cmd)
	}

	if err := a.Store.ReviewSuggestedModule(r.Context(), m.ID, "approved", reviewedBy); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "approved", "commands": commands})
}

func (a *API) rejectSuggestedModule(w http.ResponseWriter, r *http.Request) {
	var req reviewSuggestedModuleRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	reviewedBy := req.ReviewedBy
	if reviewedBy == "" {
		reviewedBy = "operator"
	}
	if err := a.Store.ReviewSuggestedModule(r.Context(), r.PathValue("id"), "rejected", reviewedBy); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "rejected"})
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

// commandView is a command plus what its Delete button does (see
// server.DescribeRevert): flattened into one JSON object.
type commandView struct {
	postgres.Command
	server.RevertInfo
}

func newCommandView(c postgres.Command) commandView {
	return commandView{Command: c, RevertInfo: server.DescribeRevert(c)}
}

func (a *API) getCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cmd, err := a.Store.GetCommand(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, newCommandView(cmd))
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// revertCommand backs the Delete button on an applied rule: it undoes the
// rule on the machine (asynchronously — 202, the entry disappears once the
// agent confirms), or just removes the entry when nothing was applied.
func (a *API) revertCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, errors.New("invalid command id"))
		return
	}
	res, err := server.RevertCommand(r.Context(), a.Store, a.Hub, id)
	var notRevertible *server.NotRevertibleError
	switch {
	case err == nil && res.Deleted:
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	case err == nil:
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "reverting", "command": newCommandView(*res.Undo)})
	case errors.Is(err, server.ErrCommandNotFound):
		writeError(w, http.StatusNotFound, err)
	case errors.Is(err, server.ErrAgentOffline), errors.Is(err, postgres.ErrRevertInProgress):
		writeError(w, http.StatusConflict, err)
	case errors.As(err, &notRevertible):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "reason": notRevertible.Reason})
	default:
		writeError(w, http.StatusInternalServerError, err)
	}
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
	views := make([]commandView, 0, len(result.Commands))
	for _, c := range result.Commands {
		views = append(views, newCommandView(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": views, "total": result.Total})
}

func (a *API) listAlerts(w http.ResponseWriter, r *http.Request) {
	result, err := a.Store.ListAlerts(r.Context(), postgres.ListAlertsOptions{
		Status:   r.URL.Query().Get("status"),
		Severity: r.URL.Query().Get("severity"),
		Offset:   parseNonNegativeInt(r, "offset", 0),
		Limit:    parseLimit(r, 20),
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

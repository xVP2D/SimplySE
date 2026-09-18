package api

import (
	"net/http"
	"strconv"
	"strings"

	"console-selinux/master/internal/store/postgres"
)

// getHistory serves aggregated permanent history, e.g.
// GET /api/history/denials?days=90&bucket=day&group=agent,tclass
//
// The grouping dimensions and datasets are a fixed whitelist (see
// postgres.NormalizeHistoryQuery); rows carry "t" (bucket start, unix
// seconds, absent with bucket=none), one field per grouping dimension and
// the dataset's measures.
func (a *API) getHistory(w http.ResponseWriter, r *http.Request) {
	dataset := r.PathValue("dataset")
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	var group []string
	if g := r.URL.Query().Get("group"); g != "" {
		group = strings.Split(g, ",")
	}
	q, err := postgres.NormalizeHistoryQuery(dataset, days, r.URL.Query().Get("bucket"), group)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	res, err := a.Store.QueryHistory(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dataset":   q.Dataset,
		"days":      q.Days,
		"bucket":    q.Bucket,
		"group":     q.Group,
		"rows":      res.Rows,
		"truncated": res.Truncated,
	})
}

// getHistoryStatus tells, per dataset, when its recorded history starts —
// the dashboard shows it so a chart never implies data from before the
// history existed.
func (a *API) getHistoryStatus(w http.ResponseWriter, r *http.Request) {
	status, err := a.Store.HistoryStatus(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"retention_days": a.HistoryRetentionDays,
		"datasets":       status,
	})
}

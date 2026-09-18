package api

import (
	"encoding/json"
	"net/http"
)

// getDashboardLayout returns the saved widget grid verbatim (the frontend
// owns the shape of each widget entry — type, position, size, per-widget
// settings — this layer only persists the blob). An empty array means
// nothing has been customized yet, and the frontend applies its built-in
// default layout.
func (a *API) getDashboardLayout(w http.ResponseWriter, r *http.Request) {
	raw, found, err := a.Store.GetDashboardLayout(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !found {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"widgets":[]}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"widgets":`))
	w.Write(raw)
	w.Write([]byte(`}`))
}

func (a *API) putDashboardLayout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Widgets json.RawMessage `json:"widgets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Widgets == nil {
		req.Widgets = json.RawMessage("[]")
	}
	if err := a.Store.SaveDashboardLayout(r.Context(), req.Widgets); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

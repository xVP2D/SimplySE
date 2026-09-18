package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"console-selinux/master/internal/correlate"
	"console-selinux/master/internal/store/postgres"
)

const (
	integrationKeySIEMOpenSearch = "siem_opensearch"
	integrationKeyLibreNMS       = "librenms"
)

// RebuildCorrelateRegistry reads both integration settings from Postgres
// and replaces registry's source list with whichever are enabled — the
// single place this ever happens, called both at master startup and
// after every settings save (see the put*/test* handlers below), so
// saving a connector from the dashboard takes effect immediately with no
// master restart.
func RebuildCorrelateRegistry(ctx context.Context, store *postgres.Store, registry *correlate.Registry, log *slog.Logger) error {
	var sources []correlate.Source

	if setting, found, err := store.GetIntegrationSetting(ctx, integrationKeySIEMOpenSearch); err != nil {
		return err
	} else if found && setting.Enabled {
		var cfg correlate.OpenSearchSourceConfig
		if err := json.Unmarshal(setting.ConfigJSON, &cfg); err != nil {
			log.Error("invalid stored siem_opensearch config, ignoring", "error", err)
		} else {
			sources = append(sources, correlate.NewOpenSearchSource(cfg))
		}
	}

	if setting, found, err := store.GetIntegrationSetting(ctx, integrationKeyLibreNMS); err != nil {
		return err
	} else if found && setting.Enabled {
		var cfg correlate.LibreNMSSourceConfig
		if err := json.Unmarshal(setting.ConfigJSON, &cfg); err != nil {
			log.Error("invalid stored librenms config, ignoring", "error", err)
		} else {
			sources = append(sources, correlate.NewLibreNMSSource(cfg))
		}
	}

	registry.SetSources(sources...)
	return nil
}

type siemOpenSearchView struct {
	Enabled            bool   `json:"enabled"`
	Name               string `json:"name"`
	URL                string `json:"url"`
	Index              string `json:"index"`
	HostField          string `json:"host_field"`
	User               string `json:"user"`
	PasswordSet        bool   `json:"password_set"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify"`
}

type libreNMSView struct {
	Enabled  bool   `json:"enabled"`
	URL      string `json:"url"`
	TokenSet bool   `json:"token_set"`
}

// getIntegrations never returns a stored password/token — only whether
// one is set — so the settings page can show "unchanged" instead of a
// real secret every time it's opened.
func (a *API) getIntegrations(w http.ResponseWriter, r *http.Request) {
	resp := struct {
		SIEMOpenSearch siemOpenSearchView `json:"siem_opensearch"`
		LibreNMS       libreNMSView       `json:"librenms"`
	}{}

	if setting, found, err := a.Store.GetIntegrationSetting(r.Context(), integrationKeySIEMOpenSearch); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	} else if found {
		var cfg correlate.OpenSearchSourceConfig
		_ = json.Unmarshal(setting.ConfigJSON, &cfg)
		resp.SIEMOpenSearch = siemOpenSearchView{
			Enabled: setting.Enabled, Name: cfg.Name, URL: cfg.BaseURL, Index: cfg.Index,
			HostField: cfg.HostField, User: cfg.User, PasswordSet: cfg.Password != "", InsecureSkipVerify: cfg.InsecureSkipVerify,
		}
	}

	if setting, found, err := a.Store.GetIntegrationSetting(r.Context(), integrationKeyLibreNMS); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	} else if found {
		var cfg correlate.LibreNMSSourceConfig
		_ = json.Unmarshal(setting.ConfigJSON, &cfg)
		resp.LibreNMS = libreNMSView{Enabled: setting.Enabled, URL: cfg.BaseURL, TokenSet: cfg.Token != ""}
	}

	writeJSON(w, http.StatusOK, resp)
}

type siemOpenSearchSaveRequest struct {
	Enabled            bool   `json:"enabled"`
	Name               string `json:"name"`
	URL                string `json:"url"`
	Index              string `json:"index"`
	HostField          string `json:"host_field"`
	User               string `json:"user"`
	Password           string `json:"password"` // "" means "keep whatever is already stored"
	InsecureSkipVerify bool   `json:"insecure_skip_verify"`
}

// resolveSIEMOpenSearchConfig builds the config to actually use/save: an
// empty incoming password means "leave it unchanged", so the existing
// stored one (if any) is carried forward instead of being wiped.
func (a *API) resolveSIEMOpenSearchConfig(ctx context.Context, req siemOpenSearchSaveRequest) correlate.OpenSearchSourceConfig {
	cfg := correlate.OpenSearchSourceConfig{
		Name: req.Name, BaseURL: req.URL, Index: req.Index, HostField: req.HostField,
		User: req.User, Password: req.Password, InsecureSkipVerify: req.InsecureSkipVerify,
	}
	if cfg.Name == "" {
		cfg.Name = "siem"
	}
	if req.Password == "" {
		if existing, found, err := a.Store.GetIntegrationSetting(ctx, integrationKeySIEMOpenSearch); err == nil && found {
			var old correlate.OpenSearchSourceConfig
			_ = json.Unmarshal(existing.ConfigJSON, &old)
			cfg.Password = old.Password
		}
	}
	return cfg
}

func (a *API) putSIEMOpenSearch(w http.ResponseWriter, r *http.Request) {
	var req siemOpenSearchSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Enabled && (req.URL == "" || req.Index == "") {
		writeError(w, http.StatusBadRequest, errors.New("url and index are required when enabled"))
		return
	}

	cfg := a.resolveSIEMOpenSearchConfig(r.Context(), req)
	encoded, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.Store.UpsertIntegrationSetting(r.Context(), integrationKeySIEMOpenSearch, req.Enabled, encoded); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := RebuildCorrelateRegistry(r.Context(), a.Store, a.Correlate, a.Log); err != nil {
		a.Log.Error("rebuild correlate registry failed", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

func (a *API) testSIEMOpenSearch(w http.ResponseWriter, r *http.Request) {
	var req siemOpenSearchSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cfg := a.resolveSIEMOpenSearchConfig(r.Context(), req)
	src := correlate.NewOpenSearchSource(cfg)
	if err := src.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type libreNMSSaveRequest struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
	Token   string `json:"token"` // "" means "keep whatever is already stored"
}

func (a *API) resolveLibreNMSConfig(ctx context.Context, req libreNMSSaveRequest) correlate.LibreNMSSourceConfig {
	cfg := correlate.LibreNMSSourceConfig{BaseURL: req.URL, Token: req.Token}
	if req.Token == "" {
		if existing, found, err := a.Store.GetIntegrationSetting(ctx, integrationKeyLibreNMS); err == nil && found {
			var old correlate.LibreNMSSourceConfig
			_ = json.Unmarshal(existing.ConfigJSON, &old)
			cfg.Token = old.Token
		}
	}
	return cfg
}

func (a *API) putLibreNMS(w http.ResponseWriter, r *http.Request) {
	var req libreNMSSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if req.Enabled && req.URL == "" {
		writeError(w, http.StatusBadRequest, errors.New("url is required when enabled"))
		return
	}

	cfg := a.resolveLibreNMSConfig(r.Context(), req)
	encoded, err := json.Marshal(cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := a.Store.UpsertIntegrationSetting(r.Context(), integrationKeyLibreNMS, req.Enabled, encoded); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := RebuildCorrelateRegistry(r.Context(), a.Store, a.Correlate, a.Log); err != nil {
		a.Log.Error("rebuild correlate registry failed", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

func (a *API) testLibreNMS(w http.ResponseWriter, r *http.Request) {
	var req libreNMSSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	cfg := a.resolveLibreNMSConfig(r.Context(), req)
	src := correlate.NewLibreNMSSource(cfg)
	if err := src.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

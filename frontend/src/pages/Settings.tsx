import { useEffect, useState } from "react";
import { api, type LibreNmsSettings, type SiemOpenSearchSettings } from "../lib/api";
import { useTranslation } from "../i18n";

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 11.2,
  padding: 16.8,
  borderRadius: 8,
  background: "var(--color-surface)",
  boxShadow: "var(--shadow-sm)",
};

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4.2,
};

const label: React.CSSProperties = {
  fontSize: 12,
  color: "var(--color-neutral-500)",
};

function TestResult({ result }: { result: { ok: boolean; error?: string } | null }) {
  const { t } = useTranslation();
  if (!result) return null;
  return (
    <span style={{ fontSize: 12.5, color: result.ok ? "var(--color-accent)" : "var(--color-danger)" }}>
      {result.ok ? t("settings.testOk") : t("settings.testFailed", { error: result.error ?? "" })}
    </span>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [siem, setSiem] = useState<SiemOpenSearchSettings | null>(null);
  const [siemPassword, setSiemPassword] = useState("");
  const [siemBusy, setSiemBusy] = useState(false);
  const [siemTest, setSiemTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const [siemSaved, setSiemSaved] = useState(false);

  const [libre, setLibre] = useState<LibreNmsSettings | null>(null);
  const [libreToken, setLibreToken] = useState("");
  const [libreBusy, setLibreBusy] = useState(false);
  const [libreTest, setLibreTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const [libreSaved, setLibreSaved] = useState(false);

  useEffect(() => {
    api
      .getIntegrations()
      .then((res) => {
        setSiem(res.siem_opensearch);
        setLibre(res.librenms);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const siemPayload = () =>
    siem && {
      enabled: siem.enabled,
      name: siem.name,
      url: siem.url,
      index: siem.index,
      host_field: siem.host_field,
      user: siem.user,
      password: siemPassword,
      insecure_skip_verify: siem.insecure_skip_verify,
    };

  const testSiem = async () => {
    const payload = siemPayload();
    if (!payload) return;
    setSiemBusy(true);
    setSiemTest(null);
    try {
      setSiemTest(await api.testSiemOpenSearch(payload));
    } catch (err) {
      setSiemTest({ ok: false, error: (err as Error).message });
    } finally {
      setSiemBusy(false);
    }
  };

  const saveSiem = async () => {
    const payload = siemPayload();
    if (!payload) return;
    setSiemBusy(true);
    setSiemSaved(false);
    try {
      await api.saveSiemOpenSearch(payload);
      setSiemPassword("");
      setSiem(await (await api.getIntegrations()).siem_opensearch);
      setSiemSaved(true);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSiemBusy(false);
    }
  };

  const librePayload = () => libre && { enabled: libre.enabled, url: libre.url, token: libreToken };

  const testLibre = async () => {
    const payload = librePayload();
    if (!payload) return;
    setLibreBusy(true);
    setLibreTest(null);
    try {
      setLibreTest(await api.testLibreNMS(payload));
    } catch (err) {
      setLibreTest({ ok: false, error: (err as Error).message });
    } finally {
      setLibreBusy(false);
    }
  };

  const saveLibre = async () => {
    const payload = librePayload();
    if (!payload) return;
    setLibreBusy(true);
    setLibreSaved(false);
    try {
      await api.saveLibreNMS(payload);
      setLibreToken("");
      setLibre(await (await api.getIntegrations()).librenms);
      setLibreSaved(true);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLibreBusy(false);
    }
  };

  if (loading) return <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("common.loading")}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2, maxWidth: 640 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("settings.explainer")}</p>
      {error && <div style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</div>}

      {siem && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
            <i className="ph ph-magnifying-glass" style={{ fontSize: 16, color: "var(--color-accent)" }} />
            <strong style={{ fontSize: 14 }}>{t("settings.siem.title")}</strong>
            <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4.2, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={siem.enabled}
                onChange={(e) => setSiem({ ...siem, enabled: e.target.checked })}
              />
              {t("settings.enabled")}
            </label>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("settings.siem.help")}</p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11.2 }}>
            <div style={field}>
              <span style={label}>{t("settings.siem.name")}</span>
              <input className="input" value={siem.name} onChange={(e) => setSiem({ ...siem, name: e.target.value })} />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.siem.url")}</span>
              <input
                className="input"
                placeholder="https://wazuh-indexer.example.lab:9200"
                value={siem.url}
                onChange={(e) => setSiem({ ...siem, url: e.target.value })}
              />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.siem.index")}</span>
              <input
                className="input"
                placeholder="wazuh-alerts-*"
                value={siem.index}
                onChange={(e) => setSiem({ ...siem, index: e.target.value })}
              />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.siem.hostField")}</span>
              <input
                className="input"
                placeholder="agent.ip"
                value={siem.host_field}
                onChange={(e) => setSiem({ ...siem, host_field: e.target.value })}
              />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.siem.user")}</span>
              <input className="input" value={siem.user} onChange={(e) => setSiem({ ...siem, user: e.target.value })} />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.siem.password")}</span>
              <input
                className="input"
                type="password"
                placeholder={siem.password_set ? t("settings.passwordUnchanged") : ""}
                value={siemPassword}
                onChange={(e) => setSiemPassword(e.target.value)}
              />
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 4.2, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={siem.insecure_skip_verify}
              onChange={(e) => setSiem({ ...siem, insecure_skip_verify: e.target.checked })}
            />
            {t("settings.siem.insecureSkipVerify")}
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
            <button type="button" className="btn btn-secondary" disabled={siemBusy} onClick={testSiem}>
              {t("settings.testConnection")}
            </button>
            <button type="button" className="btn btn-primary" disabled={siemBusy} onClick={saveSiem}>
              {t("common.save")}
            </button>
            <TestResult result={siemTest} />
            {siemSaved && !siemTest && <span style={{ fontSize: 12.5, color: "var(--color-accent)" }}>{t("settings.saved")}</span>}
          </div>
        </div>
      )}

      {libre && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
            <i className="ph ph-chart-line" style={{ fontSize: 16, color: "var(--color-accent)" }} />
            <strong style={{ fontSize: 14 }}>{t("settings.librenms.title")}</strong>
            <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4.2, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={libre.enabled}
                onChange={(e) => setLibre({ ...libre, enabled: e.target.checked })}
              />
              {t("settings.enabled")}
            </label>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("settings.librenms.help")}</p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11.2 }}>
            <div style={field}>
              <span style={label}>{t("settings.librenms.url")}</span>
              <input
                className="input"
                placeholder="https://librenms.example.lab"
                value={libre.url}
                onChange={(e) => setLibre({ ...libre, url: e.target.value })}
              />
            </div>
            <div style={field}>
              <span style={label}>{t("settings.librenms.token")}</span>
              <input
                className="input"
                type="password"
                placeholder={libre.token_set ? t("settings.passwordUnchanged") : ""}
                value={libreToken}
                onChange={(e) => setLibreToken(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
            <button type="button" className="btn btn-secondary" disabled={libreBusy} onClick={testLibre}>
              {t("settings.testConnection")}
            </button>
            <button type="button" className="btn btn-primary" disabled={libreBusy} onClick={saveLibre}>
              {t("common.save")}
            </button>
            <TestResult result={libreTest} />
            {libreSaved && !libreTest && <span style={{ fontSize: 12.5, color: "var(--color-accent)" }}>{t("settings.saved")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

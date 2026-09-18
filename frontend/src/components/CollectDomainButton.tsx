import { useState } from "react";
import { api } from "../lib/api";
import { useTranslation } from "../i18n";

const PRESETS = [
  { secs: 300, key: "5m" },
  { secs: 600, key: "10m" },
  { secs: 1800, key: "30m" },
  { secs: 3600, key: "1h" },
];

// Starts a "collect every denial of this domain" run (see the backend's
// server.Collector): the domain goes temporarily permissive on the agent so
// every denial it would otherwise hit one at a time gets logged at once,
// then a single suggestion covers all of them. Real, if temporary and
// bounded, loosening of a domain on a real machine — always confirmed, and
// disabled while that domain already has a run in progress on this agent.
export function CollectDomainButton({
  agentId,
  domain,
  host,
  disabledReason,
  onStarted,
}: {
  agentId: string;
  domain: string;
  host: string;
  disabledReason?: string;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [durationSecs, setDurationSecs] = useState(600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const minutes = Math.round(durationSecs / 60);
    if (!window.confirm(t("collect.confirmStart", { domain, host, minutes }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.startCollection({ agentId, domain, durationSecs });
      onStarted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2.8, alignItems: "flex-start" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4.2 }}>
        <select
          className="input"
          style={{ fontSize: 11.5, padding: "2px 4px", width: 72 }}
          value={durationSecs}
          disabled={busy || !!disabledReason}
          onChange={(e) => setDurationSecs(Number(e.target.value))}
        >
          {PRESETS.map((p) => (
            <option key={p.secs} value={p.secs}>
              {p.key}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || !!disabledReason}
          title={disabledReason}
          onClick={start}
        >
          {busy ? "…" : t("collect.startButton")}
        </button>
      </div>
      {error && <span style={{ fontSize: 11, color: "var(--color-danger)" }}>{error}</span>}
    </div>
  );
}

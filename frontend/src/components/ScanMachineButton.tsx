import { useState } from "react";
import { api } from "../lib/api";
import { useTranslation } from "../i18n";

const PRESETS = [
  { secs: 300, key: "5m" },
  { secs: 600, key: "10m" },
  { secs: 1800, key: "30m" },
  { secs: 3600, key: "1h" },
];

// Starts a "scan every rule on this machine" run: every confined domain the
// agent last reported as active (see SelinuxState.domains) goes temporarily
// permissive at once, grouped under one scan, instead of collecting domains
// one at a time. Real, if temporary and bounded, loosening of the whole
// machine's confinement — always confirmed, and disabled until the agent has
// reported at least one active domain.
export function ScanMachineButton({
  agentId,
  host,
  domainCount,
  onStarted,
}: {
  agentId: string;
  host: string;
  domainCount: number;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [durationSecs, setDurationSecs] = useState(600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabledReason = domainCount === 0 ? t("scan.noDomainsYet") : undefined;

  const start = async () => {
    const minutes = Math.round(durationSecs / 60);
    if (!window.confirm(t("scan.confirmStart", { count: domainCount, host, minutes }))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.startScan({ agentId, durationSecs });
      if (result.collections.length === 0) {
        setError(t("scan.nothingStarted"));
      } else {
        onStarted();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2.8, alignItems: "flex-end" }}>
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
        <button type="button" className="btn btn-secondary" disabled={busy || !!disabledReason} title={disabledReason} onClick={start}>
          <i className="ph ph-radar" /> {busy ? "…" : t("scan.startButton", { count: domainCount })}
        </button>
      </div>
      {error && <span style={{ fontSize: 11, color: "var(--color-danger)" }}>{error}</span>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Alert } from "../lib/api";

const PAGE_SIZE = 20;

export function Alerts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "open";

  const [offset, setOffset] = useState(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [status]);

  const load = () => {
    setLoading(true);
    api
      .listAlerts({ status: status || undefined, offset, limit: PAGE_SIZE })
      .then((result) => {
        setAlerts(result.alerts ?? []);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, offset]);

  const setStatusFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("status", value);
      else next.delete("status");
      return next;
    });
  };

  const acknowledge = async (id: string) => {
    setAcking(id);
    try {
      await api.acknowledgeAlert(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAcking(null);
    }
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11.2,
          flexWrap: "wrap",
          padding: "8.4px 11.2px",
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div className="seg">
          {[
            { value: "open", label: "Ouvertes" },
            { value: "acknowledged", label: "Acquittées" },
            { value: "", label: "Toutes" },
          ].map((opt) => (
            <label key={opt.label} className="seg-opt" style={status === opt.value ? { color: "var(--color-accent)" } : undefined}>
              <input type="radio" name="status" checked={status === opt.value} onChange={() => setStatusFilter(opt.value)} />
              {opt.label}
            </label>
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>
          {loading ? "Chargement…" : total > 0 ? `${from}–${to} sur ${total}` : "0 résultat"}
        </span>
      </div>

      {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8.4 }}>
        {alerts.map((a) => (
          <div
            key={a.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 11.2,
              padding: 14,
              borderRadius: 8,
              background: "var(--color-surface)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <i
              className={`ph ${a.type === "threshold" ? "ph-chart-line-up" : "ph-sparkle"}`}
              style={{ fontSize: 18, color: "var(--color-accent)", marginTop: 2 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2.8, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 14 }}>{a.title}</span>
              <span style={{ fontSize: 12.5, color: "var(--color-neutral-400)" }}>{a.message}</span>
              <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
                <Link to={`/agents/${a.agent_id}`}>{a.agent_id}</Link> · {new Date(a.created_at).toLocaleString()}
                {a.status === "acknowledged" && a.acknowledged_at && (
                  <> · acquittée le {new Date(a.acknowledged_at).toLocaleString()} par {a.acknowledged_by}</>
                )}
              </span>
            </div>
            {a.status === "open" ? (
              <button type="button" className="btn btn-secondary" disabled={acking === a.id} onClick={() => acknowledge(a.id)}>
                {acking === a.id ? "…" : "Acquitter"}
              </button>
            ) : (
              <span className="tag tag-neutral">acquittée</span>
            )}
          </div>
        ))}
        {alerts.length === 0 && !loading && (
          <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>Aucune alerte ne correspond à ce filtre.</p>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8.4 }}>
        <button type="button" className="btn btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          Précédent
        </button>
        <button type="button" className="btn btn-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Suivant
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Agent, type Alert } from "../lib/api";
import { evaluateFleet, fleetScore, type CheckResult } from "../lib/compliance";

export function Compliance() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, al] = await Promise.all([api.listAgents(), api.listAlerts({ status: "open", limit: 500 })]);
        if (cancelled) return;
        setAgents(a ?? []);
        setOpenAlerts(al.alerts ?? []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const results = evaluateFleet(agents, openAlerts);
  const score = fleetScore(results);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5.6,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
          maxWidth: 260,
        }}
      >
        <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-accent)" }}>
          Conformité de la flotte
        </span>
        <span style={{ fontFamily: "var(--font-heading)", fontSize: 30, lineHeight: 1 }}>{score} %</span>
        <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
          {agents.length} agent{agents.length > 1 ? "s" : ""} · vérifications de base (pas un référentiel type CIS)
        </span>
      </div>

      <div style={{ overflowX: "auto", borderRadius: 8, background: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Hôte</th>
              <th>Score</th>
              <th>Mode enforcing</th>
              <th>Agent joignable</th>
              <th>Politique targeted</th>
              <th>Aucune alerte ouverte</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.agent.id}>
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                  <Link to={`/agents/${r.agent.id}`}>{r.agent.hostname || r.agent.id}</Link>
                </td>
                <td style={{ fontSize: 12.5 }}>{r.score} %</td>
                {r.checks.map((c) => (
                  <td key={c.id}>
                    <CheckBadge check={c} />
                  </td>
                ))}
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--color-neutral-500)" }}>
                  Aucun agent enrôlé pour l'instant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CheckBadge({ check }: { check: CheckResult }) {
  switch (check.status) {
    case "pass":
      return <span className="tag tag-accent">ok</span>;
    case "fail":
      return <span className="tag tag-outline">échec</span>;
    default:
      return <span className="tag tag-neutral">inconnu</span>;
  }
}

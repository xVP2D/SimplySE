import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Agent, type MatrixRow, type TrendPoint } from "../lib/api";
import { useTranslation } from "../i18n";

const WINDOW_DAYS = [7, 30, 90, 0]; // 0 = all history

// Small inline bar sparkline — no charting library in this project, and
// one day's worth of bars per host is plenty simple to draw by hand.
function Sparkline({ counts }: { counts: number[] }) {
  const width = 120;
  const height = 26;
  const max = Math.max(...counts, 1);
  const barWidth = width / Math.max(counts.length, 1);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {counts.map((v, i) => {
        const h = (v / max) * (height - 2);
        return (
          <rect
            key={i}
            x={i * barWidth}
            y={height - h}
            width={Math.max(barWidth - 1, 1)}
            height={Math.max(h, v > 0 ? 1 : 0)}
            fill="var(--color-accent)"
            opacity={v === 0 ? 0.15 : 0.85}
          />
        );
      })}
    </svg>
  );
}

export function Matrix() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsByID = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.denialMatrix({ days }), api.denialTrend({ days: 14 })])
      .then(([matrixResult, trendResult]) => {
        if (cancelled) return;
        setRows(matrixResult ?? []);
        setTrend(trendResult ?? []);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  // One bar series per agent, 14 fixed-width daily buckets, oldest first.
  const trendByAgent = useMemo(() => {
    const byAgent = new Map<string, Map<number, number>>();
    for (const p of trend) {
      if (!byAgent.has(p.agent_id)) byAgent.set(p.agent_id, new Map());
      byAgent.get(p.agent_id)!.set(p.day_unix, p.count);
    }
    const days = Array.from(new Set(trend.map((p) => p.day_unix))).sort((a, b) => a - b);
    return Array.from(byAgent.entries())
      .map(([agentId, dayMap]) => ({
        agentId,
        counts: days.map((d) => dayMap.get(d) ?? 0),
        total: Array.from(dayMap.values()).reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [trend]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8.4,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8.4 }}>
          <h5 style={{ margin: 0, fontSize: 15 }}>{t("matrix.title")}</h5>
          <div className="seg">
            {WINDOW_DAYS.map((d) => (
              <label key={d} className="seg-opt" style={days === d ? { color: "var(--color-accent)" } : undefined}>
                <input type="radio" name="window" checked={days === d} onChange={() => setDays(d)} />
                {d === 0 ? t("matrix.allTime") : t("matrix.lastNDays", { count: d })}
              </label>
            ))}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("matrix.explainer")}</p>

        {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t("common.columns.sourceTarget")}</th>
                <th>{t("common.columns.classPerm")}</th>
                <th style={{ textAlign: "right" }}>{t("matrix.colOccurrences")}</th>
                <th style={{ textAlign: "right" }}>{t("matrix.colHostsHit")}</th>
                <th>{t("matrix.colHosts")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 }}>
                    {row.scontext} → {row.tcontext}
                  </td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-neutral-400)" }}>
                    {row.tclass} · {row.perms.join(",")}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.count}</td>
                  <td style={{ textAlign: "right" }}>
                    <span className={row.agent_count > 1 ? "tag tag-outline" : "tag tag-neutral"}>{row.agent_count}</span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--color-neutral-500)", maxWidth: 260, wordBreak: "break-word" }}>
                    {row.agents.map((id, j) => (
                      <span key={id}>
                        {j > 0 && ", "}
                        <Link to={`/agents/${id}`}>{agentsByID.get(id)?.hostname || id}</Link>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} style={{ color: "var(--color-neutral-500)" }}>
                    {t("matrix.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8.4,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h5 style={{ margin: 0, fontSize: 15 }}>{t("matrix.trendTitle")}</h5>
        <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("matrix.trendExplainer")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8.4 }}>
          {trendByAgent.map(({ agentId, counts, total }) => (
            <div key={agentId} style={{ display: "flex", alignItems: "center", gap: 11.2 }}>
              <Link
                to={`/agents/${agentId}`}
                style={{ width: 200, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {agentsByID.get(agentId)?.hostname || agentId}
              </Link>
              <Sparkline counts={counts} />
              <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{total}</span>
            </div>
          ))}
          {trendByAgent.length === 0 && !loading && (
            <p style={{ color: "var(--color-neutral-500)", fontSize: 13, margin: 0 }}>{t("matrix.empty")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Agent, type Alert, type Command, type TopSignature } from "../lib/api";
import { evaluateFleet, fleetScore } from "../lib/compliance";
import { useTranslation } from "../i18n";

function StatCard({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5.6,
        padding: 14,
        borderRadius: 8,
        background: "var(--color-surface)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--color-accent)",
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-heading)", fontSize: 30, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{meta}</span>
    </div>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [topSignatures, setTopSignatures] = useState<TopSignature[]>([]);
  const [recentCommands, setRecentCommands] = useState<Command[]>([]);
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [allOpenAlerts, setAllOpenAlerts] = useState<Alert[]>([]);
  const [openAlertsTotal, setOpenAlertsTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, s, c, al] = await Promise.all([
          api.listAgents(),
          api.topSignatures(6),
          api.recentCommands({ limit: 6 }),
          api.listAlerts({ status: "open", limit: 500 }),
        ]);
        if (cancelled) return;
        setAgents(a ?? []);
        setTopSignatures(s ?? []);
        setRecentCommands(c.commands ?? []);
        setOpenAlerts((al.alerts ?? []).slice(0, 6));
        setAllOpenAlerts(al.alerts ?? []);
        setOpenAlertsTotal(al.total);
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

  const online = agents.filter((a) => a.connected).length;
  const enforcing = agents.filter((a) => a.mode === "enforcing").length;
  const permissive = agents.filter((a) => a.mode === "permissive").length;
  const disabled = agents.filter((a) => a.mode === "disabled" || a.mode === "unknown").length;
  const totalDenials = topSignatures.reduce((sum, s) => sum + s.count, 0);
  const complianceScore = fleetScore(evaluateFleet(agents, allOpenAlerts));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      {error && (
        <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>
          {t("dashboard.masterUnreachable", { error })}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(178px,1fr))", gap: 11.2 }}>
        <StatCard
          label={t("dashboard.statEnrolledAgents")}
          value={agents.length}
          meta={t("dashboard.statEnrolledAgentsMeta", { online, offline: agents.length - online })}
        />
        <StatCard
          label={t("dashboard.statEnforcing")}
          value={enforcing}
          meta={t("dashboard.statEnforcingMeta", { permissive, disabled })}
        />
        <StatCard
          label={t("dashboard.statDenials")}
          value={totalDenials}
          meta={t("dashboard.statDenialsMeta", { count: topSignatures.length })}
        />
        <StatCard label={t("dashboard.statRecentCommands")} value={recentCommands.length} meta={t("dashboard.statRecentCommandsMeta")} />
        <StatCard label={t("dashboard.statOpenAlerts")} value={openAlertsTotal} meta={t("dashboard.statOpenAlertsMeta")} />
        <StatCard label={t("dashboard.statCompliance")} value={`${complianceScore} %`} meta={t("dashboard.statComplianceMeta")} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 11.2, alignItems: "start" }}>
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
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 11.2 }}>
            <h5 style={{ margin: 0, fontSize: 15 }}>{t("dashboard.topSignatures")}</h5>
            <Link to="/denials" className="btn btn-ghost">
              {t("common.viewAll")}
            </Link>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t("common.columns.sourceTarget")}</th>
                <th>{t("common.columns.classPerm")}</th>
                <th style={{ textAlign: "right" }}>{t("dashboard.colOccurrences")}</th>
                <th style={{ textAlign: "right" }}>{t("dashboard.colAgents")}</th>
              </tr>
            </thead>
            <tbody>
              {topSignatures.map((s) => (
                <tr key={s.pair + s.class}>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{s.pair}</td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: "var(--color-neutral-400)" }}>
                    {s.class} · {s.perms}
                  </td>
                  <td style={{ textAlign: "right" }}>{s.count}</td>
                  <td style={{ textAlign: "right", color: "var(--color-neutral-500)" }}>{s.agents}</td>
                </tr>
              ))}
              {topSignatures.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--color-neutral-500)" }}>
                    {t("dashboard.noDenialsYet")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 11.2 }}>
            <h5 style={{ margin: 0, fontSize: 15 }}>{t("dashboard.recentDeployments")}</h5>
            <Link to="/deployments" className="btn btn-ghost">
              {t("dashboard.history")}
            </Link>
          </div>
          {recentCommands.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11.2,
                padding: "8.4px 0",
                borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{c.type}</span>
                <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>agent {c.agent_id}</span>
              </span>
              <span className={statusTagClass(c.status)}>{c.status}</span>
            </div>
          ))}
          {recentCommands.length === 0 && (
            <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("dashboard.noDeploymentsYet")}</p>
          )}
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
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 11.2 }}>
            <h5 style={{ margin: 0, fontSize: 15 }}>{t("dashboard.openAlerts")}</h5>
            <Link to="/alerts" className="btn btn-ghost">
              {t("dashboard.alertCenter")}
            </Link>
          </div>
          {openAlerts.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 11.2,
                padding: "8.4px 0",
                borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
              }}
            >
              <i
                className={`ph ${a.type === "threshold" ? "ph-chart-line-up" : "ph-sparkle"}`}
                style={{ fontSize: 15, color: "var(--color-accent)", marginTop: 2 }}
              />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 13 }}>{a.title}</span>
                <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>{a.agent_id}</span>
              </span>
            </div>
          ))}
          {openAlerts.length === 0 && (
            <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("dashboard.noOpenAlerts")}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function statusTagClass(status: string): string {
  switch (status) {
    case "acked":
      return "tag tag-accent";
    case "failed":
      return "tag tag-outline";
    case "sent":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}

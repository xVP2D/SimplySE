import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Agent, Alert, Command, TopSignature, TrendPoint } from "./api";
import type { AgentCompliance } from "./compliance";

export type WidgetType =
  | "stat-agents"
  | "stat-enforcing"
  | "stat-denials"
  | "stat-commands"
  | "stat-alerts"
  | "stat-compliance"
  | "top-signatures"
  | "recent-deployments"
  | "open-alerts"
  | "denial-trend"
  | "agents-vignettes"
  | "compliance-checks"
  | "agents-by-mode";

// Everything the widget grid needs to render any widget instance — fetched
// once by the Dashboard page (same polling loop as before this became
// customizable) and shared by every widget, including several instances of
// the same type with different `limit`s.
export interface DashboardData {
  agents: Agent[];
  topSignatures: TopSignature[];
  recentCommands: Command[];
  openAlerts: Alert[];
  openAlertsTotal: number;
  complianceScore: number;
  complianceResults: AgentCompliance[];
  trend: TrendPoint[];
}

export interface WidgetDef {
  type: WidgetType;
  labelKey: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  // Only list-shaped widgets take a "how many rows" setting — stat cards
  // show a single number and have nothing to limit.
  hasLimit?: boolean;
  defaultLimit?: number;
}

export const WIDGET_DEFS: Record<WidgetType, WidgetDef> = {
  "stat-agents": { type: "stat-agents", labelKey: "dashboard.widgets.statAgents", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "stat-enforcing": { type: "stat-enforcing", labelKey: "dashboard.widgets.statEnforcing", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "stat-denials": { type: "stat-denials", labelKey: "dashboard.widgets.statDenials", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "stat-commands": { type: "stat-commands", labelKey: "dashboard.widgets.statCommands", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "stat-alerts": { type: "stat-alerts", labelKey: "dashboard.widgets.statAlerts", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "stat-compliance": { type: "stat-compliance", labelKey: "dashboard.widgets.statCompliance", defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 } },
  "top-signatures": {
    type: "top-signatures",
    labelKey: "dashboard.widgets.topSignatures",
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 4 },
    hasLimit: true,
    defaultLimit: 6,
  },
  "recent-deployments": {
    type: "recent-deployments",
    labelKey: "dashboard.widgets.recentDeployments",
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 4 },
    hasLimit: true,
    defaultLimit: 6,
  },
  "open-alerts": {
    type: "open-alerts",
    labelKey: "dashboard.widgets.openAlerts",
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 4 },
    hasLimit: true,
    defaultLimit: 6,
  },
  "denial-trend": {
    type: "denial-trend",
    labelKey: "dashboard.widgets.denialTrend",
    defaultSize: { w: 6, h: 8 },
    minSize: { w: 4, h: 5 },
  },
  "agents-vignettes": {
    type: "agents-vignettes",
    labelKey: "dashboard.widgets.agentsVignettes",
    defaultSize: { w: 6, h: 8 },
    minSize: { w: 3, h: 4 },
    hasLimit: true,
    defaultLimit: 12,
  },
  "compliance-checks": {
    type: "compliance-checks",
    labelKey: "dashboard.widgets.complianceChecks",
    defaultSize: { w: 6, h: 6 },
    minSize: { w: 3, h: 4 },
  },
  "agents-by-mode": {
    type: "agents-by-mode",
    labelKey: "dashboard.widgets.agentsByMode",
    defaultSize: { w: 6, h: 6 },
    minSize: { w: 3, h: 4 },
  },
};

export const WIDGET_CATALOG: WidgetType[] = [
  "stat-agents",
  "stat-enforcing",
  "stat-denials",
  "stat-commands",
  "stat-alerts",
  "stat-compliance",
  "top-signatures",
  "recent-deployments",
  "open-alerts",
  "denial-trend",
  "agents-vignettes",
  "compliance-checks",
  "agents-by-mode",
];

// A local widget instance: the grid-agnostic shape used throughout the
// Dashboard page and the shape saved to the backend (see lib/api.ts's
// DashboardWidget) are identical, so this is just an alias kept separate
// in case the grid needs local-only fields later.
export interface WidgetInstance {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  limit?: number;
}

// Mirrors the fixed dashboard exactly as it looked before it became
// customizable — used the first time nothing has been saved yet.
export const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "default-stat-agents", type: "stat-agents", x: 0, y: 0, w: 4, h: 4 },
  { id: "default-stat-enforcing", type: "stat-enforcing", x: 4, y: 0, w: 4, h: 4 },
  { id: "default-stat-denials", type: "stat-denials", x: 8, y: 0, w: 4, h: 4 },
  { id: "default-stat-commands", type: "stat-commands", x: 0, y: 4, w: 4, h: 4 },
  { id: "default-stat-alerts", type: "stat-alerts", x: 4, y: 4, w: 4, h: 4 },
  { id: "default-stat-compliance", type: "stat-compliance", x: 8, y: 4, w: 4, h: 4 },
  { id: "default-top-signatures", type: "top-signatures", x: 0, y: 8, w: 4, h: 8, limit: 6 },
  { id: "default-recent-deployments", type: "recent-deployments", x: 4, y: 8, w: 4, h: 8, limit: 6 },
  { id: "default-open-alerts", type: "open-alerts", x: 8, y: 8, w: 4, h: 8, limit: 6 },
  { id: "default-denial-trend", type: "denial-trend", x: 0, y: 16, w: 6, h: 8 },
  { id: "default-agents-vignettes", type: "agents-vignettes", x: 6, y: 16, w: 6, h: 8, limit: 12 },
  { id: "default-compliance-checks", type: "compliance-checks", x: 0, y: 24, w: 6, h: 6 },
  { id: "default-agents-by-mode", type: "agents-by-mode", x: 6, y: 24, w: 6, h: 6 },
];

export function statusTagClass(status: string): string {
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

const singleLine: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

export function StatCard({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5.6, height: "100%", minWidth: 0 }}>
      <span
        style={{
          ...singleLine,
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--color-accent)",
        }}
        title={label}
      >
        {label}
      </span>
      <span style={{ ...singleLine, fontFamily: "var(--font-heading)", fontSize: 30, lineHeight: 1 }}>{value}</span>
      <span style={{ ...singleLine, fontSize: 12, color: "var(--color-neutral-500)" }} title={meta}>
        {meta}
      </span>
    </div>
  );
}

// A hand-drawn horizontal bar list — same "no charting library" call as
// the trend line chart, for a categorical breakdown (a handful of named
// parameters, each with a magnitude) rather than a series over time.
// Single hue, thin recessive track, rounded ends, single-line labels.
function HorizontalBarChart({
  bars,
}: {
  bars: { label: string; value: number; total: number; displayValue: string }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 11.2, height: "100%" }}>
      {bars.map((b) => {
        const pct = b.total > 0 ? Math.max(0, Math.min(100, Math.round((b.value / b.total) * 100))) : 0;
        return (
          <div key={b.label} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8.4, fontSize: 12.5 }}>
              <span style={{ ...singleLine, minWidth: 0 }} title={b.label}>
                {b.label}
              </span>
              <span style={{ color: "var(--color-neutral-500)", flex: "none" }}>{b.displayValue}</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--color-divider)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: "var(--color-accent)" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function modeTagClass(mode: string): string {
  switch (mode) {
    case "enforcing":
      return "tag tag-accent";
    case "permissive":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}

interface TrendChartPoint {
  day: number;
  count: number;
  label: string;
}

const CHART_VB_W = 600;
const CHART_VB_H = 200;
const CHART_PAD = { left: 30, right: 10, top: 14, bottom: 22 };

// A hand-drawn line chart — no charting library in this project (see
// Matrix.tsx's Sparkline for the same call). Single series, single hue
// (var(--color-accent)), thin 2px rounded stroke, recessive gridlines, and
// a hover crosshair + tooltip — the smallest shape that follows the
// dataviz skill's non-negotiables for a one-series trend.
function DenialTrendChart({
  points,
  emptyLabel,
  countLabel,
}: {
  points: TrendChartPoint[];
  emptyLabel: string;
  countLabel: (count: number, label: string) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  if (points.length === 0) {
    return <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{emptyLabel}</p>;
  }

  const innerW = CHART_VB_W - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_VB_H - CHART_PAD.top - CHART_PAD.bottom;
  const max = Math.max(...points.map((p) => p.count), 1) * 1.15;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xAt = (i: number) => CHART_PAD.left + i * stepX;
  const yAt = (v: number) => CHART_PAD.top + innerH - (v / max) * innerH;
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(p.count)}`).join(" ");

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * CHART_VB_W;
    const idx = Math.round((relX - CHART_PAD.left) / (stepX || 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
  };

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_VB_W} ${CHART_VB_H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair" }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={CHART_PAD.left}
            x2={CHART_VB_W - CHART_PAD.right}
            y1={CHART_PAD.top + innerH * (1 - f)}
            y2={CHART_PAD.top + innerH * (1 - f)}
            stroke="var(--color-divider)"
            strokeWidth={1}
          />
        ))}
        <text x={2} y={CHART_PAD.top + 4} fontSize={10} fill="var(--color-neutral-500)">
          {Math.round(max)}
        </text>
        <text x={2} y={CHART_PAD.top + innerH} fontSize={10} fill="var(--color-neutral-500)">
          0
        </text>
        <path d={linePath} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hoverIdx !== null && (
          <>
            <line
              x1={xAt(hoverIdx)}
              x2={xAt(hoverIdx)}
              y1={CHART_PAD.top}
              y2={CHART_PAD.top + innerH}
              stroke="var(--color-divider)"
              strokeWidth={1}
            />
            <circle
              cx={xAt(hoverIdx)}
              cy={yAt(points[hoverIdx].count)}
              r={4}
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          </>
        )}
        <text x={CHART_PAD.left} y={CHART_VB_H - 6} fontSize={10} fill="var(--color-neutral-500)">
          {points[0].label}
        </text>
        <text x={CHART_VB_W - CHART_PAD.right} y={CHART_VB_H - 6} fontSize={10} fill="var(--color-neutral-500)" textAnchor="end">
          {points[points.length - 1].label}
        </text>
      </svg>
      {hovered && hoverIdx !== null && (
        <div
          style={{
            position: "absolute",
            left: `${(xAt(hoverIdx) / CHART_VB_W) * 100}%`,
            top: 4,
            transform: "translateX(-50%)",
            background: "var(--color-bg)",
            border: "1px solid var(--color-divider)",
            borderRadius: 6,
            padding: "3px 7px",
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {countLabel(hovered.count, hovered.label)}
        </div>
      )}
    </div>
  );
}

// A compact grid of small agent "vignettes" — a thumbnail per agent
// (online dot + hostname + mode) instead of the full inventory table, for
// a quick glance from the dashboard.
function AgentsVignettesGrid({ agents, emptyLabel }: { agents: Agent[]; emptyLabel: string }) {
  if (agents.length === 0) {
    return <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{emptyLabel}</p>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(128px, 1fr))", gap: 8.4 }}>
      {agents.map((a) => (
        <Link
          key={a.id}
          to={`/agents/${a.id}`}
          className="no-drag"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5.6,
            padding: "8.4px 10px",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--color-text) 5%, transparent)",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "none",
                background: a.connected ? "var(--color-accent)" : "var(--color-neutral-600)",
              }}
            />
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {a.hostname}
            </span>
          </span>
          <span className={modeTagClass(a.mode)} style={{ alignSelf: "flex-start" }}>
            {a.mode}
          </span>
        </Link>
      ))}
    </div>
  );
}

// Renders one widget's inner content. The outer card chrome (background,
// drag handle, remove/settings controls in edit mode) is provided by the
// Dashboard page's WidgetFrame — this only knows about the data.
export function renderWidgetContent(
  widget: WidgetInstance,
  data: DashboardData,
  t: (key: string, vars?: Record<string, string | number>) => string,
  locale: string,
): { title?: string; body: React.ReactNode; headerAction?: React.ReactNode; scrollable?: boolean } {
  const { agents, topSignatures, recentCommands, openAlerts, openAlertsTotal, complianceScore, complianceResults, trend } = data;

  switch (widget.type) {
    case "stat-agents": {
      const online = agents.filter((a) => a.connected).length;
      return {
        title: undefined,
        body: (
          <StatCard
            label={t("dashboard.statEnrolledAgents")}
            value={agents.length}
            meta={t("dashboard.statEnrolledAgentsMeta", { online, offline: agents.length - online })}
          />
        ),
      };
    }
    case "stat-enforcing": {
      const enforcing = agents.filter((a) => a.mode === "enforcing").length;
      const permissive = agents.filter((a) => a.mode === "permissive").length;
      const disabled = agents.filter((a) => a.mode === "disabled" || a.mode === "unknown").length;
      return {
        title: undefined,
        body: (
          <StatCard
            label={t("dashboard.statEnforcing")}
            value={enforcing}
            meta={t("dashboard.statEnforcingMeta", { permissive, disabled })}
          />
        ),
      };
    }
    case "stat-denials": {
      const totalDenials = topSignatures.reduce((sum, s) => sum + s.count, 0);
      return {
        title: undefined,
        body: (
          <StatCard
            label={t("dashboard.statDenials")}
            value={totalDenials}
            meta={t("dashboard.statDenialsMeta", { count: topSignatures.length })}
          />
        ),
      };
    }
    case "stat-commands":
      return {
        title: undefined,
        body: (
          <StatCard
            label={t("dashboard.statRecentCommands")}
            value={recentCommands.length}
            meta={t("dashboard.statRecentCommandsMeta")}
          />
        ),
      };
    case "stat-alerts":
      return {
        title: undefined,
        body: (
          <StatCard label={t("dashboard.statOpenAlerts")} value={openAlertsTotal} meta={t("dashboard.statOpenAlertsMeta")} />
        ),
      };
    case "stat-compliance":
      return {
        title: undefined,
        body: (
          <StatCard
            label={t("dashboard.statCompliance")}
            value={`${complianceScore} %`}
            meta={t("dashboard.statComplianceMeta")}
          />
        ),
      };
    case "top-signatures": {
      const limit = widget.limit ?? WIDGET_DEFS[widget.type].defaultLimit ?? 6;
      const rows = topSignatures.slice(0, limit);
      return {
        title: t("dashboard.topSignatures"),
        scrollable: true,
        headerAction: (
          <Link to="/denials" className="btn btn-ghost no-drag">
            {t("common.viewAll")}
          </Link>
        ),
        body: (
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
              {rows.map((s) => (
                <tr key={s.pair + s.class}>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{s.pair}</td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, color: "var(--color-neutral-400)" }}>
                    {s.class} · {s.perms}
                  </td>
                  <td style={{ textAlign: "right" }}>{s.count}</td>
                  <td style={{ textAlign: "right", color: "var(--color-neutral-500)" }}>{s.agents}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--color-neutral-500)" }}>
                    {t("dashboard.noDenialsYet")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ),
      };
    }
    case "recent-deployments": {
      const limit = widget.limit ?? WIDGET_DEFS[widget.type].defaultLimit ?? 6;
      const rows = recentCommands.slice(0, limit);
      return {
        title: t("dashboard.recentDeployments"),
        scrollable: true,
        headerAction: (
          <Link to="/deployments" className="btn btn-ghost no-drag">
            {t("dashboard.history")}
          </Link>
        ),
        body: (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {rows.map((c) => (
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
            {rows.length === 0 && <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("dashboard.noDeploymentsYet")}</p>}
          </div>
        ),
      };
    }
    case "open-alerts": {
      const limit = widget.limit ?? WIDGET_DEFS[widget.type].defaultLimit ?? 6;
      const rows = openAlerts.slice(0, limit);
      return {
        title: t("dashboard.openAlerts"),
        scrollable: true,
        headerAction: (
          <Link to="/alerts" className="btn btn-ghost no-drag">
            {t("dashboard.alertCenter")}
          </Link>
        ),
        body: (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {rows.map((a) => (
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
            {rows.length === 0 && <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("dashboard.noOpenAlerts")}</p>}
          </div>
        ),
      };
    }
    case "denial-trend": {
      const byDay = new Map<number, number>();
      for (const p of trend) {
        byDay.set(p.day_unix, (byDay.get(p.day_unix) ?? 0) + p.count);
      }
      const points: TrendChartPoint[] = Array.from(byDay.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([day, count]) => ({
          day,
          count,
          label: new Date(day * 1000).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }),
        }));
      return {
        title: t("dashboard.denialTrendTitle"),
        body: (
          <DenialTrendChart
            points={points}
            emptyLabel={t("dashboard.noTrendData")}
            countLabel={(count, label) => t("dashboard.trendTooltip", { count, date: label })}
          />
        ),
      };
    }
    case "agents-vignettes": {
      const limit = widget.limit ?? WIDGET_DEFS[widget.type].defaultLimit ?? 12;
      const rows = agents.slice(0, limit);
      return {
        title: t("dashboard.agentsVignettesTitle"),
        scrollable: true,
        body: <AgentsVignettesGrid agents={rows} emptyLabel={t("agents.empty")} />,
      };
    }
    case "compliance-checks": {
      const checkIds = ["enforcing", "connected", "policy", "no_open_alerts"] as const;
      const checkLabelKeys: Record<(typeof checkIds)[number], string> = {
        enforcing: "dashboard.checkEnforcing",
        connected: "dashboard.checkConnected",
        policy: "dashboard.checkPolicy",
        no_open_alerts: "dashboard.checkNoOpenAlerts",
      };
      const bars = checkIds.map((id) => {
        let applicable = 0;
        let passed = 0;
        for (const r of complianceResults) {
          const c = r.checks.find((check) => check.id === id);
          if (!c || c.status === "unknown") continue;
          applicable++;
          if (c.status === "pass") passed++;
        }
        return { label: t(checkLabelKeys[id]), value: passed, total: applicable, displayValue: `${passed}/${applicable}` };
      });
      return {
        title: t("dashboard.complianceChecksTitle"),
        body: <HorizontalBarChart bars={bars} />,
      };
    }
    case "agents-by-mode": {
      const counts = { enforcing: 0, permissive: 0, disabled: 0, unknown: 0 };
      for (const a of agents) {
        if (a.mode === "enforcing" || a.mode === "permissive" || a.mode === "disabled") counts[a.mode]++;
        else counts.unknown++;
      }
      const total = agents.length;
      const bars = (["enforcing", "permissive", "disabled", "unknown"] as const).map((mode) => ({
        label: mode,
        value: counts[mode],
        total,
        displayValue: String(counts[mode]),
      }));
      return {
        title: t("dashboard.agentsByModeTitle"),
        body: <HorizontalBarChart bars={bars} />,
      };
    }
  }
}

import type { ChartConfig } from "../charts/types.ts";
import { fitLimit, type WidgetType } from "./dashboardGrid.ts";

// Ready-made dashboards. Each one tiles the 12-column grid exactly (no gap,
// no overlap) over BASE_ROWS rows, which is one laptop screen; applying it
// stretches the rows to the height of the window.

export const BASE_ROWS = 15;
export const MAX_ROWS = 28;

export interface TemplateCell {
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  chart?: ChartConfig;
}

export interface DashboardTemplate {
  id: string;
  icon: string;
  cells: TemplateCell[];
}

const stat = (type: WidgetType, x: number, y: number): TemplateCell => ({ type, x, y, w: 3, h: 3 });
const widget = (type: WidgetType, x: number, y: number, w: number, h: number): TemplateCell => ({ type, x, y, w, h });
const chart = (x: number, y: number, w: number, h: number, config: ChartConfig): TemplateCell => ({ type: "chart", x, y, w, h, chart: config });

const denials = (kind: string, dim: string, days = 30): ChartConfig => ({ dataset: "denials", chart: kind, dim, days, measure: "count" });
const commands = (kind: string, dim: string, days = 30): ChartConfig => ({ dataset: "commands", chart: kind, dim, days, measure: "count" });
const alerts = (kind: string, dim: string, days = 30): ChartConfig => ({ dataset: "alerts", chart: kind, dim, days, measure: "count" });
const fleet = (kind: string, dim: string, measure: string, days = 30): ChartConfig => ({ dataset: "fleet", chart: kind, dim, days, measure });

export type DataFamily = "denials" | "deployments" | "alerts" | "fleet";
export const DATA_FAMILIES: DataFamily[] = ["denials", "deployments", "alerts", "fleet"];

const FAMILY_OF_WIDGET: Record<Exclude<WidgetType, "chart">, DataFamily> = {
  "stat-denials": "denials",
  "top-signatures": "denials",
  "denial-trend": "denials",
  "stat-commands": "deployments",
  "recent-deployments": "deployments",
  "stat-alerts": "alerts",
  "open-alerts": "alerts",
  "stat-agents": "fleet",
  "stat-enforcing": "fleet",
  "stat-compliance": "fleet",
  "agents-vignettes": "fleet",
  "compliance-checks": "fleet",
  "agents-by-mode": "fleet",
  "attention-agents": "fleet",
  "pending-suggestions": "denials",
  "active-collections": "denials",
};

const FAMILY_OF_DATASET: Record<ChartConfig["dataset"], DataFamily> = {
  denials: "denials",
  signatures: "denials",
  commands: "deployments",
  alerts: "alerts",
  fleet: "fleet",
};

export function familyOf(cell: Pick<TemplateCell, "type" | "chart">): DataFamily {
  return cell.type === "chart" && cell.chart ? FAMILY_OF_DATASET[cell.chart.dataset] : FAMILY_OF_WIDGET[cell.type as Exclude<WidgetType, "chart">];
}

// Every template has the same skeleton: a band of four headline tiles, one
// per family, then two rows of panels. The template's theme gets the upper
// row (an 8-wide and a 4-wide panel); the lower row gives each of the other
// families a panel of its own. So whichever template is chosen, everything
// recorded can be seen, and only the depth differs.
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  // Balanced: the same weight on every family.
  {
    id: "overview",
    icon: "ph-squares-four",
    cells: [
      stat("stat-agents", 0, 0),
      stat("stat-denials", 3, 0),
      stat("stat-alerts", 6, 0),
      stat("stat-commands", 9, 0),
      widget("denial-trend", 0, 3, 8, 6),
      widget("agents-by-mode", 8, 3, 4, 6),
      widget("open-alerts", 0, 9, 4, 6),
      widget("recent-deployments", 4, 9, 4, 6),
      widget("top-signatures", 8, 9, 4, 6),
    ],
  },
  // Denials in depth.
  {
    id: "security",
    icon: "ph-shield-warning",
    cells: [
      chart(0, 0, 3, 3, denials("kpi-delta", "tclass", 7)),
      stat("stat-alerts", 3, 0),
      stat("stat-commands", 6, 0),
      stat("stat-agents", 9, 0),
      chart(0, 3, 8, 6, denials("stacked-area", "tclass")),
      chart(8, 3, 4, 6, denials("bar-h", "scontext")),
      chart(0, 9, 4, 6, alerts("donut", "severity")),
      chart(4, 9, 4, 6, commands("column", "status")),
      chart(8, 9, 4, 6, fleet("bar-h", "agent", "score", 7)),
    ],
  },
  // Compliance in depth.
  {
    id: "compliance",
    icon: "ph-seal-check",
    cells: [
      chart(0, 0, 3, 3, fleet("kpi-delta", "mode", "score", 7)),
      stat("stat-denials", 3, 0),
      stat("stat-alerts", 6, 0),
      stat("stat-commands", 9, 0),
      chart(0, 3, 8, 6, fleet("multi-line", "mode", "score", 90)),
      widget("compliance-checks", 8, 3, 4, 6),
      chart(0, 9, 4, 6, denials("donut", "tclass")),
      widget("open-alerts", 4, 9, 4, 6),
      widget("recent-deployments", 8, 9, 4, 6),
    ],
  },
  // Rollouts in depth.
  {
    id: "deployments",
    icon: "ph-rocket-launch",
    cells: [
      chart(0, 0, 3, 3, commands("kpi-delta", "type", 7)),
      stat("stat-denials", 3, 0),
      stat("stat-alerts", 6, 0),
      stat("stat-agents", 9, 0),
      chart(0, 3, 8, 6, commands("stacked-bar", "status")),
      widget("recent-deployments", 8, 3, 4, 6),
      chart(0, 9, 4, 6, denials("area", "tclass")),
      chart(4, 9, 4, 6, alerts("column", "severity")),
      widget("agents-by-mode", 8, 9, 4, 6),
    ],
  },
  // Each machine across every family.
  {
    id: "fleet",
    icon: "ph-hard-drives",
    cells: [
      chart(0, 0, 3, 3, fleet("kpi-delta", "mode", "online", 7)),
      stat("stat-denials", 3, 0),
      stat("stat-alerts", 6, 0),
      stat("stat-commands", 9, 0),
      widget("agents-vignettes", 0, 3, 8, 6),
      chart(8, 3, 4, 6, fleet("bar-h", "agent", "online", 7)),
      chart(0, 9, 4, 6, denials("bar-h", "agent")),
      chart(4, 9, 4, 6, alerts("bar-h", "agent")),
      chart(8, 9, 4, 6, commands("bar-h", "agent")),
    ],
  },
];

export interface PlacedWidget {
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  limit?: number;
  config?: ChartConfig;
}

// Rows available for a dashboard in a window: never fewer than one classic
// screen (a shorter window simply scrolls), never more than MAX_ROWS.
export function rowsForViewport(rawRows: number): number {
  return Math.max(BASE_ROWS, Math.min(MAX_ROWS, rawRows));
}

// The template's cells stretched from BASE_ROWS to `rows`. Cell edges are
// scaled and rounded, not sizes, so neighbours keep sharing an edge and the
// tiling stays exact; with rows >= BASE_ROWS no cell gets smaller.
export function placeTemplate(template: DashboardTemplate, rows: number): PlacedWidget[] {
  const k = Math.max(BASE_ROWS, rows) / BASE_ROWS;
  return template.cells.map((c) => {
    const y = Math.round(c.y * k);
    const h = Math.round((c.y + c.h) * k) - y;
    return { type: c.type, x: c.x, y, w: c.w, h, limit: fitLimit(c.type, c.w, h), config: c.chart };
  });
}

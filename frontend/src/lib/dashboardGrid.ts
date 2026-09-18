// Grid geometry and widget size rules shared by the dashboard page, its
// random layout and the templates. Free of React so it can run under Node.

export const GRID_COLS = 12;
export const ROW_HEIGHT = 32;
export const MARGIN: readonly [number, number] = [11, 11];

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
  | "agents-by-mode"
  | "pending-suggestions"
  | "active-collections"
  | "attention-agents"
  | "chart";

export const WIDGET_MIN: Record<WidgetType, { w: number; h: number }> = {
  "stat-agents": { w: 3, h: 3 },
  "stat-enforcing": { w: 3, h: 3 },
  "stat-denials": { w: 3, h: 3 },
  "stat-commands": { w: 3, h: 3 },
  "stat-alerts": { w: 3, h: 3 },
  "stat-compliance": { w: 3, h: 3 },
  "top-signatures": { w: 3, h: 4 },
  "recent-deployments": { w: 3, h: 4 },
  "open-alerts": { w: 3, h: 4 },
  "denial-trend": { w: 4, h: 5 },
  "agents-vignettes": { w: 3, h: 4 },
  "compliance-checks": { w: 3, h: 4 },
  "agents-by-mode": { w: 3, h: 4 },
  "pending-suggestions": { w: 3, h: 4 },
  "active-collections": { w: 3, h: 4 },
  "attention-agents": { w: 3, h: 4 },
  chart: { w: 2, h: 3 },
};

export const LIST_WIDGETS: WidgetType[] = [
  "top-signatures",
  "recent-deployments",
  "open-alerts",
  "agents-vignettes",
  "pending-suggestions",
  "active-collections",
  "attention-agents",
];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// How many rows of a list widget fit its cell: a row is ~38px under a title,
// a vignette ~72px tall and ~136px wide.
export function fitLimit(type: WidgetType, w: number, h: number): number | undefined {
  if (!LIST_WIDGETS.includes(type)) return undefined;
  const heightPx = h * (ROW_HEIGHT + MARGIN[1]) - 75;
  if (type === "agents-vignettes") {
    const perRow = Math.max(1, Math.floor((w * 100 - 32) / 136));
    return clamp(perRow * Math.max(1, Math.floor(heightPx / 72)), 2, 50);
  }
  return clamp(Math.floor(heightPx / 38), 2, 50);
}

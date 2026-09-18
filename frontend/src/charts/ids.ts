// The chart type ids by family, kept apart from the registry so that code
// which only needs the names (the dashboard's random layout, tile sizing)
// does not pull in every chart builder. registry.ts checks it stays in sync.
export type ChartCategory = "classic" | "share" | "kpi" | "stats" | "corr";

export const CHART_IDS: Record<ChartCategory, string[]> = {
  classic: ["bar", "column", "bar-h", "grouped-bar", "stacked-bar", "stacked-100", "line", "multi-line", "area", "stacked-area", "step", "combo", "waterfall", "heatmap"],
  share: ["pie", "donut", "semi-donut", "treemap", "sunburst", "marimekko"],
  kpi: ["kpi", "kpi-delta", "kpi-spark", "gauge", "progress", "bullet", "target-actual", "scorecard", "metric-card", "delta"],
  stats: ["histogram", "boxplot", "violin", "scatter", "bubble", "density", "dot-plot", "strip", "beeswarm", "ecdf", "pareto", "qq", "hour-heatmap"],
  corr: ["corr-matrix", "corr-heatmap", "pair-plot", "hexbin"],
};

export const ALL_CHART_IDS: string[] = Object.values(CHART_IDS).flat();

// KPI-style types read at a glance and suit the smallest dashboard tiles.
export function isTileSized(id: string): boolean {
  return CHART_IDS.kpi.includes(id) && id !== "scorecard";
}

import { resolveConfig } from "./datasets.ts";
import { CHART_IDS } from "./ids.ts";
import { windowFor } from "./shape.ts";
import type { ChartConfig } from "./types.ts";

type T = (key: string, vars?: Record<string, string | number>) => string;

const OVER_TIME = ["column", "line", "area", "step", "combo", "waterfall"];
const DISTRIBUTION = ["histogram", "density", "qq"];
const PAIR = ["scatter", "bubble", "hexbin"];
const VARIABLES = ["corr-matrix", "corr-heatmap", "pair-plot"];
const MATRIX = ["grouped-bar", "stacked-bar", "stacked-100", "marimekko", "heatmap"];
const HIERARCHY = ["treemap", "sunburst"];
const HOURLY = ["hour-heatmap"];

// What a tile shows, in words, for the dashboard's normal (non-edit) view:
// the data and the period, not the kind of chart. "Denials par classe (30
// jours)", "Score de conformité par mode (90 jours)".
export function chartDataTitle(cfg: ChartConfig, t: T): string {
  const { def, measure, dim, dim2, dim3 } = resolveConfig(cfg);
  // An averaged or multi-measure dataset is named by its measure: "État du
  // parc" alone would not say whether it is the score or the availability.
  const subject = def.measures.length > 1 || !measure.additive ? t(measure.labelKey) : t(def.labelKey);
  const dimName = (d: string) => t("charts.dims." + d).toLowerCase();
  const unit = t("charts.perBucket." + windowFor(cfg.days, 0).bucket);
  let core: string;
  if (CHART_IDS.kpi.includes(cfg.chart) && cfg.chart !== "scorecard") core = subject;
  else if (PAIR.includes(cfg.chart)) core = t("charts.title.pair", { dataset: subject, x: t(def.variables[0].labelKey), y: t(def.variables[1].labelKey) });
  else if (VARIABLES.includes(cfg.chart)) core = t("charts.title.vars", { dataset: subject, vars: def.variables.map((v) => t(v.labelKey)).join(", ") });
  else if (DISTRIBUTION.includes(cfg.chart)) core = t("charts.title.distribution", { dataset: subject, unit });
  else if (OVER_TIME.includes(cfg.chart)) core = t("charts.title.overTime", { dataset: subject, unit });
  else if (HOURLY.includes(cfg.chart)) core = t("charts.title.byHour", { dataset: subject });
  else if (MATRIX.includes(cfg.chart)) core = t("charts.title.byDim2", { dataset: subject, dim: dimName(dim), dim2: dimName(dim2) });
  else if (HIERARCHY.includes(cfg.chart)) core = t("charts.title.byDim3", { dataset: subject, dim: dimName(dim), dim2: dimName(dim2), dim3: dimName(dim3) });
  else core = t("charts.title.byDim", { dataset: subject, dim: dimName(dim) });
  return t("charts.title.withPeriod", { title: core, period: t("charts.periods." + cfg.days) });
}

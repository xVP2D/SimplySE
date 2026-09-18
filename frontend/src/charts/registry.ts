import type { ReactNode } from "react";
import type { ChartInput } from "./types.ts";
import type { BuildCtx, Opt } from "./builders/common.ts";
import * as classic from "./builders/classic.ts";
import * as share from "./builders/share.ts";
import * as stats from "./builders/stats.ts";
import * as corr from "./builders/corr.ts";
import * as html from "./builders/html.tsx";

import { ALL_CHART_IDS, isTileSized as tileSized, type ChartCategory } from "./ids.ts";

export type { ChartCategory };

// What a chart type needs from the shared input before it can draw anything
// meaningful; without it the tile says so instead of drawing an empty frame.
export type Need = "categories" | "time" | "matrix" | "heat" | "hourly" | "hierarchy" | "kpi" | "samples1" | "samples3" | "pooled3" | "pooled5" | "points" | "variables";

export interface ChartDef {
  id: string;
  category: ChartCategory;
  also?: ChartCategory[]; // listed in these categories too
  need: Need;
  build?: (ctx: BuildCtx) => Opt;
  render?: (ctx: BuildCtx) => ReactNode;
}

export const CATEGORIES: ChartCategory[] = ["classic", "share", "kpi", "stats", "corr"];

const def = (id: string, category: ChartCategory, need: Need, impl: Pick<ChartDef, "build" | "render">, also?: ChartCategory[]): ChartDef => ({ id, category, need, also, ...impl });

export const CHARTS: ChartDef[] = [
  // classic
  def("bar", "classic", "categories", { build: classic.bar }),
  def("column", "classic", "time", { build: classic.column }),
  def("bar-h", "classic", "categories", { build: classic.barHorizontal }),
  def("grouped-bar", "classic", "matrix", { build: classic.groupedBar }),
  def("stacked-bar", "classic", "matrix", { build: classic.stackedBar }),
  def("stacked-100", "classic", "matrix", { build: classic.stacked100 }),
  def("line", "classic", "time", { build: classic.line }),
  def("multi-line", "classic", "time", { build: classic.multiLine }),
  def("area", "classic", "time", { build: classic.area }),
  def("stacked-area", "classic", "time", { build: classic.stackedArea }),
  def("step", "classic", "time", { build: classic.step }),
  def("combo", "classic", "time", { build: classic.combo }),
  def("waterfall", "classic", "time", { build: classic.waterfall }),
  def("heatmap", "classic", "heat", { build: classic.heatmap }),
  // share
  def("pie", "share", "categories", { build: share.pie }),
  def("donut", "share", "categories", { build: share.donut }),
  def("semi-donut", "share", "categories", { build: share.semiDonut }),
  def("treemap", "share", "hierarchy", { build: share.treemap }),
  def("sunburst", "share", "hierarchy", { build: share.sunburst }),
  def("marimekko", "share", "matrix", { build: share.marimekko }),
  // kpi
  def("kpi", "kpi", "kpi", { render: html.kpiCard }),
  def("kpi-delta", "kpi", "kpi", { render: html.kpiDelta }),
  def("kpi-spark", "kpi", "kpi", { render: html.kpiSpark }),
  def("gauge", "kpi", "kpi", { build: html.gauge }),
  def("progress", "kpi", "kpi", { render: html.progress }),
  def("bullet", "kpi", "kpi", { render: html.bullet }),
  def("target-actual", "kpi", "kpi", { render: html.targetActual }),
  def("scorecard", "kpi", "categories", { render: html.scorecard }),
  def("metric-card", "kpi", "kpi", { render: html.metricCard }),
  def("delta", "kpi", "kpi", { render: html.deltaIndicator }),
  // statistics
  def("histogram", "stats", "pooled3", { build: stats.histogram }),
  def("boxplot", "stats", "samples3", { build: stats.boxplot }),
  def("violin", "stats", "samples3", { build: stats.violin }),
  def("scatter", "stats", "points", { build: stats.scatter }, ["corr"]),
  def("bubble", "stats", "points", { build: stats.bubble }, ["corr"]),
  def("density", "stats", "pooled3", { build: stats.density }),
  def("dot-plot", "stats", "categories", { build: stats.dotPlot }),
  def("strip", "stats", "samples1", { build: stats.strip }),
  def("beeswarm", "stats", "samples1", { build: stats.beeswarmChart }),
  def("ecdf", "stats", "samples3", { build: stats.ecdfChart }),
  def("pareto", "stats", "categories", { build: stats.pareto }),
  def("qq", "stats", "pooled5", { build: stats.qq }),
  def("hour-heatmap", "stats", "hourly", { build: stats.hourHeatmap }),
  // correlation
  def("corr-matrix", "corr", "variables", { render: html.corrMatrix }),
  def("corr-heatmap", "corr", "variables", { build: corr.corrHeatmap }),
  def("pair-plot", "corr", "variables", { build: corr.pairPlot }),
  def("hexbin", "corr", "points", { build: corr.hexbinChart }),
];

export const CHART_BY_ID = new Map(CHARTS.map((c) => [c.id, c]));

export function chartsIn(category: ChartCategory): ChartDef[] {
  return CHARTS.filter((c) => c.category === category || c.also?.includes(category));
}

export const isTileSized = tileSized;

// ids.ts is the lightweight copy of the names; fail loudly if they drift.
for (const id of ALL_CHART_IDS) if (!CHART_BY_ID.has(id)) throw new Error(`chart id ${id} is listed in ids.ts but not registered`);
for (const c of CHARTS) if (!ALL_CHART_IDS.includes(c.id)) throw new Error(`chart ${c.id} is registered but missing from ids.ts`);

export function hasData(chart: ChartDef, input: ChartInput): boolean {
  const pooled = input.samples.reduce((n, s) => n + s.values.length, 0);
  switch (chart.need) {
    case "categories":
      return input.categories.length > 0;
    case "time":
      return !input.empty && input.time.ts.length >= 2;
    case "matrix":
      return input.matrix.rows.length > 0 && input.matrix.cols.length > 0;
    case "heat":
      return input.heat.rows.length > 0 && input.heat.cols.length > 0;
    case "hourly":
      return input.hourly.length >= 8;
    case "hierarchy":
      return input.hierarchy.length > 0;
    case "kpi":
      return !input.empty;
    case "samples1":
      return input.samples.some((s) => s.values.length >= 1);
    case "samples3":
      return input.samples.some((s) => s.values.length >= 3);
    case "pooled3":
      return pooled >= 3;
    case "pooled5":
      return pooled >= 5;
    case "points":
      return input.points.length >= 5;
    case "variables":
      return input.variables.rows.length >= 5 && input.variables.names.length >= 2;
  }
}

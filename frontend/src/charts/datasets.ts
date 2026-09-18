import type { ChartConfig, ChartInput, DatasetDef, DatasetId, MeasureDef, Row } from "./types.ts";
import { buildChartInput, windowFor } from "./shape.ts";
import { fetchHistory, historySince, toRows } from "./history.ts";

// One history row per (agent, day) is requested for the statistical charts;
// the server already computed each variable, so this only reads it back.
const raw = (rows: Row[], field: string) => rows[0]?.raw?.[field] ?? 0;

const count = (labelKey: string, polarity: MeasureDef["polarity"], id = "count", field = id): MeasureDef => ({
  id,
  labelKey,
  field,
  additive: true,
  unit: "count",
  polarity,
});

// An average over the rows that have something to average: a latency exists
// only for acknowledged commands, so it is weighted by that count.
const averaged = (id: string, unit: MeasureDef["unit"], polarity: MeasureDef["polarity"], weightField: string): MeasureDef => ({
  id,
  labelKey: `charts.measures.${id}`,
  field: id,
  additive: false,
  unit,
  polarity,
  weightField,
});

// The four recorded histories (see the master's internal/history). The order
// of `dims` matters: a chart's second and third dimensions (for grouped and
// stacked bars, matrices and hierarchies) are the first ones that differ from
// the chosen one.
export const DATASETS: Record<DatasetId, DatasetDef> = {
  denials: {
    id: "denials",
    labelKey: "charts.datasets.denials",
    dims: ["tclass", "agent", "scontext", "tcontext", "perms"],
    defaultDim: "tclass",
    measures: [count("charts.measures.denials", "lowerBetter")],
    variables: [
      { id: "total", labelKey: "charts.vars.denials.total" },
      { id: "signatures", labelKey: "charts.vars.denials.signatures" },
      { id: "hours", labelKey: "charts.vars.denials.hours" },
    ],
    variableGroup: ["agent"],
    variableFrom: (rows) => [raw(rows, "count"), raw(rows, "signatures"), raw(rows, "active_hours")],
  },
  commands: {
    id: "commands",
    labelKey: "charts.datasets.commands",
    dims: ["type", "status", "agent", "kind", "error"],
    defaultDim: "type",
    measures: [
      count("charts.measures.commands", "neutral"),
      count("charts.measures.failed", "lowerBetter", "failed"),
      averaged("failure_rate", "percent", "lowerBetter", "count"),
      averaged("latency", "seconds", "lowerBetter", "acked"),
      count("charts.measures.reverts", "neutral", "reverts"),
    ],
    variables: [
      { id: "total", labelKey: "charts.vars.commands.total" },
      { id: "failed", labelKey: "charts.vars.commands.failed" },
      { id: "types", labelKey: "charts.vars.commands.types" },
    ],
    variableGroup: ["agent"],
    variableFrom: (rows) => [raw(rows, "count"), raw(rows, "failed"), raw(rows, "types")],
  },
  alerts: {
    id: "alerts",
    labelKey: "charts.datasets.alerts",
    dims: ["severity", "type", "status", "agent", "acked_by"],
    defaultDim: "severity",
    measures: [
      count("charts.measures.alerts", "lowerBetter"),
      count("charts.measures.high", "lowerBetter", "high"),
      count("charts.measures.acked", "higherBetter", "acked"),
      count("charts.measures.open", "lowerBetter", "open"),
      averaged("ack_time", "seconds", "lowerBetter", "acked"),
      averaged("open_age", "seconds", "lowerBetter", "open"),
    ],
    variables: [
      { id: "total", labelKey: "charts.vars.alerts.total" },
      { id: "high", labelKey: "charts.vars.alerts.high" },
      { id: "types", labelKey: "charts.vars.alerts.types" },
    ],
    variableGroup: ["agent"],
    variableFrom: (rows) => [raw(rows, "count"), raw(rows, "high"), raw(rows, "types")],
  },
  signatures: {
    id: "signatures",
    labelKey: "charts.datasets.signatures",
    dims: ["tclass", "scontext", "tcontext", "perms"],
    defaultDim: "tclass",
    measures: [count("charts.measures.signatures", "lowerBetter")],
    variables: [
      { id: "total", labelKey: "charts.vars.signatures.total" },
      { id: "sources", labelKey: "charts.vars.signatures.sources" },
    ],
    variableGroup: ["tclass"],
    variableFrom: (rows) => [raw(rows, "count"), raw(rows, "sources")],
  },
  fleet: {
    id: "fleet",
    labelKey: "charts.datasets.fleet",
    dims: ["mode", "agent", "policy"],
    defaultDim: "mode",
    measures: [
      { id: "score", labelKey: "charts.measures.score", field: "score", additive: false, unit: "percent", polarity: "higherBetter" },
      { id: "online", labelKey: "charts.measures.online", field: "online", additive: false, unit: "percent", polarity: "higherBetter", scale: 100 },
      { id: "open_alerts", labelKey: "charts.measures.openAlerts", field: "open_alerts", additive: false, unit: "count", polarity: "lowerBetter" },
    ],
    variables: [
      { id: "score", labelKey: "charts.vars.fleet.score" },
      { id: "online", labelKey: "charts.vars.fleet.online" },
      { id: "alerts", labelKey: "charts.vars.fleet.alerts" },
    ],
    variableGroup: ["agent"],
    variableFrom: (rows) => {
      const raw = rows[0]?.raw ?? {};
      return [raw.score ?? 0, (raw.online ?? 0) * 100, raw.open_alerts ?? 0];
    },
  },
};

export const DATASET_IDS: DatasetId[] = ["denials", "commands", "alerts", "signatures", "fleet"];
export const PERIODS = [1, 7, 30, 90, 365];

export function resolveConfig(cfg: Pick<ChartConfig, "dataset" | "dim" | "measure" | "dim2">) {
  const def = DATASETS[cfg.dataset] ?? DATASETS.denials;
  const measure = def.measures.find((m) => m.id === cfg.measure) ?? def.measures[0];
  const dim = def.dims.includes(cfg.dim) ? cfg.dim : def.defaultDim;
  const others = def.dims.filter((d) => d !== dim);
  const dim2 = cfg.dim2 && others.includes(cfg.dim2) ? cfg.dim2 : others[0];
  const rest = others.filter((d) => d !== dim2);
  return { def, measure, dim, dim2, dim3: rest[0] ?? dim2 };
}

export const DEFAULT_CHART: ChartConfig = { dataset: "denials", chart: "multi-line", dim: "tclass", days: 30 };

export async function loadChartInput(cfg: Pick<ChartConfig, "dataset" | "dim" | "dim2" | "days" | "measure">): Promise<ChartInput> {
  const { def, measure, dim, dim2, dim3 } = resolveConfig(cfg);
  const nowSec = Math.floor(Date.now() / 1000);
  // One window for every query: the totals of a bar chart, a treemap and a
  // KPI are the same rows, so they can never disagree. Every one of these is
  // fetched regardless of the chart type actually picked, the same way tree
  // and vars already were: the gallery shows every chart type from one load.
  const win = windowFor(cfg.days, nowSec);
  const [timed, tree, vars, sinceSec, hourly] = await Promise.all([
    fetchHistory(def.id, { from: win.previousStart, bucket: win.bucket, group: [dim, dim2] }),
    fetchHistory(def.id, { from: win.periodStart, bucket: "none", group: [dim, dim2, dim3] }),
    fetchHistory(def.id, { from: win.periodStart, bucket: "day", group: def.variableGroup }),
    historySince(def.id),
    fetchHistory(def.id, { from: win.periodStart, bucket: "hour", group: [] }),
  ]);
  return buildChartInput({
    def,
    measure,
    dim,
    dim2,
    dim3,
    days: cfg.days,
    win,
    timeRows: toRows(timed, measure),
    treeRows: toRows(tree, measure),
    varRows: toRows(vars, measure),
    hourlyRows: toRows(hourly, measure),
    nowSec,
    sinceSec,
    truncated: timed.truncated || tree.truncated || vars.truncated || hourly.truncated,
  });
}

// A random but sensible configuration, for the dashboard's random layout:
// tile-sized KPI types for small cells, anything else for larger ones.
export function randomChartConfig(chart: string, rng: () => number = Math.random): ChartConfig {
  const dataset = DATASET_IDS[Math.floor(rng() * DATASET_IDS.length)];
  const def = DATASETS[dataset];
  const days = [7, 30, 90][Math.floor(rng() * 3)];
  return { dataset, chart, dim: def.defaultDim, days, measure: def.measures[0].id };
}

import type { ChartConfig, ChartInput, DatasetDef, DatasetId, MeasureDef, Row } from "./types.ts";
import { bucketFor, buildChartInput } from "./shape.ts";
import { fetchHistory, toRows } from "./history.ts";

// One history row per (agent, day) is requested for the statistical charts;
// the server already computed each variable, so this only reads it back.
const raw = (rows: Row[], field: string) => rows[0]?.raw?.[field] ?? 0;

const count = (labelKey: string, polarity: MeasureDef["polarity"]): MeasureDef => ({
  id: "count",
  labelKey,
  field: "count",
  additive: true,
  unit: "count",
  polarity,
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
    dims: ["type", "status", "agent", "kind"],
    defaultDim: "type",
    measures: [count("charts.measures.commands", "neutral")],
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
    dims: ["severity", "type", "status", "agent"],
    defaultDim: "severity",
    measures: [count("charts.measures.alerts", "lowerBetter")],
    variables: [
      { id: "total", labelKey: "charts.vars.alerts.total" },
      { id: "high", labelKey: "charts.vars.alerts.high" },
      { id: "types", labelKey: "charts.vars.alerts.types" },
    ],
    variableGroup: ["agent"],
    variableFrom: (rows) => [raw(rows, "count"), raw(rows, "high"), raw(rows, "types")],
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

export const DATASET_IDS: DatasetId[] = ["denials", "commands", "alerts", "fleet"];
export const PERIODS = [1, 7, 30, 90, 365];

export function resolveConfig(cfg: Pick<ChartConfig, "dataset" | "dim" | "measure">) {
  const def = DATASETS[cfg.dataset] ?? DATASETS.denials;
  const measure = def.measures.find((m) => m.id === cfg.measure) ?? def.measures[0];
  const dim = def.dims.includes(cfg.dim) ? cfg.dim : def.defaultDim;
  const others = def.dims.filter((d) => d !== dim);
  return { def, measure, dim, dim2: others[0], dim3: others[1] ?? others[0] };
}

export const DEFAULT_CHART: ChartConfig = { dataset: "denials", chart: "multi-line", dim: "tclass", days: 30 };

export async function loadChartInput(cfg: Pick<ChartConfig, "dataset" | "dim" | "days" | "measure">): Promise<ChartInput> {
  const { def, measure, dim, dim2, dim3 } = resolveConfig(cfg);
  const { bucket, queryDays } = bucketFor(cfg.days);
  const [timed, tree, vars] = await Promise.all([
    fetchHistory(def.id, { days: queryDays, bucket, group: [dim, dim2] }),
    fetchHistory(def.id, { days: cfg.days, bucket: "none", group: [dim, dim2, dim3] }),
    fetchHistory(def.id, { days: cfg.days, bucket: "day", group: def.variableGroup }),
  ]);
  return buildChartInput({
    def,
    measure,
    dim,
    dim2,
    dim3,
    days: cfg.days,
    bucket,
    timeRows: toRows(timed, measure),
    treeRows: toRows(tree, measure),
    varRows: toRows(vars, measure),
    nowSec: Math.floor(Date.now() / 1000),
    truncated: timed.truncated || tree.truncated || vars.truncated,
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

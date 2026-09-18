import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY,
  beeswarm,
  boxStats,
  bucketRange,
  bucketStart,
  buildChartInput,
  combine,
  correlationMatrix,
  ecdf,
  formatDuration,
  hexbin,
  histogramBins,
  kde,
  linspace,
  movingAverage,
  normalQuantile,
  pearson,
  qqPoints,
  quantile,
  windowFor,
} from "../src/charts/shape.ts";
import type { DatasetDef, MeasureDef, Row } from "../src/charts/types.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("weeks start on Monday, like Postgres date_trunc('week')", () => {
  // 2026-09-18 is a Friday; its Monday is 2026-09-14 00:00 UTC.
  const friday = Date.UTC(2026, 8, 18, 15, 30) / 1000;
  const monday = Date.UTC(2026, 8, 14) / 1000;
  assert.equal(bucketStart(friday, "week"), monday);
  assert.equal(bucketStart(monday, "week"), monday);
  assert.equal(bucketStart(monday - 1, "week"), monday - 7 * DAY);
  assert.equal(bucketStart(friday, "day"), Date.UTC(2026, 8, 18) / 1000);
  assert.equal(bucketStart(friday, "hour"), Date.UTC(2026, 8, 18, 15) / 1000);
});

test("a window is a whole number of buckets, the previous one the same length", () => {
  const now = Date.UTC(2026, 8, 18, 15, 30) / 1000; // a Friday afternoon
  const day = windowFor(30, now);
  assert.equal(day.bucket, "day");
  assert.equal(day.buckets, 30);
  assert.equal(day.periodStart, Date.UTC(2026, 7, 20) / 1000, "today plus the 29 days before");
  assert.equal(day.periodStart - day.previousStart, 30 * DAY, "the previous period has as many days");
  assert.equal(bucketRange(day.periodStart, now, "day").length, 30, "no extra partial bucket at the start");

  const hours = windowFor(1, now);
  assert.equal(hours.bucket, "hour");
  assert.equal(hours.buckets, 24);
  assert.equal(bucketRange(hours.periodStart, now, "hour").length, 24);

  const weeks = windowFor(90, now);
  assert.equal(weeks.bucket, "day", "up to 120 days stays daily");
  const year = windowFor(365, now);
  assert.equal(year.bucket, "week");
  assert.equal(year.buckets, 52);
  assert.equal(bucketRange(year.periodStart, now, "week").length, 52);
  assert.equal(year.periodStart, bucketStart(year.periodStart, "week"), "weeks start on a Monday");
});

test("bucketRange covers both ends", () => {
  const from = Date.UTC(2026, 8, 10, 5) / 1000;
  const to = Date.UTC(2026, 8, 12, 1) / 1000;
  assert.equal(bucketRange(from, to, "day").length, 3);
});

test("quantiles and Tukey box statistics", () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  close(quantile(s, 0.5), 5.5);
  close(quantile(s, 0.25), 3.25);
  const b = boxStats([1, 2, 3, 4, 5, 100]);
  assert.deepEqual(b.outliers, [100]);
  assert.equal(b.max, 5, "the whisker stops at the last value inside the fence");
  assert.equal(b.min, 1);
});

test("a kernel density estimate integrates to about one", () => {
  const values = [2, 3, 3, 4, 4, 4, 5, 5, 6, 9];
  const grid = linspace(-10, 20, 600);
  const d = kde(values, grid);
  const area = d.reduce((a, v) => a + v * (grid[1] - grid[0]), 0);
  close(area, 1, 0.01);
  assert.ok(d.every((v) => v >= 0));
  // constant sample: still a finite curve, not NaN
  assert.ok(kde([5, 5, 5], [4, 5, 6]).every((v) => Number.isFinite(v)));
});

test("histogram bins account for every value, integers get whole-number bins", () => {
  const v = [1, 1, 2, 3, 3, 3, 4, 8, 9, 20];
  const bins = histogramBins(v, 12);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), v.length);
  for (const b of bins) assert.ok(Number.isInteger(b.start) && Number.isInteger(b.end));
  assert.equal(histogramBins([7, 7, 7]).length, 1);
  assert.deepEqual(histogramBins([]), []);
});

test("pearson correlation", () => {
  close(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  close(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.ok(Number.isNaN(pearson([1, 1, 1], [1, 2, 3])), "no variance means the correlation is undefined, not 0");
  const m = correlationMatrix([[1, 2, 3], [3, 2, 1], [1, 2, 3]]);
  close(m[0][1], -1);
  close(m[0][2], 1);
  close(m[1][1], 1);
  const withConstant = correlationMatrix([[1, 2, 3], [5, 5, 5]]);
  assert.ok(Number.isNaN(withConstant[1][1]) && Number.isNaN(withConstant[0][1]), "a constant variable has no correlation, not even with itself");
});

test("normal quantiles match the known values", () => {
  close(normalQuantile(0.5), 0);
  close(normalQuantile(0.975), 1.959964, 1e-5);
  close(normalQuantile(0.025), -1.959964, 1e-5);
  close(normalQuantile(0.001), -3.090232, 1e-4);
  const qq = qqPoints([5, 1, 3]);
  assert.deepEqual(qq.map((p) => p.sample), [1, 3, 5]);
  assert.ok(qq[0].theory < qq[1].theory && qq[1].theory < qq[2].theory);
});

test("ECDF is a non-decreasing staircase ending at one", () => {
  const e = ecdf([3, 1, 2, 2]);
  assert.deepEqual(e.map((p) => p[0]), [1, 2, 2, 3]);
  assert.equal(e[e.length - 1][1], 1);
});

test("moving average ignores gaps", () => {
  assert.deepEqual(movingAverage([2, 4, NaN, 6], 2), [2, 3, 4, 6]);
});

test("hexbin keeps every point and tiles without empty duplicates", () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ x: (i * 37) % 101, y: (i * 53) % 97 }));
  const g = hexbin(pts, 10);
  assert.equal(g.bins.reduce((a, b) => a + b.count, 0), 200);
  assert.equal(g.vertices.length, 6);
  const keys = new Set(g.bins.map((b) => b.cx.toFixed(6) + "," + b.cy.toFixed(6)));
  assert.equal(keys.size, g.bins.length, "no two bins share a centre");
  assert.equal(hexbin([], 10).bins.length, 0);
  assert.equal(hexbin([{ x: 1, y: 1 }, { x: 1, y: 1 }], 10).bins.length, 1, "identical points fall in one bin");
});

test("beeswarm spreads a crowded bin symmetrically and stays in bounds", () => {
  const off = beeswarm([5, 5, 5, 5, 9], 1);
  close(off.slice(0, 4).reduce((a, b) => a + b, 0), 0);
  assert.equal(off[4], 0);
  assert.ok(off.every((o) => Math.abs(o) <= 0.42 + 1e-9));
  assert.equal(new Set(off.slice(0, 4).map((o) => o.toFixed(6))).size, 4, "no two crowded points overlap");
});

// ── buildChartInput ─────────────────────────────────────────────────────

const countMeasure: MeasureDef = { id: "count", labelKey: "m", field: "count", additive: true, unit: "count", polarity: "lowerBetter" };
const scoreMeasure: MeasureDef = { id: "score", labelKey: "m", field: "score", additive: false, unit: "percent", polarity: "higherBetter" };
const def = (id: "denials" | "fleet"): DatasetDef => ({
  id,
  labelKey: "d",
  dims: ["agent", "tclass"],
  defaultDim: "tclass",
  measures: [],
  variables: [{ id: "a", labelKey: "a" }, { id: "b", labelKey: "b" }, { id: "c", labelKey: "c" }],
  variableGroup: ["agent", "tclass"],
  variableFrom: (rows) => [rows.reduce((s, r) => s + r.value, 0), rows.length, 1],
});
const now = Date.UTC(2026, 8, 18, 12) / 1000;
const day = (n: number) => Math.floor(now / DAY) * DAY - n * DAY;
const row = (t: number | null, tclass: string, agent: string, v: number, w = v): Row => ({ t, dims: { tclass, agent }, value: v, weight: w });
const longAgo = now - 400 * DAY; // a history that covers everything asked below

function build(over: Partial<Parameters<typeof buildChartInput>[0]> & { days?: number }) {
  const days = over.days ?? 7;
  return buildChartInput({
    def: def("denials"), measure: countMeasure, dim: "tclass", dim2: "agent", dim3: "agent", days, win: windowFor(days, now),
    timeRows: [], treeRows: [], varRows: [], nowSec: now, sinceSec: longAgo, truncated: false, ...over,
  });
}

test("buildChartInput: categories, zero-filled time series, previous period, matrix", () => {
  const timeRows = [
    row(day(0), "file", "a1", 5),
    row(day(0), "dir", "a1", 1),
    row(day(2), "file", "a2", 3),
    row(day(9), "file", "a1", 4), // previous window (7 days, so days 7..13 back)
  ];
  const input = build({ timeRows, treeRows: [row(null, "file", "a1", 8), row(null, "dir", "a1", 1)] });
  assert.equal(input.empty, false);
  assert.deepEqual(input.categories.map((c) => [c.name, c.value]), [["file", 8], ["dir", 1]]);
  assert.equal(input.time.total.length, 7, "one entry per day of the period, gaps included");
  assert.equal(input.time.total[input.time.total.length - 1], 6);
  assert.equal(input.time.total.reduce((a, b) => a + b, 0), 9, "totals add up to the period's events");
  assert.equal(input.kpi.value, 9);
  assert.equal(input.kpi.previous, 4);
  assert.equal(input.kpi.previousByCategory.file, 4);
  assert.deepEqual(input.matrix.rows, ["file", "dir"]);
  assert.deepEqual(input.matrix.cols.sort(), ["a1", "a2"]);
  assert.equal(input.matrix.weights.flat().reduce((a, b) => a + b, 0), 9, "the matrix holds every event");
  assert.equal(input.hierarchy[0].name, "file");
  assert.equal(input.hierarchy[0].value, 8);
});

test("buildChartInput: a comparison needs a history that covers the previous period", () => {
  const rows = [row(day(1), "file", "a1", 2)];
  // no previous rows but the history reaches back: the previous period really was zero
  assert.equal(build({ timeRows: rows }).kpi.previous, 0);
  assert.equal(build({ timeRows: rows }).kpi.targetSource, "previous");
  // the history starts inside the previous period: a "+100 %" would be fiction
  const partial = build({ timeRows: rows, sinceSec: day(10) });
  assert.equal(partial.kpi.previous, null);
  assert.equal(partial.kpi.targetSource, "none");
  // unknown start (status unreadable): no comparison either
  assert.equal(build({ timeRows: rows, sinceSec: null }).kpi.previous, null);
  // a year cannot be compared with the year before: the server keeps 366 days
  assert.equal(build({ timeRows: rows, days: 365 }).kpi.previous, null);
});

test("buildChartInput: averaged measures are weighted by sample count and leave real gaps", () => {
  const rows = [row(day(1), "enforcing", "a", 100, 3), row(day(1), "permissive", "a", 50, 1)];
  const input = build({ def: def("fleet"), measure: scoreMeasure, days: 3, timeRows: rows });
  close(input.kpi.value, (100 * 3 + 50 * 1) / 4);
  assert.ok(input.time.total.some((v) => Number.isNaN(v)), "days without samples are gaps, not zeros");
  assert.ok(input.kpi.spark.every((v) => Number.isFinite(v)), "the sparkline is continuous");
  assert.equal(input.kpi.previous, null, "an average over no samples is unknown, not 0 %");
  assert.equal(combine([], false).value, 0);
});

test("buildChartInput: the tail of many categories becomes one 'other' series", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g"].map((c, i) => row(day(0), c, "x", 10 - i));
  const input = build({ days: 3, timeRows: rows });
  assert.equal(input.time.series.length, 6);
  assert.equal(input.time.series[5].name, "::other::");
  assert.equal(input.time.series[5].values[input.time.series[5].values.length - 1], 5 + 4);
});

test("buildChartInput: variables per agent-day feed the points", () => {
  const varRows = [row(day(0), "file", "a1", 4), row(day(0), "dir", "a1", 2), row(day(1), "file", "a2", 7)];
  const input = build({ varRows });
  assert.equal(input.empty, true);
  assert.equal(input.points.length, 2);
  const a1 = input.points.find((p) => p.group === "a1")!;
  assert.deepEqual([a1.x, a1.y], [6, 2]);
  assert.equal(input.variables.rows.length, 2);
});

// The whole point of one window: every shape of the same data adds up to the
// same total, however it is sliced.
test("every shape of the data reconciles to the same total, even past the top-N cut-offs", () => {
  const classes = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
  const agents = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  const timeRows: Row[] = [];
  const treeRows: Row[] = [];
  let expected = 0;
  classes.forEach((c, i) =>
    agents.forEach((a, j) => {
      for (const d of [0, 1, 3, 5]) {
        const v = 1 + ((i * 7 + j * 3 + d) % 9);
        timeRows.push(row(day(d), c, a, v));
        expected += v;
      }
    }),
  );
  // the tree query is the same window without a time bucket
  const byKey = new Map<string, number>();
  for (const r of timeRows) byKey.set(r.dims.tclass + "|" + r.dims.agent, (byKey.get(r.dims.tclass + "|" + r.dims.agent) ?? 0) + r.value);
  for (const [k, v] of byKey) {
    const [c, a] = k.split("|");
    treeRows.push({ t: null, dims: { tclass: c, agent: a }, value: v, weight: v });
  }
  const input = build({ days: 7, timeRows, treeRows });
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  assert.equal(input.kpi.value, expected);
  assert.equal(sum(input.categories.map((c) => c.value)), expected, "categories");
  assert.equal(sum(input.time.total), expected, "time series total");
  assert.equal(sum(input.time.series.map((s) => sum(s.values))), expected, "the series (with their 'other' tail) add up too");
  assert.equal(sum(input.matrix.weights.flat()), expected, "matrix, 10 classes x 8 agents cut to 8 x 5 plus 'other'");
  assert.equal(sum(input.hierarchy.map((n) => n.value)), expected, "hierarchy roots");
  for (const node of input.hierarchy) {
    if (node.children) assert.equal(sum(node.children.map((c) => c.value)), node.value, `children of ${node.name} add up to it`);
  }
  assert.ok(input.matrix.rows.includes("::other::") && input.matrix.cols.includes("::other::"), "the cut-off tail is visible as 'other'");
  assert.ok(input.matrix.rows.length <= 8 && input.matrix.cols.length <= 5);
  // the heatmap's matrix has more room (10 rows x 8 cols): with exactly 10
  // classes and 8 agents, nothing needs to be merged into "other"
  assert.equal(input.heat.rows.length, 10);
  assert.equal(input.heat.cols.length, 8);
  assert.ok(!input.heat.rows.includes("::other::") && !input.heat.cols.includes("::other::"));
  assert.equal(sum(input.heat.weights.flat()), expected, "heatmap matrix holds every event too");
});

test("buildChartInput: a group with no observation (weight 0) is left out, not drawn as a zero", () => {
  const rows = [row(day(0), "enforcing", "a1", 90, 3), row(day(0), "permissive", "a2", 0, 0)];
  const input = build({ def: def("fleet"), measure: scoreMeasure, days: 3, timeRows: rows });
  assert.deepEqual(input.categories.map((c) => c.name), ["enforcing"], "the zero-weight group never appears");
  assert.equal(input.samples.every((s) => s.name !== "permissive"), true);
});

test("buildChartInput: the hourly array only holds hours that actually have data", () => {
  const hourlyRows = [row(day(0), "x", "a1", 5), row(day(1), "x", "a1", 3)];
  const input = build({ hourlyRows });
  assert.equal(input.hourly.length, 2);
  assert.deepEqual(
    input.hourly.map((h) => h.value).sort((a, b) => a - b),
    [3, 5],
  );
});

test("formatDuration: short, readable, and never divides by zero", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(42), "42 s");
  assert.equal(formatDuration(90), "2 min");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDuration(3900), "1 h 5 min");
  assert.equal(formatDuration(NaN), "-");
  assert.equal(formatDuration(-5), "-");
});

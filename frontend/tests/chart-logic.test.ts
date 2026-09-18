// Does each chart draw the numbers it is supposed to? The builders are pure
// (data in, ECharts option out), so each one is called on realistic input and
// its output is checked against invariants of the chart type and against the
// source data, not just against "it did not throw".
import test from "node:test";
import assert from "node:assert/strict";
import * as classic from "../src/charts/builders/classic.ts";
import * as share from "../src/charts/builders/share.ts";
import * as stats from "../src/charts/builders/stats.ts";
import * as corr from "../src/charts/builders/corr.ts";
import { DAY, buildChartInput, correlationMatrix, movingAverage, windowFor } from "../src/charts/shape.ts";
import type { BuildCtx } from "../src/charts/builders/common.ts";
import type { ChartInput, DatasetDef, MeasureDef, Row } from "../src/charts/types.ts";

const tokens = {
  mode: "light", text: "#000", muted: "#666", grid: "#ddd", surface: "#fff", sunken: "#eee", accent: "#0b6a70", accentSoft: "#d8ecea",
  series: ["#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8"], seq: ["#a", "#b", "#c", "#d", "#e"], divLow: "#l", divMid: "#m", divHigh: "#h",
  good: "#g", bad: "#b", warn: "#w", font: "sans", mono: "mono",
} as const;
const ctxOf = (input: ChartInput, compact = false): BuildCtx => ({ input, tokens: tokens as never, t: (k) => k, locale: "en", compact });

const additive: MeasureDef = { id: "count", labelKey: "m", field: "count", additive: true, unit: "count", polarity: "lowerBetter" };
const averaged: MeasureDef = { id: "score", labelKey: "m", field: "score", additive: false, unit: "percent", polarity: "higherBetter" };
const dataset = (variableFrom: DatasetDef["variableFrom"]): DatasetDef => ({
  id: "denials", labelKey: "d", dims: ["tclass", "agent", "scontext"], defaultDim: "tclass", measures: [],
  variables: [{ id: "a", labelKey: "vA" }, { id: "b", labelKey: "vB" }, { id: "c", labelKey: "vC" }],
  variableGroup: ["agent"], variableFrom,
});

const now = Date.UTC(2026, 8, 18, 12) / 1000;
const days = 30;
const win = windowFor(days, now);
const dayAt = (n: number) => Math.floor(now / DAY) * DAY - n * DAY;

// A deterministic pseudo-random generator so a failure is reproducible.
function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function fixture(measure: MeasureDef): ChartInput {
  const r = rng(7);
  const classes = ["file", "dir", "tcp_socket", "lnk_file", "chr_file", "sock_file", "process", "capability", "udp_socket", "netlink"];
  const agents = ["web01", "web02", "db01", "db02", "app01", "app02", "mail01"];
  const timeRows: Row[] = [];
  const treeRows: Row[] = [];
  const varRows: Row[] = [];
  const treeAcc = new Map<string, number>();
  classes.forEach((c, ci) =>
    agents.forEach((a, ai) => {
      for (let d = 0; d < days * 2; d++) {
        if (r() > 0.55) continue;
        const v = measure.additive ? Math.round(1 + r() * r() * 40 * (ci < 3 ? 4 : 1)) : Math.round(50 + r() * 50);
        const w = measure.additive ? v : 1 + Math.floor(r() * 6);
        const t = dayAt(d);
        timeRows.push({ t, dims: { tclass: c, agent: a }, value: v, weight: w });
        if (d < days) {
          const k = c + "|" + a;
          treeAcc.set(k, (treeAcc.get(k) ?? 0) + w);
          treeRows.push({ t: null, dims: { tclass: c, agent: a, scontext: "dom_" + (ai % 3) }, value: v, weight: w });
        }
      }
    }),
  );
  agents.forEach((a, ai) => {
    for (let d = 0; d < days; d++) {
      // the third variable never changes: correlation with it is undefined
      varRows.push({ t: dayAt(d), dims: { agent: a }, value: 0, weight: 1, raw: { x: Math.round(r() * 100) + ai * 5, y: Math.round(r() * 30), z: 3 } });
    }
  });
  const hourlyRows: Row[] = [];
  for (let h = 0; h < days * 24; h++) {
    if (r() > 0.5) continue;
    const t = dayAt(0) - h * 3600;
    const v = measure.additive ? Math.round(1 + r() * 20) : Math.round(50 + r() * 50);
    const w = measure.additive ? v : 1 + Math.floor(r() * 4);
    hourlyRows.push({ t, dims: {}, value: v, weight: w });
  }
  return buildChartInput({
    def: dataset((rows) => [rows[0].raw!.x, rows[0].raw!.y, rows[0].raw!.z]), measure, dim: "tclass", dim2: "agent", dim3: "scontext",
    days, win, timeRows, treeRows, varRows, hourlyRows, nowSec: now, sinceSec: now - 400 * DAY, truncated: false,
  });
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const finite = (a: (number | null)[]) => a.filter((v): v is number => v !== null && !Number.isNaN(v));
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

for (const [name, measure] of [["a count", additive], ["an averaged score", averaged]] as const) {
  const input = fixture(measure);
  const c = ctxOf(input);
  const totalValue = sum(input.categories.map((x) => x.value));
  const totalWeight = sum(input.categories.map((x) => x.weight));
  const isAdditive = measure.additive;

  test(`[${name}] classic: bars and columns show the categories and the time buckets`, () => {
    const bar = classic.bar(c).series[0].data as number[];
    const cats = [...input.categories].sort((a, b) => b.value - a.value).slice(0, 12);
    assert.ok(bar.length <= 12);
    assert.deepEqual(bar.slice(0, cats.length - 1 + (input.categories.length > 12 ? 0 : 1)).slice(0, 5), cats.slice(0, 5).map((x) => x.value), "sorted, biggest first");
    if (isAdditive) near(sum(bar), totalValue, 1e-6); // top 12 plus the merged tail is everything
    const col = classic.column(c).series[0].data as (number | null)[];
    assert.equal(col.length, win.buckets, "a column per bucket of the window");
    if (isAdditive) near(sum(finite(col)), totalValue);
    const h = classic.barHorizontal(c).series[0].data as number[];
    assert.deepEqual(h, bar, "the horizontal bar shows the same values");
  });

  test(`[${name}] classic: grouped, stacked and 100% stacked bars`, () => {
    const m = input.matrix;
    const grouped = classic.groupedBar(c).series as { data: number[] }[];
    assert.equal(grouped.length, m.cols.length);
    grouped.forEach((s, j) => assert.deepEqual(s.data, m.rows.map((_, i) => m.values[i][j]), "grouped bars show the matrix cells"));
    const stacked = classic.stackedBar(c).series as { data: number[] }[];
    near(sum(stacked.flatMap((s) => s.data)), sum(m.weights.flat()), 1e-6);
    if (isAdditive) near(sum(m.weights.flat()), totalValue, 1e-6);
    const pct = classic.stacked100(c).series as { data: number[] }[];
    m.rows.forEach((_, i) => {
      const colSum = sum(pct.map((s) => s.data[i]));
      if (sum(m.weights[i]) > 0) near(colSum, 100, 1e-6);
    });
  });

  test(`[${name}] classic: heatmap cells match the (bigger) heat matrix, missing cells never look like zero`, () => {
    const { rows, cols, values, weights } = input.heat;
    const opt = classic.heatmap(c);
    const data = opt.series[0].data as [number, number, number | string][];
    assert.equal(data.length, rows.length * cols.length);
    for (const [j, i, v] of data) {
      const has = isAdditive || weights[i][j] > 0;
      assert.equal(v, has ? values[i][j] : "-", `cell ${rows[i]}/${cols[j]}`);
    }
    // the heatmap's own matrix has more room than the grouped/stacked bars'
    assert.ok(rows.length >= input.matrix.rows.length && cols.length >= input.matrix.cols.length);
  });

  test(`[${name}] classic: lines, areas, steps, combo`, () => {
    const total = input.time.total;
    for (const fn of [classic.line, classic.area, classic.step]) {
      const data = fn(c).series[0].data as (number | null)[];
      assert.equal(data.length, total.length);
      near(sum(finite(data)), sum(total.filter((v) => !Number.isNaN(v))));
    }
    const multi = classic.multiLine(c).series as { data: (number | null)[] }[];
    assert.equal(multi.length, input.time.series.length);
    if (isAdditive) {
      total.forEach((tot, i) => near(sum(multi.map((s) => s.data[i] ?? 0)), tot, 1e-6));
      // stacked areas only stack counts
      assert.ok((classic.stackedArea(c).series as { stack?: string }[]).every((s) => s.stack === "total"));
    } else {
      assert.ok((classic.stackedArea(c).series as { stack?: string }[]).every((s) => s.stack === undefined), "averages are never stacked into a sum");
    }
    const combo = classic.combo(c).series as { data: (number | null)[] }[];
    assert.deepEqual(combo[0].data, total.map((v) => (Number.isNaN(v) ? null : v)));
    const w = 7;
    assert.deepEqual(combo[1].data, movingAverage(total, w).map((v) => (Number.isNaN(v) ? null : v)), "the line is the 7-bucket moving average");
  });

  test(`[${name}] classic: the waterfall starts and ends on the real levels and its steps are the real changes`, () => {
    const opt = classic.waterfall(c);
    const [base, level, up, down] = (opt.series as { data: (number | null)[] }[]).map((s) => s.data);
    const levels = input.time.total.map((v) => (Number.isNaN(v) ? 0 : v));
    assert.equal(level[0], levels[0], "starts at the first level");
    assert.equal(level[level.length - 1], levels[levels.length - 1], "ends at the last level");
    for (let i = 1; i < levels.length; i++) {
      const delta = levels[i] - levels[i - 1];
      near((up[i] ?? 0) - (down[i] ?? 0), delta, 1e-9);
      near(base[i] as number, Math.min(levels[i], levels[i - 1]), 1e-9);
      assert.ok(!(up[i] !== null && down[i] !== null), "a step is a rise or a fall, never both");
    }
  });

  test(`[${name}] share: pies, donuts and semi-donuts are sized by weight and add up`, () => {
    const pie = share.pie(c).series[0].data as { value: number }[];
    near(sum(pie.map((d) => d.value)), totalWeight, 1e-6);
    near(sum((share.donut(c).series[0].data as { value: number }[]).map((d) => d.value)), totalWeight, 1e-6);
    const semi = share.semiDonut(c).series[0].data as { value: number; name: string }[];
    const hidden = semi[semi.length - 1];
    assert.equal(hidden.name, "");
    near(hidden.value, sum(semi.slice(0, -1).map((d) => d.value)), 1e-6, ); // the invisible half is worth the whole
  });

  test(`[${name}] share: treemap and sunburst reconcile at every level`, () => {
    for (const fn of [share.treemap, share.sunburst]) {
      const data = fn(c).series[0].data as { value: number; children?: { value: number; children?: { value: number }[] }[] }[];
      near(sum(data.map((n) => n.value)), sum(input.hierarchy.map((n) => n.value)));
      const check = (nodes: { value: number; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.children) {
            near(sum((n.children as { value: number }[]).map((x) => x.value)), n.value, 1e-6);
            check(n.children as { value: number; children?: unknown[] }[]);
          }
        }
      };
      check(data);
    }
    if (isAdditive) near(sum(input.hierarchy.map((n) => n.value)), totalWeight, 1e-6);
  });

  test(`[${name}] share: marimekko columns fill 100% and widths fill 100%`, () => {
    const series = share.marimekko(c).series as { data: number[][] }[];
    const cols = input.matrix.cols.length;
    for (let j = 0; j < cols; j++) {
      const parts = series.map((s) => s.data[j]);
      const tall = sum(parts.map((p) => p[3] - p[2]));
      if (parts.some((p) => p[5] > 0)) near(tall, 100, 1e-6);
    }
    const widths = series[0].data.map((p) => p[1] - p[0]);
    near(sum(widths), 100, 1e-6);
  });

  test(`[${name}] statistics: histogram, box plot, distributions`, () => {
    const pooled = sum(input.samples.map((s) => s.values.length));
    const hist = stats.histogram(c).series[0].data as number[];
    assert.equal(sum(hist), pooled, "every observation lands in exactly one bin");
    const box = stats.boxplot(c).series as { data: number[][] }[];
    for (const [min, q1, med, q3, max] of box[0].data) {
      assert.ok(min <= q1 && q1 <= med && med <= q3 && q3 <= max, `quartiles in order: ${[min, q1, med, q3, max]}`);
    }
    // outliers lie outside the whiskers
    const outliers = box[1].data as unknown as number[][];
    for (const [i, v] of outliers) assert.ok(v < box[0].data[i][0] || v > box[0].data[i][4]);
    const ecdf = stats.ecdfChart(c).series as { data: number[][] }[];
    for (const s of ecdf) {
      const ys = s.data.map((p) => p[1]);
      assert.equal(ys[ys.length - 1], 1, "an ECDF ends at 1");
      assert.ok(ys.every((y, i) => i === 0 || y >= ys[i - 1]), "and never goes down");
    }
    const qq = stats.qq(c).series as { data: number[][] }[];
    assert.equal(qq[1].data.length, pooled, "one QQ point per observation");
    const xs = qq[1].data.map((p) => p[0]);
    assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]));
    const dens = stats.density(c).series as { data: number[][] }[];
    for (const s of dens) {
      const area = s.data.slice(1).reduce((a, p, i) => a + p[1] * (p[0] - s.data[i][0]), 0);
      assert.ok(area > 0.85 && area < 1.05, `a density integrates to about 1 (got ${area.toFixed(3)}); mass below zero is cut for counts`);
    }
    const strip = stats.strip(c).series as { data: number[][] }[];
    const swarm = stats.beeswarmChart(c).series as { data: number[][] }[];
    assert.equal(sum(strip.map((s) => s.data.length)), pooled);
    assert.equal(sum(swarm.map((s) => s.data.length)), pooled);
    swarm.forEach((s, k) => assert.ok(s.data.every((p) => Math.abs(p[0] - k) <= 0.45), "beeswarm points stay in their own lane"));
  });

  test(`[${name}] statistics: dot plot and Pareto`, () => {
    const dot = stats.dotPlot(c).series as { data: number[][] }[];
    const cats = [...input.categories].sort((a, b) => b.value - a.value);
    assert.deepEqual(dot[1].data.slice(0, 5).map((p) => p[0]), cats.slice(0, 5).map((x) => x.value));
    const pareto = stats.pareto(c).series as { data: number[] }[];
    const bars = pareto[0].data;
    assert.ok(bars.every((v, i) => i === 0 || v <= bars[i - 1]), "Pareto bars are sorted, biggest first");
    const cum = pareto[1].data;
    assert.ok(cum.every((v, i) => i === 0 || v >= cum[i - 1]) && cum[cum.length - 1] <= 100.0000001, "the cumulative share only rises and never passes 100");
    if (input.categories.length <= 10) near(cum[cum.length - 1], 100, 1e-6);
  });

  test(`[${name}] statistics: the hour-of-day heatmap reconciles to the hourly total and buckets by real weekday/hour`, () => {
    const data = stats.hourHeatmap(c).series[0].data as [number, number, number | string][];
    assert.equal(data.length, 7 * 24, "always the full week x day grid, empty cells included");
    let total = 0;
    let totalWeight = 0;
    for (const [hour, wd, v] of data) {
      assert.ok(hour >= 0 && hour <= 23 && wd >= 0 && wd <= 6);
      if (v !== "-") {
        totalWeight++;
        total += isAdditive ? Number(v) : 0; // an average's cells cannot be summed meaningfully
      }
    }
    assert.ok(totalWeight > 0, "at least some hours have data");
    if (isAdditive) near(total, sum(input.hourly.map((h) => h.value)), 1e-6);
    // a Monday 09:00 UTC bucket lands on weekday 0, hour 9
    const monday9 = Math.floor(Date.UTC(2026, 8, 14, 9) / 1000); // 2026-09-14 is a Monday
    const solo = stats.hourHeatmap({ ...c, input: { ...c.input, hourly: [{ t: monday9, value: 7, weight: 7 }] } }).series[0].data as [number, number, number | string][];
    const [cell] = solo.filter(([, , v]) => v !== "-");
    assert.deepEqual(cell, [9, 0, 7]);
  });

  test(`[${name}] correlation: scatter, bubble and hexbin keep every point`, () => {
    const n = input.points.length;
    for (const fn of [stats.scatter, stats.bubble]) {
      assert.equal(sum((fn(c).series as { data: unknown[] }[]).map((s) => s.data.length)), n);
    }
    const hex = corr.hexbinChart(c).series[0].data as number[][];
    assert.equal(sum(hex.map((b) => b[2])), n, "every point is in exactly one hexagon");
  });

  test(`[${name}] correlation: the heatmap is symmetric and marks the constant variable as undefined, not 0`, () => {
    const data = corr.corrHeatmap(c).series[0].data as [number, number, number | string][];
    const at = (x: number, y: number) => data.find((d) => d[0] === x && d[1] === y)![2];
    assert.equal(data.length, 9);
    assert.equal(at(0, 0), 1);
    assert.equal(at(0, 1), at(1, 0), "r(a,b) equals r(b,a)");
    assert.ok(Math.abs(at(0, 1) as number) <= 1);
    assert.equal(at(2, 2), "-", "a variable that never changes has no correlation, even with itself");
    assert.equal(at(0, 2), "-");
    const m = correlationMatrix([0, 1, 2].map((j) => input.variables.rows.map((r) => r[j])));
    assert.ok(Number.isNaN(m[2][2]));
    // pair plot: n x n panels
    const pair = corr.pairPlot(c);
    assert.equal((pair.series as unknown[]).length, 9);
  });
}

test("charts with nothing to show are not built from empty input", () => {
  const empty = buildChartInput({ def: dataset(() => [0, 0, 0]), measure: additive, dim: "tclass", dim2: "agent", dim3: "scontext", days, win, timeRows: [], treeRows: [], varRows: [], nowSec: now, sinceSec: now - 400 * DAY, truncated: false });
  assert.equal(empty.empty, true);
  assert.equal(empty.categories.length, 0);
  assert.equal(empty.kpi.value, 0);
});

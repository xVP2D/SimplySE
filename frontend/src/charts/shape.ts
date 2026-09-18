// Pure data shaping and statistics for charts. No React, no ECharts and no
// DOM: everything here is a plain function of its arguments, which is what
// lets it be tested directly under Node (frontend/tests/charts.test.ts).
import type { Bucket, ChartInput, DatasetDef, MeasureDef, Row, TreeNode } from "./types.ts";
import { OTHER } from "./types.ts";

export const DAY = 86400;
const SEP = "|~|";

// ── time buckets ─────────────────────────────────────────────────────────

export function bucketStep(b: Bucket): number {
  return b === "hour" ? 3600 : b === "week" ? 7 * DAY : DAY;
}

// Same alignment as Postgres date_trunc in UTC: weeks start on Monday, and
// the Unix epoch (a Thursday) is 3 days past the Monday before it.
export function bucketStart(t: number, b: Bucket): number {
  if (b === "hour") return Math.floor(t / 3600) * 3600;
  if (b === "day") return Math.floor(t / DAY) * DAY;
  return Math.floor((t + 3 * DAY) / (7 * DAY)) * (7 * DAY) - 3 * DAY;
}

export function bucketRange(from: number, to: number, b: Bucket): number[] {
  const out: number[] = [];
  for (let t = bucketStart(from, b); t <= to; t += bucketStep(b)) out.push(t);
  return out;
}

// The time bucket for a period, and how many days to ask the server for: the
// period itself plus the one before it, so KPIs can show a change.
export function bucketFor(days: number): { bucket: Bucket; queryDays: number } {
  const bucket: Bucket = days <= 2 ? "hour" : days <= 120 ? "day" : "week";
  return { bucket, queryDays: Math.min(days * 2, 366) };
}

// ── aggregation ──────────────────────────────────────────────────────────

export function combine(rows: Row[], additive: boolean): { value: number; weight: number } {
  let weight = 0;
  let sum = 0;
  for (const r of rows) {
    weight += r.weight;
    sum += additive ? r.value : r.value * r.weight;
  }
  return { value: additive ? sum : weight > 0 ? sum / weight : 0, weight };
}

export function groupRows(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ── statistics ───────────────────────────────────────────────────────────

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

export interface BoxStats {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers: number[];
}

// Tukey box plot: whiskers reach the furthest value within 1.5 IQR of the
// quartiles; anything beyond is an outlier.
export function boxStats(values: number[]): BoxStats {
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const median = quantile(s, 0.5);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const lowFence = q1 - 1.5 * iqr;
  const highFence = q3 + 1.5 * iqr;
  const inside = s.filter((v) => v >= lowFence && v <= highFence);
  return {
    min: inside.length ? inside[0] : s[0],
    q1,
    median,
    q3,
    max: inside.length ? inside[inside.length - 1] : s[s.length - 1],
    outliers: s.filter((v) => v < lowFence || v > highFence),
  };
}

export function silverman(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const sd = stdev(s);
  const iqr = quantile(s, 0.75) - quantile(s, 0.25);
  const spread = Math.min(sd, iqr / 1.34) || sd;
  const range = s.length ? s[s.length - 1] - s[0] : 0;
  const bw = 1.06 * spread * Math.pow(Math.max(s.length, 1), -0.2);
  // Never degenerate: all-equal or tiny samples still get a visible curve.
  return bw > 0 ? bw : range > 0 ? range / 10 : 1;
}

export function kde(values: number[], grid: number[], bandwidth: number = silverman(values)): number[] {
  const n = values.length;
  const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
  return grid.map((g) => {
    let sum = 0;
    for (const v of values) sum += Math.exp(-0.5 * ((g - v) / bandwidth) ** 2);
    return sum * norm;
  });
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n < 2) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

export interface Bin {
  start: number;
  end: number;
  count: number;
}

export function histogramBins(values: number[], maxBins = 12): Bin[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [{ start: lo, end: lo + 1, count: values.length }];
  const integers = values.every((v) => Number.isInteger(v));
  let n = Math.min(maxBins, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  let width = (hi - lo) / n;
  if (integers) {
    width = Math.max(1, Math.ceil((hi - lo + 1) / n));
    n = Math.ceil((hi - lo + 1) / width);
  }
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({ start: lo + i * width, end: lo + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = Math.min(n - 1, Math.floor((v - lo) / width));
    bins[i].count++;
  }
  return bins;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function correlationMatrix(columns: number[][]): number[][] {
  return columns.map((a, i) => columns.map((b, j) => (i === j ? 1 : pearson(a, b))));
}

export function ecdf(values: number[]): [number, number][] {
  const s = [...values].sort((a, b) => a - b);
  return s.map((v, i) => [v, (i + 1) / s.length]);
}

// Acklam's rational approximation of the standard normal quantile function.
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Sample quantiles against the normal's, for a QQ plot.
export function qqPoints(values: number[]): { theory: number; sample: number }[] {
  const s = [...values].sort((a, b) => a - b);
  return s.map((v, i) => ({ theory: normalQuantile((i + 0.5) / s.length), sample: v }));
}

export function movingAverage(values: number[], window: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      if (!Number.isNaN(values[j])) {
        sum += values[j];
        n++;
      }
    }
    return n ? sum / n : NaN;
  });
}

// A deterministic jitter in [-amount, amount] so a strip plot does not move
// on every render.
export function jitter(i: number, amount = 0.3): number {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amount;
}

// Offsets (in category units) that keep points sharing a value bin from
// overlapping: the m points of a bin fan out symmetrically around the centre.
export function beeswarm(values: number[], binWidth: number, step = 0.1, limit = 0.42): number[] {
  const bins = new Map<number, number[]>();
  values.forEach((v, i) => {
    const k = Math.round(v / (binWidth || 1));
    const list = bins.get(k);
    if (list) list.push(i);
    else bins.set(k, [i]);
  });
  const out = new Array<number>(values.length).fill(0);
  for (const idx of bins.values()) {
    const m = idx.length;
    const s = Math.min(step, (2 * limit) / Math.max(m, 1));
    idx.forEach((i, k) => {
      out[i] = (k - (m - 1) / 2) * s;
    });
  }
  return out;
}

export function niceMax(x: number): number {
  if (!(x > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

export interface HexBin {
  cx: number; // centre, data space
  cy: number;
  count: number;
}

export interface HexGrid {
  bins: HexBin[];
  // vertex offsets of one hexagon in data space (identical for every bin)
  vertices: [number, number][];
  maxCount: number;
}

// Hexagonal binning. The plane is normalised to the unit square first, so the
// hexagons are regular in that space; a screen mapping with another aspect
// ratio stretches all of them equally, which keeps them tiling.
export function hexbin(points: { x: number; y: number }[], across = 12): HexGrid {
  if (points.length === 0) return { bins: [], vertices: [], maxCount: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xmin = Math.min(...xs);
  const ymin = Math.min(...ys);
  const xr = Math.max(...xs) - xmin || 1;
  const yr = Math.max(...ys) - ymin || 1;
  const s = 1 / (across * Math.sqrt(3)); // circumradius, pointy-top hexagons
  const cells = new Map<string, { q: number; r: number; count: number }>();
  for (const p of points) {
    const nx = (p.x - xmin) / xr;
    const ny = (p.y - ymin) / yr;
    const fq = ((Math.sqrt(3) / 3) * nx - ny / 3) / s;
    const fr = ((2 / 3) * ny) / s;
    // cube rounding
    const fx = fq;
    const fz = fr;
    const fy = -fx - fz;
    let rx = Math.round(fx);
    let ry = Math.round(fy);
    let rz = Math.round(fz);
    const dx = Math.abs(rx - fx);
    const dy = Math.abs(ry - fy);
    const dz = Math.abs(rz - fz);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    const key = rx + "," + rz;
    const cell = cells.get(key);
    if (cell) cell.count++;
    else cells.set(key, { q: rx, r: rz, count: 1 });
  }
  const bins: HexBin[] = [];
  let maxCount = 0;
  for (const c of cells.values()) {
    const nx = s * Math.sqrt(3) * (c.q + c.r / 2);
    const ny = s * 1.5 * c.r;
    bins.push({ cx: xmin + nx * xr, cy: ymin + ny * yr, count: c.count });
    maxCount = Math.max(maxCount, c.count);
  }
  const vertices: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k + 30);
    vertices.push([s * Math.cos(a) * xr, s * Math.sin(a) * yr]);
  }
  return { bins, vertices, maxCount };
}

// ── building the shared chart input ──────────────────────────────────────

export interface BuildArgs {
  def: DatasetDef;
  measure: MeasureDef;
  dim: string;
  dim2: string;
  dim3: string;
  days: number;
  bucket: Bucket;
  timeRows: Row[]; // bucketed, grouped by dim and dim2, over the period and the one before
  treeRows: Row[]; // no bucket, grouped by dim, dim2 and dim3, over the period
  varRows: Row[]; // bucketed by day, grouped by def.variableGroup
  nowSec: number;
  truncated: boolean;
  topSeries?: number;
}

const SAMPLE_CATEGORIES = 8;

function rankBy(groups: Map<string, Row[]>, additive: boolean) {
  return [...groups.entries()]
    .map(([name, rows]) => ({ name, rows, ...combine(rows, additive) }))
    .sort((a, b) => b.weight - a.weight || b.value - a.value || a.name.localeCompare(b.name));
}

export function buildChartInput(a: BuildArgs): ChartInput {
  const { def, measure, dim, dim2, dim3, days, bucket, nowSec } = a;
  const additive = measure.additive;
  const periodStart = bucketStart(nowSec - days * DAY, bucket);
  const current = a.timeRows.filter((r) => r.t !== null && r.t >= periodStart);
  const before = a.timeRows.filter((r) => r.t !== null && r.t < periodStart);
  const ts = bucketRange(periodStart, nowSec, bucket);
  const tsIndex = new Map(ts.map((t, i) => [t, i]));
  const gap = additive ? 0 : NaN;

  // categories over the whole period
  const byCat = rankBy(groupRows(current, (r) => r.dims[dim] ?? ""), additive);
  const categories = byCat
    .map((c) => ({ name: c.name, value: c.value, weight: c.weight }))
    .sort((x, y) => y.value - x.value || y.weight - x.weight);

  // time series: the biggest categories, the tail merged into one series
  const keep = a.topSeries ?? 5;
  const head = byCat.slice(0, keep);
  const tail = byCat.slice(keep);
  const seriesRows: { name: string; rows: Row[] }[] = head.map((c) => ({ name: c.name, rows: c.rows }));
  if (tail.length) seriesRows.push({ name: OTHER, rows: tail.flatMap((c) => c.rows) });
  const perBucket = (rows: Row[]): number[] => {
    const cells: Row[][] = ts.map(() => []);
    for (const r of rows) {
      const i = tsIndex.get(bucketStart(r.t as number, bucket));
      if (i !== undefined) cells[i].push(r);
    }
    return cells.map((c) => (c.length ? combine(c, additive).value : gap));
  };
  const series = seriesRows.map((s) => ({ name: s.name, values: perBucket(s.rows) }));
  const total = perBucket(current);

  // matrix: dim (rows) by dim2 (columns)
  const rowCats = byCat.slice(0, 8).map((c) => c.name);
  const colRank = rankBy(groupRows(current, (r) => r.dims[dim2] ?? ""), additive).slice(0, 5);
  const cols = colRank.map((c) => c.name);
  const values = rowCats.map(() => cols.map(() => 0));
  const weights = rowCats.map(() => cols.map(() => 0));
  const cellGroups = groupRows(current, (r) => (r.dims[dim] ?? "") + SEP + (r.dims[dim2] ?? ""));
  rowCats.forEach((rc, i) =>
    cols.forEach((cc, j) => {
      const rows = cellGroups.get(rc + SEP + cc);
      if (rows) {
        const c = combine(rows, additive);
        values[i][j] = c.value;
        weights[i][j] = c.weight;
      }
    }),
  );

  // hierarchy over dim > dim2 > dim3, sized by weight
  const tree = (rows: Row[], keys: string[], depth: number, limit: number[]): TreeNode[] => {
    if (depth >= keys.length) return [];
    const ranked = rankBy(groupRows(rows, (r) => r.dims[keys[depth]] ?? ""), additive).slice(0, limit[depth]);
    return ranked.map((g) => {
      const children = tree(g.rows, keys, depth + 1, limit);
      return children.length ? { name: g.name, value: g.weight, children } : { name: g.name, value: g.weight };
    });
  };
  const hierarchy = tree(a.treeRows, [dim, dim2, dim3], 0, [8, 6, 5]);

  // samples: each top category's value per bucket
  const samples = series
    .filter((s) => s.name !== OTHER)
    .slice(0, SAMPLE_CATEGORIES)
    .map((s) => ({ name: s.name, values: s.values.filter((v) => !Number.isNaN(v)) }));
  // categories beyond the time-series head still deserve a distribution
  for (const c of byCat.slice(keep, SAMPLE_CATEGORIES)) {
    samples.push({ name: c.name, values: perBucket(c.rows).filter((v) => !Number.isNaN(v)) });
  }

  // variables per (agent, day) for the statistical and correlation charts
  const byAgentDay = groupRows(a.varRows, (r) => (r.dims.agent ?? "") + SEP + (r.t ?? 0));
  const points: ChartInput["points"] = [];
  const varRowsOut: number[][] = [];
  for (const [key, rows] of byAgentDay) {
    const [agent, t] = key.split(SEP);
    const v = def.variableFrom(rows);
    varRowsOut.push(v);
    points.push({ group: agent, t: Number(t), x: v[0] ?? 0, y: v[1] ?? 0, size: v[2] ?? 0 });
  }

  // KPI
  const cur = combine(current, additive);
  const previous = before.length ? combine(before, additive).value : null;
  let last = 0;
  // carry the last value across gaps so the mini curve stays continuous
  const spark = total.map((v) => {
    if (!Number.isNaN(v)) last = v;
    return last;
  });
  const finite = total.filter((v) => !Number.isNaN(v));
  const previousByCategory: Record<string, number> = {};
  for (const [name, rows] of groupRows(before, (r) => r.dims[dim] ?? "")) {
    previousByCategory[name] = combine(rows, additive).value;
  }

  return {
    meta: {
      dataset: def.id,
      measure,
      dim,
      dim2,
      dim3,
      days,
      bucket,
      variableNames: def.variables.map((v) => v.labelKey),
      truncated: a.truncated,
    },
    empty: current.length === 0,
    categories,
    time: { ts, series, total },
    matrix: { rows: rowCats, cols, values, weights },
    hierarchy,
    samples,
    points,
    variables: { names: def.variables.map((v) => v.labelKey), rows: varRowsOut },
    kpi: {
      value: cur.value,
      previous,
      target: previous ?? cur.value,
      spark,
      min: finite.length ? Math.min(...finite) : 0,
      max: finite.length ? Math.max(...finite) : 0,
      mean: finite.length ? mean(finite) : 0,
      buckets: ts.length,
      previousByCategory,
    },
  };
}

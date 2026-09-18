import { OTHER } from "../types.ts";
import { beeswarm, boxStats, ecdf, histogramBins, jitter, kde, linspace, normalQuantile, qqPoints, quantile, silverman } from "../shape.ts";
import {
  base,
  catAxis,
  fmt,
  fullDateLabel,
  grid,
  itemTooltip,
  label,
  legend,
  plain,
  seriesColor,
  short,
  topCategories,
  valAxis,
  variableName,
  type BuildCtx,
  type Opt,
} from "./common.ts";

function colorOf(ctx: BuildCtx, name: string, i: number): string {
  return name === OTHER ? ctx.tokens.muted : seriesColor(ctx, i);
}

function usable(ctx: BuildCtx, min: number, max = 8) {
  return ctx.input.samples.filter((s) => s.values.length >= min).slice(0, max);
}

function perBucket(ctx: BuildCtx): string {
  return ctx.t("charts.perBucket." + ctx.input.meta.bucket);
}

function pooled(ctx: BuildCtx): number[] {
  return ctx.input.samples.flatMap((s) => s.values);
}

// 30. Histogram: how the per-bucket values are distributed.
export function histogram(ctx: BuildCtx): Opt {
  const bins = histogramBins(pooled(ctx), 12);
  const single = bins.length > 0 && bins.every((b) => Number.isInteger(b.start) && b.end - b.start === 1);
  const names = bins.map((b) => (single ? String(b.start) : `${plain(ctx, b.start, 1)}-${plain(ctx, b.end, 1)}`));
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: 18 }),
    tooltip: {
      ...itemTooltip(ctx, (p: Opt) => `${p.name}<br/>${plain(ctx, Number(p.value), 0)} ${ctx.t("charts.observations")}`),
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: ctx.tokens.grid, opacity: 0.35 } },
      formatter: (params: Opt[]) => `${params[0].name} (${perBucket(ctx)})<br/><b>${plain(ctx, Number(params[0].value), 0)}</b> ${ctx.t("charts.observations")}`,
    },
    xAxis: catAxis(ctx, names, { name: ctx.compact ? undefined : perBucket(ctx), nameLocation: "middle", nameGap: 28, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, axisLabel: { interval: 0, rotate: names.length > 8 ? 30 : 0 } }),
    yAxis: valAxis(ctx, { minInterval: 1 }),
    series: [{ type: "bar", data: bins.map((b) => b.count), barCategoryGap: "6%", itemStyle: { color: ctx.tokens.accent, borderRadius: [3, 3, 0, 0] } }],
  };
}

// 31. Box plot: median, quartiles, whiskers and outliers per category.
export function boxplot(ctx: BuildCtx): Opt {
  const groups = usable(ctx, 3);
  const stats = groups.map((g) => boxStats(g.values));
  const outliers = stats.flatMap((s, i) => s.outliers.map((v) => [i, v]));
  const names = groups.map((g) => label(ctx, g.name));
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: names.length > 5 ? 18 : 6 }),
    tooltip: {
      ...itemTooltip(ctx, (p: Opt) => {
        if (p.seriesType !== "boxplot") return `${p.marker} ${names[p.value[0]]}: <b>${fmt(ctx, Number(p.value[1]))}</b>`;
        const [, min, q1, med, q3, max] = p.value as number[];
        return `${p.name}<br/>${ctx.t("charts.stats.max")}: ${fmt(ctx, max)}<br/>${ctx.t("charts.stats.q3")}: ${fmt(ctx, q3)}<br/>${ctx.t("charts.stats.median")}: <b>${fmt(ctx, med)}</b><br/>${ctx.t("charts.stats.q1")}: ${fmt(ctx, q1)}<br/>${ctx.t("charts.stats.min")}: ${fmt(ctx, min)}`;
      }),
    },
    xAxis: catAxis(ctx, names, { axisLabel: { interval: 0, rotate: names.length > 5 ? 30 : 0, width: 78, overflow: "truncate" } }),
    yAxis: valAxis(ctx),
    series: [
      {
        type: "boxplot",
        data: stats.map((s) => [s.min, s.q1, s.median, s.q3, s.max]),
        boxWidth: ["30%", "56%"],
        itemStyle: { color: ctx.tokens.accentSoft, borderColor: ctx.tokens.accent, borderWidth: 1.6 },
        emphasis: { itemStyle: { borderWidth: 2.4 } },
      },
      { type: "scatter", name: ctx.t("charts.stats.outliers"), data: outliers, symbolSize: 7, itemStyle: { color: ctx.tokens.accent, opacity: 0.8 } },
    ],
  };
}

// 32. Violin plot: the box plot's information plus the density's shape.
export function violin(ctx: BuildCtx): Opt {
  const groups = usable(ctx, 3);
  const all = groups.flatMap((g) => g.values);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || 1;
  const gridY = linspace(lo - pad, hi + pad, 56);
  const shapes = groups.map((g) => {
    const d = kde(g.values, gridY, silverman(g.values));
    const dmax = Math.max(...d) || 1;
    const sorted = [...g.values].sort((a, b) => a - b);
    return { d: d.map((v) => v / dmax), median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) };
  });
  const names = groups.map((g) => label(ctx, g.name));
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: names.length > 5 ? 18 : 6 }),
    tooltip: itemTooltip(ctx, (p: Opt) => {
      const s = shapes[p.dataIndex];
      return `${names[p.dataIndex]}<br/>${ctx.t("charts.stats.median")}: <b>${fmt(ctx, s.median)}</b><br/>${ctx.t("charts.stats.q1")}: ${fmt(ctx, s.q1)}<br/>${ctx.t("charts.stats.q3")}: ${fmt(ctx, s.q3)}`;
    }),
    xAxis: catAxis(ctx, names, { axisLabel: { interval: 0, rotate: names.length > 5 ? 30 : 0, width: 78, overflow: "truncate" } }),
    yAxis: valAxis(ctx, { min: lo >= 0 ? 0 : Math.floor(lo - pad), max: Math.ceil(hi + pad) }),
    series: [
      {
        type: "custom",
        data: groups.map((_, k) => [k]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderItem: (params: any, api: any) => {
          const k = params.dataIndex as number;
          const s = shapes[k];
          const half = api.size([1, 0])[0] * 0.42;
          const right: number[][] = [];
          const left: number[][] = [];
          gridY.forEach((y, idx) => {
            const p = api.coord([k, y]);
            right.push([p[0] + half * s.d[idx], p[1]]);
            left.push([p[0] - half * s.d[idx], p[1]]);
          });
          const color = seriesColor(ctx, k);
          const mid = api.coord([k, s.median]);
          const a = api.coord([k, s.q1]);
          const b = api.coord([k, s.q3]);
          return {
            type: "group",
            children: [
              { type: "polygon", shape: { points: [...right, ...left.reverse()] }, style: { fill: color, opacity: 0.55, stroke: color, lineWidth: 1.2 } },
              { type: "line", shape: { x1: mid[0], y1: a[1], x2: mid[0], y2: b[1] }, style: { stroke: ctx.tokens.text, lineWidth: 3, opacity: 0.85 } },
              { type: "circle", shape: { cx: mid[0], cy: mid[1], r: 3.5 }, style: { fill: ctx.tokens.surface, stroke: ctx.tokens.text, lineWidth: 1.5 } },
            ],
          };
        },
      },
    ],
  };
}

interface Group {
  name: string;
  points: { x: number; y: number; size: number; t: number; agent: string }[];
}

function pointGroups(ctx: BuildCtx): Group[] {
  const byAgent = new Map<string, Group["points"]>();
  for (const p of ctx.input.points) {
    const list = byAgent.get(p.group) ?? [];
    list.push({ x: p.x, y: p.y, size: p.size, t: p.t, agent: p.group });
    byAgent.set(p.group, list);
  }
  const ranked = [...byAgent.entries()].sort((a, b) => b[1].length - a[1].length);
  const head = ranked.slice(0, 7).map(([name, points]) => ({ name, points }));
  const tail = ranked.slice(7);
  if (tail.length) head.push({ name: OTHER, points: tail.flatMap(([, p]) => p) });
  return head;
}

function scatterLike(ctx: BuildCtx, bubble: boolean): Opt {
  const groups = pointGroups(ctx);
  const maxSize = Math.max(1, ...ctx.input.points.map((p) => p.size));
  const xName = variableName(ctx, 0);
  const yName = variableName(ctx, 1);
  const sName = variableName(ctx, 2);
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: groups.length > 1, bottom: ctx.compact ? 6 : 16 }),
    legend: groups.length > 1 ? legend(ctx, groups.map((g) => label(ctx, g.name))) : undefined,
    tooltip: itemTooltip(ctx, (p: Opt) => {
      const [x, y, s, t, agent] = p.value as [number, number, number, number, string];
      return `${p.marker} ${agent} - ${fullDateLabel({ ...ctx, input: { ...ctx.input, meta: { ...ctx.input.meta, bucket: "day" } } }, t)}<br/>${xName}: <b>${plain(ctx, x)}</b><br/>${yName}: <b>${plain(ctx, y)}</b>${bubble ? `<br/>${sName}: <b>${plain(ctx, s)}</b>` : ""}`;
    }),
    xAxis: valAxis(ctx, { scale: true, name: ctx.compact ? undefined : xName, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, splitLine: { show: false } }),
    yAxis: valAxis(ctx, { scale: true, name: ctx.compact ? undefined : yName, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11, align: "left" } }),
    series: groups.map((g, i) => ({
      type: "scatter",
      name: label(ctx, g.name),
      data: g.points.map((p) => [p.x, p.y, p.size, p.t, p.agent]),
      symbolSize: bubble ? (v: number[]) => 6 + Math.sqrt(Math.max(v[2], 0) / maxSize) * 20 : 8,
      itemStyle: { color: colorOf(ctx, g.name, i), opacity: bubble ? 0.6 : 0.78, borderColor: ctx.tokens.surface, borderWidth: 1 },
    })),
  };
}

// 33. Scatter plot.
export const scatter = (ctx: BuildCtx): Opt => scatterLike(ctx, false);

// 34. Bubble chart: the scatter with a third variable as the bubble size.
export const bubble = (ctx: BuildCtx): Opt => scatterLike(ctx, true);

// 35. Density plot: smoothed distributions overlaid.
export function density(ctx: BuildCtx): Opt {
  let groups = usable(ctx, 3, 4);
  if (groups.length === 0) {
    const all = pooled(ctx);
    groups = all.length >= 3 ? [{ name: ctx.t("charts.all"), values: all }] : [];
  }
  const all = groups.flatMap((g) => g.values);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const bw = Math.max(...groups.map((g) => silverman(g.values)));
  const gridX = linspace(lo >= 0 ? Math.max(0, lo - 2.5 * bw) : lo - 2.5 * bw, hi + 2.5 * bw, 90);
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: groups.length > 1, bottom: 16 }),
    legend: groups.length > 1 ? legend(ctx, groups.map((g) => label(ctx, g.name))) : undefined,
    tooltip: { ...base(ctx).tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: ctx.tokens.grid } }, valueFormatter: (v: number) => plain(ctx, Number(v), 3) },
    xAxis: valAxis(ctx, { min: gridX[0], max: gridX[gridX.length - 1], name: ctx.compact ? undefined : perBucket(ctx), nameLocation: "middle", nameGap: 26, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, splitLine: { show: false } }),
    yAxis: valAxis(ctx, { axisLabel: { show: false } }),
    series: groups.map((g, i) => ({
      type: "line",
      name: label(ctx, g.name),
      showSymbol: false,
      smooth: true,
      data: kde(g.values, gridX, silverman(g.values)).map((d, k) => [gridX[k], d]),
      lineStyle: { width: 2, color: seriesColor(ctx, i) },
      itemStyle: { color: seriesColor(ctx, i) },
      areaStyle: { color: seriesColor(ctx, i), opacity: 0.14 },
    })),
  };
}

// 36. Dot plot: one dot per category on a shared axis.
export function dotPlot(ctx: BuildCtx): Opt {
  const cats = topCategories(ctx, 12);
  const names = cats.map((c) => label(ctx, c.name));
  return {
    ...base(ctx),
    grid: grid(ctx, { right: 44 }),
    tooltip: itemTooltip(ctx, (p: Opt) => `${p.marker} ${p.name}: <b>${fmt(ctx, Number(p.value))}</b>`),
    yAxis: catAxis(ctx, names, { inverse: true, axisLabel: { width: 96, overflow: "truncate", interval: 0 }, splitLine: { show: true, lineStyle: { color: ctx.tokens.grid, type: "dotted" } }, axisLine: { show: false } }),
    xAxis: valAxis(ctx, { scale: false }),
    series: [
      { type: "bar", data: cats.map((c) => c.value), barWidth: 2, itemStyle: { color: ctx.tokens.grid }, silent: true, z: 1, tooltip: { show: false } },
      {
        type: "scatter",
        data: cats.map((c, i) => [c.value, i]),
        symbolSize: 12,
        z: 3,
        itemStyle: { color: ctx.tokens.accent, borderColor: ctx.tokens.surface, borderWidth: 2 },
        label: ctx.compact ? undefined : { show: true, position: "right", color: ctx.tokens.text, fontSize: 11, formatter: (p: Opt) => fmt(ctx, Number(p.value[0])) },
        tooltip: { formatter: (p: Opt) => `${p.marker} ${names[p.value[1]]}: <b>${fmt(ctx, Number(p.value[0]))}</b>` },
      },
    ],
  };
}

function pointsPerCategory(ctx: BuildCtx, swarm: boolean): Opt {
  const groups = usable(ctx, 1);
  const names = groups.map((g) => label(ctx, g.name));
  const all = groups.flatMap((g) => g.values);
  const range = Math.max(...all) - Math.min(...all) || 1;
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: names.length > 5 ? 18 : 6 }),
    tooltip: itemTooltip(ctx, (p: Opt) => `${p.marker} ${names[Math.round(p.value[0])]}: <b>${fmt(ctx, Number(p.value[1]))}</b>`),
    xAxis: {
      type: "value",
      min: -0.6,
      max: names.length - 0.4,
      interval: 1,
      splitLine: { show: false },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: ctx.tokens.grid } },
      axisLabel: { color: ctx.tokens.muted, fontSize: 11, hideOverlap: true, width: 78, overflow: "truncate", formatter: (v: number) => (Number.isInteger(v) && v >= 0 && v < names.length ? names[v] : "") },
    },
    yAxis: valAxis(ctx),
    series: groups.map((g, i) => {
      const offsets = swarm ? beeswarm(g.values, range / 26) : g.values.map((_, k) => jitter(k + i * 131));
      return {
        type: "scatter",
        name: label(ctx, g.name),
        data: g.values.map((v, k) => [i + offsets[k], v]),
        symbolSize: 7,
        itemStyle: { color: seriesColor(ctx, i), opacity: 0.75, borderColor: ctx.tokens.surface, borderWidth: 0.8 },
      };
    }),
  };
}

// 37. Strip plot: every value, jittered sideways so they stay visible.
export const strip = (ctx: BuildCtx): Opt => pointsPerCategory(ctx, false);

// 38. Beeswarm: every value, spread just enough not to overlap.
export const beeswarmChart = (ctx: BuildCtx): Opt => pointsPerCategory(ctx, true);

// 39. ECDF: the share of observations at or below each value.
export function ecdfChart(ctx: BuildCtx): Opt {
  const groups = usable(ctx, 2, 5);
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: groups.length > 1, bottom: 16 }),
    legend: groups.length > 1 ? legend(ctx, groups.map((g) => label(ctx, g.name))) : undefined,
    tooltip: {
      ...base(ctx).tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: ctx.tokens.grid } },
      formatter: (params: Opt[]) => `${plain(ctx, Number(params[0].value[0]), 1)}<br/>${params.map((p) => `${p.marker} ${p.seriesName}: <b>${plain(ctx, Number(p.value[1]) * 100, 0)} %</b>`).join("<br/>")}`,
    },
    xAxis: valAxis(ctx, { min: groups.every((g) => Math.min(...g.values) >= 0) ? 0 : undefined, name: ctx.compact ? undefined : perBucket(ctx), nameLocation: "middle", nameGap: 26, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, splitLine: { show: false } }),
    yAxis: valAxis(ctx, { min: 0, max: 1, axisLabel: { formatter: (v: number) => Math.round(v * 100) + "%" } }),
    series: groups.map((g, i) => ({
      type: "line",
      name: label(ctx, g.name),
      step: "end",
      showSymbol: false,
      data: [[Math.min(...g.values) - 0.0001, 0], ...ecdf(g.values)],
      lineStyle: { width: 2, color: seriesColor(ctx, i) },
      itemStyle: { color: seriesColor(ctx, i) },
    })),
  };
}

// 40. Pareto chart: bars sorted by size and the cumulative share as a line.
// The two scales are the chart's definition (a share of 100 % on the right).
export function pareto(ctx: BuildCtx): Opt {
  const cats = [...ctx.input.categories].sort((a, b) => b.weight - a.weight).slice(0, 10);
  const total = cats.reduce((s, c) => s + c.weight, 0) || 1;
  let acc = 0;
  const cumulative = cats.map((c) => {
    acc += c.weight;
    return (acc / total) * 100;
  });
  const barName = ctx.input.meta.measure.additive ? ctx.t(ctx.input.meta.measure.labelKey) : ctx.t("charts.samples");
  const cumName = ctx.t("charts.cumulative");
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: true, bottom: cats.length > 5 ? 18 : 6, right: 36 }),
    legend: legend(ctx, [barName, cumName]),
    tooltip: { ...base(ctx).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: ctx.tokens.grid, opacity: 0.35 } } },
    xAxis: catAxis(ctx, cats.map((c) => label(ctx, c.name)), { axisLabel: { interval: 0, rotate: cats.length > 5 ? 30 : 0, width: 78, overflow: "truncate" } }),
    yAxis: [
      valAxis(ctx),
      valAxis(ctx, { min: 0, max: 100, splitLine: { show: false }, axisLabel: { formatter: (v: number) => v + "%" } }),
    ],
    series: [
      { type: "bar", name: barName, data: cats.map((c) => c.weight), barMaxWidth: 34, itemStyle: { color: ctx.tokens.accent, borderRadius: [4, 4, 0, 0] } },
      {
        type: "line",
        name: cumName,
        yAxisIndex: 1,
        data: cumulative,
        symbolSize: 6,
        lineStyle: { width: 2, color: ctx.tokens.series[1] },
        itemStyle: { color: ctx.tokens.series[1] },
        tooltip: { valueFormatter: (v: number) => plain(ctx, Number(v), 0) + " %" },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: ctx.tokens.muted, type: "dashed" }, data: [{ yAxis: 80 }] },
      },
    ],
  };
}

// 41. QQ plot: observed quantiles against a normal distribution's.
export function qq(ctx: BuildCtx): Opt {
  const values = pooled(ctx);
  const pts = qqPoints(values);
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const z1 = normalQuantile(0.25);
  const z3 = normalQuantile(0.75);
  const slope = z3 !== z1 ? (q3 - q1) / (z3 - z1) : 0;
  const intercept = q1 - slope * z1;
  const zLo = pts.length ? pts[0].theory : -2;
  const zHi = pts.length ? pts[pts.length - 1].theory : 2;
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: 16 }),
    tooltip: itemTooltip(ctx, (p: Opt) => `${ctx.t("charts.qqTheory")}: ${plain(ctx, Number(p.value[0]))}<br/>${ctx.t("charts.qqObserved")}: <b>${plain(ctx, Number(p.value[1]))}</b>`),
    xAxis: valAxis(ctx, { scale: true, name: ctx.compact ? undefined : ctx.t("charts.qqTheory"), nameLocation: "middle", nameGap: 26, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, splitLine: { show: false } }),
    yAxis: valAxis(ctx, { scale: true }),
    series: [
      { type: "line", data: [[zLo, intercept + slope * zLo], [zHi, intercept + slope * zHi]], showSymbol: false, silent: true, lineStyle: { color: ctx.tokens.muted, width: 1.5, type: "dashed" }, tooltip: { show: false } },
      { type: "scatter", data: pts.map((p) => [p.theory, p.sample]), symbolSize: 7, itemStyle: { color: ctx.tokens.accent, opacity: 0.8, borderColor: ctx.tokens.surface, borderWidth: 0.8 } },
    ],
  };
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Reshapes the flat per-hour history into a 7 (weekday) x 24 (hour) grid —
// this is the one place an absolute timestamp is split into a pattern, so it
// lives in the builder rather than in the shared shaping code.
function weekdayHourGrid(ctx: BuildCtx): { value: number[][]; weight: number[][]; max: number } {
  const additive = ctx.input.meta.measure.additive;
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const weight = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const h of ctx.input.hourly) {
    const d = new Date(h.t * 1000);
    const wd = (d.getUTCDay() + 6) % 7; // getUTCDay is Sun=0; shift to Mon=0
    const hour = d.getUTCHours();
    sum[wd][hour] += additive ? h.value : h.value * h.weight;
    weight[wd][hour] += h.weight;
  }
  let max = 0;
  const value = sum.map((row, i) =>
    row.map((s, j) => {
      const v = additive ? s : weight[i][j] > 0 ? s / weight[i][j] : NaN;
      if (!Number.isNaN(v)) max = Math.max(max, v);
      return v;
    }),
  );
  return { value, weight, max };
}

// 42. Hour-of-day heatmap: when across the week this measure happens most —
// a pattern a plain time series cannot show.
export function hourHeatmap(ctx: BuildCtx): Opt {
  const { value, weight, max } = weekdayHourGrid(ctx);
  const days = WEEKDAYS.map((k) => ctx.t("charts.weekday." + k));
  const data: (number | string)[][] = [];
  value.forEach((row, i) => row.forEach((v, j) => data.push([j, i, weight[i][j] > 0 ? Math.round(v * 100) / 100 : "-"])));
  return {
    ...base(ctx),
    grid: { left: 8, right: ctx.compact ? 10 : 60, top: 8, bottom: 26, containLabel: true },
    tooltip: itemTooltip(ctx, (p: Opt) => `${days[p.value[1]]} ${String(p.value[0]).padStart(2, "0")}h<br/><b>${p.value[2] === "-" ? "-" : fmt(ctx, Number(p.value[2]))}</b>`),
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, h) => String(h)),
      splitArea: { show: false },
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: ctx.tokens.muted, fontSize: 10, interval: (i: number) => i % 3 === 0, formatter: (v: string) => v + "h" },
    },
    yAxis: {
      type: "category",
      data: days,
      inverse: true,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: ctx.tokens.muted, fontSize: 11 },
    },
    visualMap: {
      min: 0,
      max: max || 1,
      calculable: false,
      orient: "vertical",
      right: 0,
      top: "middle",
      itemWidth: 12,
      itemHeight: 110,
      show: !ctx.compact,
      text: [fmt(ctx, max), "0"],
      textStyle: { color: ctx.tokens.muted, fontSize: 11 },
      inRange: { color: ctx.tokens.seq },
    },
    series: [
      {
        type: "heatmap",
        data,
        itemStyle: { borderColor: ctx.tokens.surface, borderWidth: 2, borderRadius: 2 },
        label: { show: false },
        emphasis: { itemStyle: { borderColor: ctx.tokens.text, borderWidth: 1 } },
      },
    ],
  };
}

export { short };

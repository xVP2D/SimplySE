import { OTHER } from "../types.ts";
import { movingAverage } from "../shape.ts";
import {
  axisTooltip,
  base,
  catAxis,
  dateLabel,
  fmt,
  fullDateLabel,
  grid,
  label,
  legend,
  nn,
  plain,
  seriesColor,
  timeLabels,
  toneColors,
  topCategories,
  valAxis,
  type BuildCtx,
  type Opt,
} from "./common.ts";

// The merged tail of a long list is grey, never a hue: it must not consume a
// slot of the categorical palette.
function colorOf(ctx: BuildCtx, name: string, i: number): string {
  return name === OTHER ? ctx.tokens.muted : seriesColor(ctx, i);
}

// Part-to-whole charts stack sample counts / event counts, never averages.
function partFmt(ctx: BuildCtx, n: number): string {
  return ctx.input.meta.measure.additive ? fmt(ctx, n) : plain(ctx, n, 0);
}

const barLabels = (ctx: BuildCtx, n: number): Opt | undefined =>
  ctx.compact || n > 8
    ? undefined
    : { show: true, position: "top", color: ctx.tokens.text, fontSize: 11, formatter: (p: Opt) => fmt(ctx, Number(p.value)) };

// 1. Bar chart: one bar per category, biggest first.
export function bar(ctx: BuildCtx): Opt {
  const cats = topCategories(ctx, 12);
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: cats.length > 6 ? 18 : 6 }),
    tooltip: { ...axisTooltip(ctx), axisPointer: { type: "shadow", shadowStyle: { color: ctx.tokens.grid, opacity: 0.35 } } },
    xAxis: catAxis(ctx, cats.map((c) => label(ctx, c.name)), { axisLabel: { interval: 0, rotate: cats.length > 6 ? 30 : 0, width: 78, overflow: "truncate" } }),
    yAxis: valAxis(ctx),
    series: [
      {
        type: "bar",
        name: ctx.t(ctx.input.meta.measure.labelKey),
        data: cats.map((c) => c.value),
        barMaxWidth: 34,
        itemStyle: { color: ctx.tokens.accent, borderRadius: [4, 4, 0, 0] },
        label: barLabels(ctx, cats.length),
      },
    ],
  };
}

// 2. Column chart: one column per time bucket.
export function column(ctx: BuildCtx): Opt {
  const { ts, total } = ctx.input.time;
  return {
    ...base(ctx),
    grid: grid(ctx),
    tooltip: axisTooltip(ctx, (i) => fullDateLabel(ctx, ts[i])),
    xAxis: catAxis(ctx, timeLabels(ctx)),
    yAxis: valAxis(ctx),
    series: [
      {
        type: "bar",
        name: ctx.t(ctx.input.meta.measure.labelKey),
        data: total.map(nn),
        barMaxWidth: 22,
        itemStyle: { color: ctx.tokens.accent, borderRadius: [3, 3, 0, 0] },
      },
    ],
  };
}

// 3. Horizontal bar chart.
export function barHorizontal(ctx: BuildCtx): Opt {
  const cats = topCategories(ctx, 12);
  return {
    ...base(ctx),
    grid: grid(ctx, { right: 40 }),
    tooltip: { ...axisTooltip(ctx), axisPointer: { type: "shadow", shadowStyle: { color: ctx.tokens.grid, opacity: 0.35 } } },
    yAxis: catAxis(ctx, cats.map((c) => label(ctx, c.name)), { inverse: true, axisLabel: { width: 96, overflow: "truncate" } }),
    xAxis: valAxis(ctx),
    series: [
      {
        type: "bar",
        name: ctx.t(ctx.input.meta.measure.labelKey),
        data: cats.map((c) => c.value),
        barMaxWidth: 22,
        itemStyle: { color: ctx.tokens.accent, borderRadius: [0, 4, 4, 0] },
        label: ctx.compact
          ? undefined
          : { show: true, position: "right", color: ctx.tokens.text, fontSize: 11, formatter: (p: Opt) => fmt(ctx, Number(p.value)) },
      },
    ],
  };
}

function matrixSeries(ctx: BuildCtx, source: "values" | "weights", extra: (j: number) => Opt): Opt[] {
  const { rows, cols } = ctx.input.matrix;
  const data = ctx.input.matrix[source];
  return cols.map((c, j) => ({
    type: "bar",
    name: label(ctx, c),
    data: rows.map((_, i) => data[i][j]),
    itemStyle: { color: colorOf(ctx, c, j), borderRadius: 0 },
    ...extra(j),
  }));
}

function matrixOption(ctx: BuildCtx, series: Opt[], yExtra: Opt = {}, tooltipValue?: (n: number) => string): Opt {
  const { rows, cols } = ctx.input.matrix;
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: true, bottom: rows.length > 5 ? 18 : 6 }),
    legend: legend(ctx, cols.map((c) => label(ctx, c))),
    tooltip: {
      ...axisTooltip(ctx),
      axisPointer: { type: "shadow", shadowStyle: { color: ctx.tokens.grid, opacity: 0.35 } },
      ...(tooltipValue ? { valueFormatter: (v: number) => tooltipValue(Number(v)) } : {}),
    },
    xAxis: catAxis(ctx, rows.map((r) => label(ctx, r)), { axisLabel: { interval: 0, rotate: rows.length > 5 ? 30 : 0, width: 78, overflow: "truncate" } }),
    yAxis: valAxis(ctx, yExtra),
    series,
  };
}

// 4. Grouped bars: several bars per category, one per second-dimension value.
export function groupedBar(ctx: BuildCtx): Opt {
  return matrixOption(ctx, matrixSeries(ctx, "values", () => ({ barMaxWidth: 22, itemStyle: undefined })).map((s, j) => ({ ...s, itemStyle: { color: colorOf(ctx, ctx.input.matrix.cols[j], j), borderRadius: [3, 3, 0, 0] } })));
}

// 5. Stacked bars.
export function stackedBar(ctx: BuildCtx): Opt {
  const { cols } = ctx.input.matrix;
  const series = matrixSeries(ctx, "weights", (j) => ({
    stack: "total",
    barMaxWidth: 40,
    // a 2px surface gap between stacked segments keeps neighbours legible
    itemStyle: { color: colorOf(ctx, cols[j], j), borderColor: ctx.tokens.surface, borderWidth: 1 },
  }));
  return matrixOption(ctx, series, {}, (n) => partFmt(ctx, n));
}

// 6. 100 % stacked bars: proportions instead of totals.
export function stacked100(ctx: BuildCtx): Opt {
  const { rows, cols, weights } = ctx.input.matrix;
  const rowTotals = rows.map((_, i) => weights[i].reduce((s, v) => s + v, 0));
  const series = cols.map((c, j) => ({
    type: "bar",
    name: label(ctx, c),
    stack: "total",
    barMaxWidth: 40,
    data: rows.map((_, i) => (rowTotals[i] > 0 ? (weights[i][j] / rowTotals[i]) * 100 : 0)),
    itemStyle: { color: colorOf(ctx, c, j), borderColor: ctx.tokens.surface, borderWidth: 1 },
  }));
  return matrixOption(
    ctx,
    series,
    { max: 100, axisLabel: { formatter: (v: number) => v + "%" } },
    (n) => plain(ctx, n, 1) + " %",
  );
}

function lineSeries(ctx: BuildCtx, opts: { area?: boolean; stack?: boolean; step?: boolean }): Opt[] {
  const many = ctx.input.time.ts.length > 40;
  return ctx.input.time.series.map((s, i) => {
    const color = colorOf(ctx, s.name, i);
    return {
      type: "line",
      name: label(ctx, s.name),
      data: s.values.map(nn),
      showSymbol: !many,
      symbolSize: 5,
      smooth: false,
      step: opts.step ? "middle" : false,
      stack: opts.stack ? "total" : undefined,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      areaStyle: opts.area ? { color, opacity: opts.stack ? 0.55 : 0.16 } : undefined,
      emphasis: { focus: "series" },
    };
  });
}

function singleLine(ctx: BuildCtx, opts: { area?: boolean; step?: boolean }): Opt {
  const { ts, total } = ctx.input.time;
  return {
    ...base(ctx),
    grid: grid(ctx),
    tooltip: axisTooltip(ctx, (i) => fullDateLabel(ctx, ts[i])),
    xAxis: catAxis(ctx, timeLabels(ctx), { boundaryGap: opts.area ? false : true }),
    yAxis: valAxis(ctx),
    series: [
      {
        type: "line",
        name: ctx.t(ctx.input.meta.measure.labelKey),
        data: total.map(nn),
        showSymbol: ts.length <= 40,
        symbolSize: 5,
        step: opts.step ? "middle" : false,
        lineStyle: { width: 2, color: ctx.tokens.accent },
        itemStyle: { color: ctx.tokens.accent },
        areaStyle: opts.area ? { color: ctx.tokens.accent, opacity: 0.16 } : undefined,
      },
    ],
  };
}

// 7. Line chart.
export const line = (ctx: BuildCtx): Opt => singleLine(ctx, {});

// 9. Area chart.
export const area = (ctx: BuildCtx): Opt => singleLine(ctx, { area: true });

// 11. Step chart: the value holds until the next bucket.
export const step = (ctx: BuildCtx): Opt => singleLine(ctx, { step: true });

function multiOption(ctx: BuildCtx, series: Opt[], partial = false): Opt {
  const { ts, series: raw } = ctx.input.time;
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: true }),
    legend: legend(ctx, raw.map((s) => label(ctx, s.name))),
    tooltip: {
      ...axisTooltip(ctx, (i) => fullDateLabel(ctx, ts[i])),
      ...(partial ? { valueFormatter: (v: number | null) => (v === null ? "-" : partFmt(ctx, Number(v))) } : {}),
    },
    xAxis: catAxis(ctx, timeLabels(ctx), { boundaryGap: false }),
    yAxis: valAxis(ctx),
    series,
  };
}

// 8. Multi-line chart: one line per category.
export const multiLine = (ctx: BuildCtx): Opt => multiOption(ctx, lineSeries(ctx, {}));

// 10. Stacked area chart. Stacking adds the series up, which is only
// meaningful for counts: averages (a score per mode, say) are drawn as
// overlapping translucent areas instead of a sum that never existed.
export function stackedArea(ctx: BuildCtx): Opt {
  return multiOption(ctx, lineSeries(ctx, { area: true, stack: ctx.input.meta.measure.additive }));
}

// 12. Combo chart: columns for the value per bucket, a line for its moving
// average (same axis, so the two read against one scale).
export function combo(ctx: BuildCtx): Opt {
  const { ts, total } = ctx.input.time;
  const window = ctx.input.meta.bucket === "hour" ? 6 : ctx.input.meta.bucket === "day" ? 7 : 4;
  const avg = movingAverage(total, window);
  const barName = ctx.t(ctx.input.meta.measure.labelKey);
  const avgName = ctx.t("charts.movingAverage", { n: window });
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: true }),
    legend: legend(ctx, [barName, avgName]),
    tooltip: axisTooltip(ctx, (i) => fullDateLabel(ctx, ts[i])),
    xAxis: catAxis(ctx, timeLabels(ctx)),
    yAxis: valAxis(ctx),
    series: [
      { type: "bar", name: barName, data: total.map(nn), barMaxWidth: 22, itemStyle: { color: ctx.tokens.series[0], borderRadius: [3, 3, 0, 0], opacity: 0.85 } },
      {
        type: "line",
        name: avgName,
        data: avg.map(nn),
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2.5, color: ctx.tokens.series[1] },
        itemStyle: { color: ctx.tokens.series[1] },
        z: 3,
      },
    ],
  };
}

// 13. Waterfall: from the first bucket's level, each bucket's rise or fall,
// ending on the last level.
export function waterfall(ctx: BuildCtx): Opt {
  const { ts, total } = ctx.input.time;
  const levels = total.map((v) => (Number.isNaN(v) ? 0 : v));
  const tone = toneColors(ctx);
  const startName = ctx.t("charts.start");
  const endName = ctx.t("charts.end");
  const upName = ctx.t("charts.increase");
  const downName = ctx.t("charts.decrease");
  const totalName = ctx.t("charts.level");
  const cats = [startName, ...ts.slice(1).map((t) => dateLabel(ctx, t)), endName];
  const n = levels.length;
  const baseData: number[] = [0];
  const ups: (number | null)[] = [null];
  const downs: (number | null)[] = [null];
  const totals: (number | null)[] = [levels[0] ?? 0];
  for (let i = 1; i < n; i++) {
    const delta = levels[i] - levels[i - 1];
    baseData.push(Math.min(levels[i], levels[i - 1]));
    ups.push(delta > 0 ? delta : null);
    downs.push(delta < 0 ? -delta : null);
    totals.push(null);
  }
  baseData.push(0);
  ups.push(null);
  downs.push(null);
  totals.push(levels[n - 1] ?? 0);
  return {
    ...base(ctx),
    grid: grid(ctx, { legend: true }),
    legend: legend(ctx, [totalName, upName, downName]),
    tooltip: {
      ...axisTooltip(ctx),
      formatter: (params: Opt[]) => {
        const shown = params.filter((p) => p.seriesName !== "__base" && p.value !== null && p.value !== undefined);
        return `${params[0].name}<br/>${shown.map((p) => `${p.marker} ${p.seriesName}: <b>${fmt(ctx, Number(p.value))}</b>`).join("<br/>")}`;
      },
    },
    xAxis: catAxis(ctx, cats),
    yAxis: valAxis(ctx),
    series: [
      { type: "bar", name: "__base", stack: "wf", data: baseData, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false }, silent: true },
      { type: "bar", name: totalName, stack: "wf", data: totals, barMaxWidth: 26, itemStyle: { color: ctx.tokens.muted } },
      { type: "bar", name: upName, stack: "wf", data: ups, barMaxWidth: 26, itemStyle: { color: tone.up } },
      { type: "bar", name: downName, stack: "wf", data: downs, barMaxWidth: 26, itemStyle: { color: tone.down } },
    ],
  };
}


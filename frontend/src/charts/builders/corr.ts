import { correlationMatrix, hexbin, kde, linspace, silverman } from "../shape.ts";
import { base, grid, itemTooltip, legend, plain, valAxis, variableName, type BuildCtx, type Opt } from "./common.ts";

export function columns(ctx: BuildCtx): number[][] {
  const rows = ctx.input.variables.rows;
  const n = ctx.input.variables.names.length;
  return Array.from({ length: n }, (_, j) => rows.map((r) => r[j] ?? 0));
}

export function variableNames(ctx: BuildCtx): string[] {
  return ctx.input.variables.names.map((_, i) => variableName(ctx, i));
}

// 45. Correlation heatmap: Pearson's r between every pair of variables.
export function corrHeatmap(ctx: BuildCtx): Opt {
  const names = variableNames(ctx);
  const m = correlationMatrix(columns(ctx));
  const data: number[][] = [];
  m.forEach((row, i) => row.forEach((r, j) => data.push([j, i, Math.round(r * 100) / 100])));
  return {
    ...base(ctx),
    grid: { left: 8, right: ctx.compact ? 10 : 64, top: 8, bottom: 8, containLabel: true },
    tooltip: itemTooltip(ctx, (p: Opt) => `${names[p.value[1]]} / ${names[p.value[0]]}<br/>r = <b>${plain(ctx, Number(p.value[2]), 2)}</b>`),
    xAxis: { type: "category", data: names, splitArea: { show: false }, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: ctx.tokens.muted, fontSize: 11, interval: 0, width: 70, overflow: "truncate" } },
    yAxis: { type: "category", data: names, inverse: true, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: ctx.tokens.muted, fontSize: 11, width: 70, overflow: "truncate" } },
    visualMap: {
      min: -1,
      max: 1,
      calculable: false,
      orient: "vertical",
      right: 0,
      top: "middle",
      itemWidth: 12,
      itemHeight: 110,
      show: !ctx.compact,
      text: ["+1", "-1"],
      textStyle: { color: ctx.tokens.muted, fontSize: 11 },
      inRange: { color: [ctx.tokens.divLow, ctx.tokens.divMid, ctx.tokens.divHigh] },
    },
    series: [
      {
        type: "heatmap",
        data,
        itemStyle: { borderColor: ctx.tokens.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: true, fontSize: ctx.compact ? 11 : 13, color: ctx.tokens.text, formatter: (p: Opt) => plain(ctx, Number(p.value[2]), 2) },
        emphasis: { itemStyle: { borderColor: ctx.tokens.text, borderWidth: 1 } },
      },
    ],
  };
}

// 46. Pair plot: every variable against every other, with each variable's own
// density on the diagonal.
export function pairPlot(ctx: BuildCtx): Opt {
  const names = variableNames(ctx);
  const cols = columns(ctx);
  const n = names.length;
  const ranges = cols.map((c) => {
    const lo = Math.min(...c);
    const hi = Math.max(...c);
    const pad = (hi - lo) * 0.08 || 1;
    return [lo - pad, hi + pad] as [number, number];
  });
  const grids: Opt[] = [];
  const xAxis: Opt[] = [];
  const yAxis: Opt[] = [];
  const series: Opt[] = [];
  const left = ctx.compact ? 9 : 12;
  const cell = (100 - left - 2) / n;
  const height = (100 - 8 - (ctx.compact ? 10 : 14)) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      grids.push({ left: `${left + j * cell}%`, width: `${cell - 1.6}%`, top: `${4 + i * height}%`, height: `${height - 3}%` });
      xAxis.push({
        gridIndex: idx,
        type: "value",
        min: ranges[j][0],
        max: ranges[j][1],
        splitLine: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: ctx.tokens.grid } },
        axisLabel: { show: i === n - 1, color: ctx.tokens.muted, fontSize: 10, hideOverlap: true },
        name: i === n - 1 && !ctx.compact ? names[j] : "",
        nameLocation: "middle",
        nameGap: 20,
        nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 },
      });
      yAxis.push({
        gridIndex: idx,
        type: "value",
        min: i === j ? undefined : ranges[i][0],
        max: i === j ? undefined : ranges[i][1],
        splitLine: { lineStyle: { color: ctx.tokens.grid, opacity: 0.6 } },
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { show: j === 0 && i !== j, color: ctx.tokens.muted, fontSize: 10, hideOverlap: true },
        name: j === 0 && !ctx.compact ? names[i] : "",
        nameLocation: "end",
        nameTextStyle: { color: ctx.tokens.muted, fontSize: 11, align: "left" },
      });
      if (i === j) {
        const g = linspace(ranges[j][0], ranges[j][1], 40);
        series.push({
          type: "line",
          xAxisIndex: idx,
          yAxisIndex: idx,
          silent: true,
          showSymbol: false,
          smooth: true,
          data: kde(cols[j], g, silverman(cols[j])).map((d, k) => [g[k], d]),
          lineStyle: { width: 1.5, color: ctx.tokens.accent },
          areaStyle: { color: ctx.tokens.accent, opacity: 0.18 },
          tooltip: { show: false },
        });
      } else {
        series.push({
          type: "scatter",
          xAxisIndex: idx,
          yAxisIndex: idx,
          data: cols[j].map((x, k) => [x, cols[i][k]]),
          symbolSize: 4,
          itemStyle: { color: ctx.tokens.series[0], opacity: 0.55 },
          tooltip: { formatter: (p: Opt) => `${names[j]}: <b>${plain(ctx, Number(p.value[0]))}</b><br/>${names[i]}: <b>${plain(ctx, Number(p.value[1]))}</b>` },
        });
      }
    }
  }
  return { ...base(ctx), tooltip: { ...base(ctx).tooltip, trigger: "item" }, grid: grids, xAxis, yAxis, series };
}

// 47. Hexbin plot: scatter points binned into hexagons, coloured by count -
// readable where a scatter plot's points would pile up.
export function hexbinChart(ctx: BuildCtx): Opt {
  const pts = ctx.input.points.map((p) => ({ x: p.x, y: p.y }));
  const hex = hexbin(pts, ctx.compact ? 9 : 13);
  const vx = Math.max(...hex.vertices.map((v) => Math.abs(v[0])), 0);
  const vy = Math.max(...hex.vertices.map((v) => Math.abs(v[1])), 0);
  const xs = hex.bins.map((b) => b.cx);
  const ys = hex.bins.map((b) => b.cy);
  const xName = variableName(ctx, 0);
  const yName = variableName(ctx, 1);
  return {
    ...base(ctx),
    grid: grid(ctx, { bottom: ctx.compact ? 6 : 26, left: 6, right: ctx.compact ? 14 : 66 }),
    tooltip: itemTooltip(ctx, (p: Opt) => `${xName}: <b>${plain(ctx, Number(p.value[0]))}</b><br/>${yName}: <b>${plain(ctx, Number(p.value[1]))}</b><br/><b>${plain(ctx, Number(p.value[2]), 0)}</b> ${ctx.t("charts.observations")}`),
    visualMap: {
      show: !ctx.compact,
      min: 1,
      max: Math.max(hex.maxCount, 2),
      dimension: 2,
      orient: "vertical",
      right: 0,
      top: "middle",
      itemWidth: 12,
      itemHeight: 110,
      calculable: false,
      text: [plain(ctx, hex.maxCount, 0), "1"],
      textStyle: { color: ctx.tokens.muted, fontSize: 11 },
      inRange: { color: ctx.tokens.seq },
    },
    xAxis: valAxis(ctx, { min: Math.min(...xs) >= 0 ? Math.max(0, Math.min(...xs) - vx) : Math.min(...xs) - vx, max: Math.max(...xs) + vx, name: ctx.compact ? undefined : xName, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: ctx.tokens.muted, fontSize: 11 }, splitLine: { show: false } }),
    yAxis: valAxis(ctx, { min: Math.min(...ys) >= 0 ? Math.max(0, Math.min(...ys) - vy) : Math.min(...ys) - vy, max: Math.max(...ys) + vy }),
    series: [
      {
        type: "custom",
        data: hex.bins.map((b) => [b.cx, b.cy, b.count]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderItem: (_p: any, api: any) => {
          const cx = api.value(0) as number;
          const cy = api.value(1) as number;
          const points = hex.vertices.map(([dx, dy]) => api.coord([cx + dx, cy + dy]));
          return { type: "polygon", shape: { points }, style: api.style({ fill: api.visual("color"), stroke: ctx.tokens.surface, lineWidth: 1 }) };
        },
      },
    ],
  };
}

export { legend };

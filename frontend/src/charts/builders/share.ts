import { OTHER, type TreeNode } from "../types.ts";
import { base, fmt, itemTooltip, label, legend, plain, seriesColor, topCategories, type BuildCtx, type Opt } from "./common.ts";

function colorOf(ctx: BuildCtx, name: string, i: number): string {
  return name === OTHER ? ctx.tokens.muted : seriesColor(ctx, i);
}

// Parts of a whole are sized by weight: the event count for additive
// measures, the sample count behind an average otherwise.
function slices(ctx: BuildCtx) {
  const cats = topCategories(ctx, 8, "weight");
  return cats.map((c, i) => ({
    name: label(ctx, c.name),
    value: c.weight,
    itemStyle: { color: colorOf(ctx, c.name, i), borderColor: ctx.tokens.surface, borderWidth: 2 },
  }));
}

function pieTooltip(ctx: BuildCtx): Opt {
  return itemTooltip(ctx, (p: Opt) => `${p.marker} ${p.name}: <b>${plain(ctx, Number(p.value), 0)}</b> (${plain(ctx, Number(p.percent), 1)} %)`);
}

function pieBase(ctx: BuildCtx, data: Opt[], series: Opt): Opt {
  return {
    ...base(ctx),
    legend: { ...legend(ctx, data.filter((d) => d.tooltip?.show !== false).map((d) => d.name)), top: undefined, bottom: 0 },
    tooltip: pieTooltip(ctx),
    series: [{ type: "pie", data, ...series }],
  };
}

const sliceLabel = (ctx: BuildCtx): Opt =>
  ctx.compact
    ? { show: false }
    : { show: true, color: ctx.tokens.text, fontSize: 11, formatter: (p: Opt) => `${p.name} ${plain(ctx, Number(p.percent), 0)} %` };

// 14. Pie chart.
export function pie(ctx: BuildCtx): Opt {
  return pieBase(ctx, slices(ctx), {
    radius: "68%",
    center: ["50%", ctx.compact ? "42%" : "45%"],
    label: sliceLabel(ctx),
    labelLine: { show: !ctx.compact, lineStyle: { color: ctx.tokens.grid } },
  });
}

// 15. Donut chart, the total in the hole.
export function donut(ctx: BuildCtx): Opt {
  const data = slices(ctx);
  const total = data.reduce((s, d) => s + d.value, 0);
  return {
    ...pieBase(ctx, data, {
      radius: ["52%", "76%"],
      center: ["50%", "45%"],
      label: { show: false },
      emphasis: { scale: false },
    }),
    graphic: [
      {
        type: "text",
        left: "center",
        top: "38%",
        style: { text: plain(ctx, total, 0), fill: ctx.tokens.text, font: `600 ${ctx.compact ? 20 : 26}px ${ctx.tokens.font}`, textAlign: "center" },
      },
      {
        type: "text",
        left: "center",
        top: ctx.compact ? "52%" : "54%",
        style: { text: ctx.input.meta.measure.additive ? ctx.t(ctx.input.meta.measure.labelKey) : ctx.t("charts.samples"), fill: ctx.tokens.muted, font: `400 12px ${ctx.tokens.font}`, textAlign: "center" },
      },
    ],
  };
}

// 16. Semi-donut: a 180 degree arc. The unused half is a transparent slice
// worth the whole, which keeps every real slice at its true angle.
export function semiDonut(ctx: BuildCtx): Opt {
  const data = slices(ctx);
  const total = data.reduce((s, d) => s + d.value, 0);
  const shown = [...data, { name: "", value: total, itemStyle: { color: "transparent", borderWidth: 0 }, label: { show: false }, tooltip: { show: false }, silent: true }];
  return {
    ...pieBase(ctx, shown, {
      startAngle: 180,
      radius: ["56%", "86%"],
      center: ["50%", "68%"],
      label: { show: false },
      emphasis: { scale: false },
    }),
    graphic: [
      {
        type: "text",
        left: "center",
        top: "58%",
        style: { text: plain(ctx, total, 0), fill: ctx.tokens.text, font: `600 ${ctx.compact ? 20 : 26}px ${ctx.tokens.font}`, textAlign: "center" },
      },
    ],
  };
}

function treeData(ctx: BuildCtx, nodes: TreeNode[]): Opt[] {
  return nodes.map((n) => ({
    name: label(ctx, n.name),
    value: n.value,
    children: n.children ? treeData(ctx, n.children) : undefined,
  }));
}

// 17. Treemap: rectangles sized by weight, nested by dimension.
export function treemap(ctx: BuildCtx): Opt {
  return {
    ...base(ctx),
    tooltip: itemTooltip(ctx, (p: Opt) => `${p.marker} ${(p.treePathInfo ?? []).map((x: Opt) => x.name).filter(Boolean).join(" / ")}: <b>${plain(ctx, Number(p.value), 0)}</b>`),
    series: [
      {
        type: "treemap",
        data: treeData(ctx, ctx.input.hierarchy),
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        color: ctx.tokens.series,
        label: { show: true, color: "#ffffff", fontSize: 11, formatter: "{b}", overflow: "truncate" },
        upperLabel: { show: !ctx.compact, height: 20, color: "#ffffff", fontSize: 11 },
        itemStyle: { borderColor: ctx.tokens.surface, borderWidth: 2, gapWidth: 2 },
        levels: [
          { itemStyle: { borderColor: ctx.tokens.surface, borderWidth: 2, gapWidth: 3 } },
          { colorSaturation: [0.55, 0.85], itemStyle: { borderColorSaturation: 0.7, gapWidth: 1, borderWidth: 1 } },
          { colorSaturation: [0.45, 0.75], itemStyle: { gapWidth: 1, borderWidth: 1 } },
        ],
      },
    ],
  };
}

// 18. Sunburst: the same hierarchy as concentric rings.
export function sunburst(ctx: BuildCtx): Opt {
  return {
    ...base(ctx),
    tooltip: itemTooltip(ctx, (p: Opt) => `${p.marker} ${(p.treePathInfo ?? []).map((x: Opt) => x.name).filter(Boolean).join(" / ")}: <b>${plain(ctx, Number(p.value), 0)}</b>`),
    series: [
      {
        type: "sunburst",
        data: treeData(ctx, ctx.input.hierarchy),
        radius: ["10%", "94%"],
        center: ["50%", "50%"],
        sort: undefined,
        nodeClick: false,
        color: ctx.tokens.series,
        itemStyle: { borderColor: ctx.tokens.surface, borderWidth: 2 },
        label: { show: !ctx.compact, color: "#ffffff", fontSize: 10, minAngle: 8, rotate: "radial" },
        levels: [
          {},
          { r0: "10%", r: "42%", label: { rotate: "tangential" } },
          { r0: "42%", r: "70%", itemStyle: { opacity: 0.85 } },
          { r0: "70%", r: "94%", label: { show: false }, itemStyle: { opacity: 0.7 } },
        ],
      },
    ],
  };
}

// 19. Marimekko: column width is the column's share of the whole, and each
// column is divided by row share. One series per row so the legend works.
export function marimekko(ctx: BuildCtx): Opt {
  const { rows, cols, weights } = ctx.input.matrix;
  const colTotals = cols.map((_, j) => rows.reduce((s, _r, i) => s + weights[i][j], 0));
  const grand = colTotals.reduce((s, v) => s + v, 0) || 1;
  const starts: number[] = [];
  let acc = 0;
  colTotals.forEach((t) => {
    starts.push(acc);
    acc += (t / grand) * 100;
  });

  const series = rows.map((row, i) => {
    const data = cols.map((_, j) => {
      const tot = colTotals[j] || 1;
      const y0 = (rows.slice(0, i).reduce((s, _r, k) => s + weights[k][j], 0) / tot) * 100;
      const y1 = y0 + (weights[i][j] / tot) * 100;
      return [starts[j], starts[j] + (colTotals[j] / grand) * 100, y0, y1, j, weights[i][j], i];
    });
    const color = colorOf(ctx, row, i);
    return {
      type: "custom",
      name: label(ctx, row),
      data,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderItem: (_p: any, api: any) => {
        const p0 = api.coord([api.value(0), api.value(2)]);
        const p1 = api.coord([api.value(1), api.value(3)]);
        const w = p1[0] - p0[0] - 2;
        const h = p0[1] - p1[1] - 2;
        if (w <= 0 || h <= 0) return null;
        const children: Opt[] = [
          { type: "rect", shape: { x: p0[0] + 1, y: p1[1] + 1, width: w, height: h }, style: { fill: color } },
        ];
        if (w > 44 && h > 20) {
          const share = ((api.value(3) - api.value(2)) as number).toFixed(0);
          children.push({
            type: "text",
            style: { text: share + "%", x: p0[0] + 1 + w / 2, y: p1[1] + 1 + h / 2, textAlign: "center", textVerticalAlign: "middle", fill: "#ffffff", font: `600 11px ${ctx.tokens.font}` },
          });
        }
        if (i === 0) {
          children.push({
            type: "text",
            style: { text: label(ctx, cols[api.value(4) as number]), x: p0[0] + 1 + w / 2, y: p0[1] + 6, textAlign: "center", textVerticalAlign: "top", fill: ctx.tokens.muted, font: `400 11px ${ctx.tokens.font}`, width: Math.max(w, 30), overflow: "truncate" },
          });
        }
        return { type: "group", children };
      },
    };
  });

  return {
    ...base(ctx),
    grid: { left: 34, right: 10, top: 34, bottom: 26 },
    legend: legend(ctx, rows.map((r) => label(ctx, r))),
    tooltip: itemTooltip(ctx, (p: Opt) => {
      const [x0, x1, y0, y1, j, w] = p.value as number[];
      return `${p.marker} ${p.seriesName} - ${label(ctx, cols[j])}<br/><b>${plain(ctx, w, 0)}</b> (${plain(ctx, y1 - y0, 0)} % ${ctx.t("charts.ofColumn")}, ${plain(ctx, x1 - x0, 0)} % ${ctx.t("charts.ofTotal")})`;
    }),
    xAxis: { type: "value", min: 0, max: 100, show: false },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      splitLine: { lineStyle: { color: ctx.tokens.grid } },
      axisLabel: { color: ctx.tokens.muted, fontSize: 11, formatter: (v: number) => v + "%" },
    },
    series,
    fmt: undefined,
  };
}

export { fmt };

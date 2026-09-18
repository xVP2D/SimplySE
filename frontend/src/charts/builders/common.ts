import type { ChartInput } from "../types.ts";
import { formatDuration } from "../shape.ts";
import { OTHER } from "../types.ts";
import type { ChartTokens } from "../tokens.ts";

// ECharts options are deeply nested and loosely typed on purpose here: the
// builders assemble plain objects, and typing every nested key would add
// noise without catching real mistakes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Opt = Record<string, any>;

export interface BuildCtx {
  input: ChartInput;
  tokens: ChartTokens;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
  compact: boolean;
  // the tile's own title already names the data: KPI captions would repeat it
  bare?: boolean;
}

export function fmt(ctx: BuildCtx, n: number): string {
  if (!Number.isFinite(n)) return "-";
  const m = ctx.input.meta.measure;
  if (m.unit === "percent") return new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: 1 }).format(n) + " %";
  if (m.unit === "seconds") return formatDuration(n);
  const digits = m.additive ? 0 : 1;
  return new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: digits }).format(n);
}

export function short(ctx: BuildCtx, n: number): string {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat(ctx.locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function plain(ctx: BuildCtx, n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: digits }).format(n);
}

// Names are shown as they are (agents, SELinux terms are deliberately left
// untranslated) except the merged tail of a long list.
export function label(ctx: BuildCtx, name: string): string {
  return name === OTHER ? ctx.t("charts.other") : name === "" ? "-" : name;
}

export function dateLabel(ctx: BuildCtx, ts: number): string {
  const d = new Date(ts * 1000);
  if (ctx.input.meta.bucket === "hour") return d.toLocaleTimeString(ctx.locale, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(ctx.locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}

export function fullDateLabel(ctx: BuildCtx, ts: number): string {
  const d = new Date(ts * 1000);
  if (ctx.input.meta.bucket === "hour") return d.toLocaleString(ctx.locale, { dateStyle: "short", timeStyle: "short" });
  return d.toLocaleDateString(ctx.locale, { dateStyle: "medium", timeZone: "UTC" });
}

export function variableName(ctx: BuildCtx, i: number): string {
  const key = ctx.input.variables.names[i];
  return key ? ctx.t(key) : "";
}

export function nn(v: number): number | null {
  return Number.isNaN(v) ? null : v;
}

export function base(ctx: BuildCtx): Opt {
  const { tokens } = ctx;
  return {
    aria: { enabled: true },
    animationDuration: 350,
    textStyle: { fontFamily: tokens.font, color: tokens.text },
    color: tokens.series,
    tooltip: {
      confine: true,
      backgroundColor: tokens.surface,
      borderColor: tokens.grid,
      textStyle: { color: tokens.text, fontSize: 12 },
      extraCssText: "box-shadow:0 4px 14px rgba(0,0,0,0.2);",
    },
  };
}

export function grid(_ctx: BuildCtx, opts: { legend?: boolean; bottom?: number; left?: number; right?: number } = {}): Opt {
  return {
    left: opts.left ?? 6,
    right: opts.right ?? 14,
    top: opts.legend ? 34 : 26,
    bottom: opts.bottom ?? 6,
    containLabel: true,
  };
}

export function legend(ctx: BuildCtx, names: string[]): Opt {
  return {
    type: "scroll",
    top: 0,
    left: 0,
    right: 30,
    data: names,
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 12,
    icon: "roundRect",
    textStyle: { color: ctx.tokens.muted, fontSize: ctx.compact ? 11 : 12 },
    pageIconColor: ctx.tokens.muted,
    pageTextStyle: { color: ctx.tokens.muted },
  };
}

export function catAxis(ctx: BuildCtx, data: string[], extra: Opt = {}): Opt {
  return {
    type: "category",
    data,
    axisLine: { lineStyle: { color: ctx.tokens.grid } },
    axisTick: { show: false },
    axisLabel: { color: ctx.tokens.muted, fontSize: 11, hideOverlap: true, ...(extra.axisLabel ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "axisLabel")),
  };
}

export function valAxis(ctx: BuildCtx, extra: Opt = {}): Opt {
  return {
    type: "value",
    splitLine: { lineStyle: { color: ctx.tokens.grid } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: ctx.tokens.muted, fontSize: 11, formatter: (v: number) => short(ctx, v), ...(extra.axisLabel ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "axisLabel")),
  };
}

export function timeLabels(ctx: BuildCtx): string[] {
  return ctx.input.time.ts.map((ts) => dateLabel(ctx, ts));
}

export function axisTooltip(ctx: BuildCtx, header?: (idx: number) => string): Opt {
  return {
    ...base(ctx).tooltip,
    trigger: "axis",
    axisPointer: { type: "line", lineStyle: { color: ctx.tokens.grid, width: 1 } },
    valueFormatter: (v: number | null) => (v === null || v === undefined ? "-" : fmt(ctx, Number(v))),
    ...(header
      ? {
          formatter: (params: Opt[]) => {
            const rows = params
              .filter((p) => p.value !== null && p.value !== undefined && p.seriesName !== "__base")
              .map((p) => `${p.marker} ${p.seriesName ? p.seriesName + ": " : ""}<b>${fmt(ctx, Number(Array.isArray(p.value) ? p.value[1] : p.value))}</b>`);
            return `${header(params[0].dataIndex)}<br/>${rows.join("<br/>")}`;
          },
        }
      : {}),
  };
}

export function itemTooltip(ctx: BuildCtx, formatter?: (p: Opt) => string): Opt {
  return { ...base(ctx).tooltip, trigger: "item", ...(formatter ? { formatter } : {}) };
}

// Categories ready for a chart: biggest first, capped, the tail merged.
export function topCategories(ctx: BuildCtx, n: number, by: "value" | "weight" = "value") {
  const list = [...ctx.input.categories].sort((a, b) => b[by] - a[by]);
  const head = list.slice(0, n);
  const tail = list.slice(n);
  if (tail.length) {
    head.push({
      name: OTHER,
      value: ctx.input.meta.measure.additive ? tail.reduce((s, c) => s + c.value, 0) : tail.reduce((s, c) => s + c.value * c.weight, 0) / (tail.reduce((s, c) => s + c.weight, 0) || 1),
      weight: tail.reduce((s, c) => s + c.weight, 0),
    });
  }
  return head;
}

// Interpolates a colour ramp at t in [0, 1].
export function ramp(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function hex(h: string): number[] {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

export function seriesColor(ctx: BuildCtx, i: number): string {
  return ctx.tokens.series[i % ctx.tokens.series.length];
}

// The colour for "more than before" / "less than before", given whether more
// is better for this measure. Never the only signal: callers also show an
// arrow and a sign.
export function toneColors(ctx: BuildCtx): { up: string; down: string } {
  const p = ctx.input.meta.measure.polarity;
  if (p === "lowerBetter") return { up: ctx.tokens.bad, down: ctx.tokens.good };
  if (p === "higherBetter") return { up: ctx.tokens.good, down: ctx.tokens.bad };
  return { up: ctx.tokens.series[0], down: ctx.tokens.series[1] };
}

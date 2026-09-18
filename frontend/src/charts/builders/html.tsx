import type { CSSProperties, ReactNode } from "react";
import { correlationMatrix, niceMax } from "../shape.ts";
import { base, fmt, label, plain, ramp, toneColors, type BuildCtx, type Opt } from "./common.ts";
import { columns, variableNames } from "./corr.ts";

// KPI-style charts are plain HTML/SVG rather than ECharts: they are text and
// a few shapes, and they scale with their tile through container-query units.

const frame: CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  // "safe": when the tile is too short, drop the bottom rather than the top
  justifyContent: "safe center",
  gap: 6,
  minWidth: 0,
  containerType: "size",
  overflow: "hidden",
};

const bigNumber: CSSProperties = {
  fontSize: "clamp(26px, 22cqmin, 64px)",
  lineHeight: 1.05,
  fontWeight: 600,
  letterSpacing: "-0.025em",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flexShrink: 0, // a short tile crops the bottom, it never squashes the number
};

const caption: CSSProperties = { flexShrink: 0, fontSize: 12.5, color: "var(--color-neutral-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// What the KPI is compared against: an objective the operator set, or - by
// default - the previous period. With neither there is no target at all.
function targetName(ctx: BuildCtx): string {
  return ctx.t(ctx.input.kpi.targetSource === "config" ? "charts.target" : "charts.previousPeriod");
}

function NoTarget({ ctx, big = true }: { ctx: BuildCtx; big?: boolean }) {
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      {big && <span style={bigNumber}>{fmt(ctx, ctx.input.kpi.value)}</span>}
      <span style={caption}>{ctx.t("charts.noTarget")}</span>
    </div>
  );
}

function Caption({ ctx, extra = false }: { ctx: BuildCtx; extra?: boolean }) {
  if (ctx.bare) return null;
  return (
    <span className={extra ? "kpi-extra" : undefined} style={caption}>
      {caption1(ctx)}
    </span>
  );
}

function caption1(ctx: BuildCtx): string {
  return `${ctx.t(ctx.input.meta.measure.labelKey)} - ${ctx.t("charts.periodLong", { n: ctx.input.meta.days, count: ctx.input.meta.days })}`;
}

interface Delta {
  abs: number;
  pct: number | null;
  dir: "up" | "down" | "flat";
  color: string;
  text: string;
  icon: string;
}

function delta(ctx: BuildCtx): Delta | null {
  const { value, previous } = ctx.input.kpi;
  if (previous === null) return null;
  const abs = value - previous;
  const dir = Math.abs(abs) < 1e-9 ? "flat" : abs > 0 ? "up" : "down";
  const tone = toneColors(ctx);
  const color = dir === "flat" ? ctx.tokens.muted : dir === "up" ? tone.up : tone.down;
  const isPercent = ctx.input.meta.measure.unit === "percent";
  const pct = isPercent ? null : previous !== 0 ? (abs / Math.abs(previous)) * 100 : null;
  const sign = abs > 0 ? "+" : abs < 0 ? "-" : "";
  const text = isPercent
    ? `${sign}${plain(ctx, Math.abs(abs), 1)} ${ctx.t("charts.points")}`
    : pct === null
      ? `${sign}${plain(ctx, Math.abs(abs), 0)}`
      : `${sign}${plain(ctx, Math.abs(pct), 1)} %`;
  const icon = dir === "up" ? "ph-arrow-up-right" : dir === "down" ? "ph-arrow-down-right" : "ph-equals";
  return { abs, pct, dir, color, text, icon };
}

function DeltaBadge({ ctx, d }: { ctx: BuildCtx; d: Delta | null }) {
  if (!d) return <span style={caption}>{ctx.t("charts.noPrevious")}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontWeight: 600, color: d.color }}>
        <i className={`ph ${d.icon}`} aria-hidden />
        {d.text}
      </span>
      <span style={{ color: "var(--color-neutral-500)" }}>{ctx.t("charts.vsPrevious")}</span>
    </span>
  );
}

// Takes the space the tile has left, between a sliver and 48px.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 32;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 6)]);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <div style={{ flex: "1 1 34px", minHeight: 12, maxHeight: 48 }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden>
        <polygon points={`0,${h} ${line} ${w},${h}`} fill={color} opacity={0.14} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

// 20. KPI card
export function kpiCard(ctx: BuildCtx): ReactNode {
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      <span style={bigNumber}>{fmt(ctx, ctx.input.kpi.value)}</span>
    </div>
  );
}

// 21. KPI card with its change against the previous period
export function kpiDelta(ctx: BuildCtx): ReactNode {
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      <span style={bigNumber}>{fmt(ctx, ctx.input.kpi.value)}</span>
      <DeltaBadge ctx={ctx} d={delta(ctx)} />
    </div>
  );
}

// 22. KPI card with a mini evolution
export function kpiSpark(ctx: BuildCtx): ReactNode {
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      <span style={bigNumber}>{fmt(ctx, ctx.input.kpi.value)}</span>
      <DeltaBadge ctx={ctx} d={delta(ctx)} />
      <Sparkline values={ctx.input.kpi.spark} color={ctx.tokens.accent} />
    </div>
  );
}

// 24. Progress bar: the value against its target
export function progress(ctx: BuildCtx): ReactNode {
  if (ctx.input.kpi.targetSource === "none") return <NoTarget ctx={ctx} />;
  const { value, target } = ctx.input.kpi;
  const ratio = target > 0 ? value / target : 0;
  const p = ctx.input.meta.measure.polarity;
  const ok = p === "lowerBetter" ? value <= target : value >= target;
  const color = p === "neutral" ? ctx.tokens.accent : ok ? ctx.tokens.good : ctx.tokens.bad;
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      <span style={{ ...bigNumber, fontSize: "clamp(22px, 16cqmin, 44px)" }}>{fmt(ctx, value)}</span>
      <div role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100} style={{ height: 12, borderRadius: 6, background: "var(--color-sunken)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: "100%", background: color, borderRadius: 6 }} />
      </div>
      <span style={{ ...caption, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{plain(ctx, ratio * 100, 0)} % {ctx.t(ctx.input.kpi.targetSource === "config" ? "charts.ofTarget" : "charts.ofPrevious")}</span>
        <span>{targetName(ctx)} {fmt(ctx, target)}</span>
      </span>
    </div>
  );
}

// 25. Bullet chart: the value bar over qualitative ranges, with a target mark
export function bullet(ctx: BuildCtx): ReactNode {
  if (ctx.input.kpi.targetSource === "none") return <NoTarget ctx={ctx} />;
  const { value, target } = ctx.input.kpi;
  const max = niceMax(Math.max(value, target) * 1.25);
  const x = (v: number) => Math.max(0, Math.min(300, (v / max) * 300));
  const band = (from: number, to: number, opacity: number) => <rect x={x(from)} y={10} width={Math.max(0, x(to) - x(from))} height={30} fill={ctx.tokens.muted} opacity={opacity} />;
  return (
    <div style={frame}>
      <Caption ctx={ctx} />
      <svg viewBox="0 0 300 64" preserveAspectRatio="none" style={{ width: "100%", height: "clamp(48px, 30cqmin, 96px)" }} role="img" aria-label={`${fmt(ctx, value)} / ${fmt(ctx, target)}`}>
        {band(0, target * 0.5, 0.3)}
        {band(target * 0.5, target, 0.18)}
        {band(target, max, 0.08)}
        <rect x={0} y={20} width={x(value)} height={10} fill={ctx.tokens.accent} rx={2} />
        <line x1={x(target)} x2={x(target)} y1={12} y2={38} stroke={ctx.tokens.text} strokeWidth={3} />
        <text x={0} y={58} fill={ctx.tokens.muted} fontSize={11}>0</text>
        <text x={300} y={58} fill={ctx.tokens.muted} fontSize={11} textAnchor="end">{plain(ctx, max, 0)}</text>
      </svg>
      <span style={{ ...caption, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--color-text)", fontWeight: 600 }}>{fmt(ctx, value)}</span>
        <span>{targetName(ctx)} {fmt(ctx, target)}</span>
      </span>
    </div>
  );
}

// 26. Target vs actual
export function targetActual(ctx: BuildCtx): ReactNode {
  if (ctx.input.kpi.targetSource === "none") return <NoTarget ctx={ctx} big={false} />;
  const { value, target } = ctx.input.kpi;
  const max = Math.max(value, target) || 1;
  const gap = value - target;
  const p = ctx.input.meta.measure.polarity;
  const good = p === "lowerBetter" ? gap <= 0 : p === "higherBetter" ? gap >= 0 : true;
  const color = p === "neutral" ? ctx.tokens.muted : good ? ctx.tokens.good : ctx.tokens.bad;
  const row = (name: string, v: number, fill: string) => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(56px, 22%) 1fr auto", alignItems: "center", gap: 8 }}>
      <span style={caption}>{name}</span>
      <div style={{ height: 14, background: "var(--color-sunken)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${(v / max) * 100}%`, height: "100%", background: fill, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmt(ctx, v)}</span>
    </div>
  );
  return (
    <div style={{ ...frame, gap: 10 }}>
      <Caption ctx={ctx} />
      {row(ctx.t("charts.actual"), value, ctx.tokens.accent)}
      {row(targetName(ctx), target, ctx.tokens.muted)}
      <span style={{ fontSize: 13, color, fontWeight: 600 }}>
        <i className={`ph ${gap > 0 ? "ph-arrow-up-right" : gap < 0 ? "ph-arrow-down-right" : "ph-equals"}`} aria-hidden /> {gap > 0 ? "+" : gap < 0 ? "-" : ""}
        {plain(ctx, Math.abs(gap), 1)} {ctx.t(ctx.input.kpi.targetSource === "config" ? "charts.vsTarget" : "charts.vsPrevious")}
      </span>
    </div>
  );
}

// 27. Scorecard: the leading categories, each with its share and its change
export function scorecard(ctx: BuildCtx): ReactNode {
  const cats = ctx.input.categories.slice(0, ctx.compact ? 5 : 7);
  const max = Math.max(...cats.map((c) => c.value), 1);
  const tone = toneColors(ctx);
  return (
    <div style={{ ...frame, justifyContent: "flex-start", gap: 4, containerType: "normal", overflow: "auto" }}>
      {cats.map((c) => {
        const prev = ctx.input.kpi.previousByCategory[c.name];
        const abs = prev === undefined ? null : c.value - prev;
        const dir = abs === null || Math.abs(abs) < 1e-9 ? "flat" : abs > 0 ? "up" : "down";
        const color = dir === "flat" ? ctx.tokens.muted : dir === "up" ? tone.up : tone.down;
        return (
          <div key={c.name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(40px,1fr) auto auto", alignItems: "center", gap: 10, padding: "4px 0", borderBottom: "1px solid var(--color-divider)" }}>
            <span style={{ ...caption, color: "var(--color-text)" }} title={label(ctx, c.name)}>{label(ctx, c.name)}</span>
            <div style={{ height: 6, background: "var(--color-sunken)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${(c.value / max) * 100}%`, height: "100%", background: ctx.tokens.accent }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmt(ctx, c.value)}</span>
            <span style={{ fontSize: 12, color, minWidth: 44, textAlign: "right", whiteSpace: "nowrap" }}>
              <i className={`ph ${dir === "up" ? "ph-arrow-up-right" : dir === "down" ? "ph-arrow-down-right" : "ph-minus"}`} aria-hidden />
              {abs === null ? "" : ` ${plain(ctx, Math.abs(abs), 0)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// 28. Metric card: the value and how it behaved over the period
export function metricCard(ctx: BuildCtx): ReactNode {
  const k = ctx.input.kpi;
  const stat = (name: string, v: number) => (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={caption}>{name}</span>
      <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmt(ctx, v)}</span>
    </div>
  );
  return (
    <div style={{ ...frame, gap: 10 }}>
      <Caption ctx={ctx} extra />
      <span style={{ ...bigNumber, fontSize: "clamp(24px, 17cqmin, 48px)" }}>{fmt(ctx, k.value)}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, borderTop: "1px solid var(--color-divider)", paddingTop: 8 }}>
        {stat(ctx.t("charts.stats.min"), k.min)}
        {stat(ctx.t("charts.stats.mean"), k.mean)}
        {stat(ctx.t("charts.stats.max"), k.max)}
      </div>
      <span className="kpi-extra" style={caption}>{ctx.t("charts.perBucketNote", { n: k.buckets, unit: ctx.t("charts.perBucket." + ctx.input.meta.bucket) })}</span>
    </div>
  );
}

// 29. Delta indicator: only the change
export function deltaIndicator(ctx: BuildCtx): ReactNode {
  const d = delta(ctx);
  const k = ctx.input.kpi;
  return (
    <div style={{ ...frame, alignItems: "flex-start" }}>
      <Caption ctx={ctx} />
      {d ? (
        <>
          <span style={{ ...bigNumber, color: d.color, display: "inline-flex", alignItems: "center", gap: "0.18em" }}>
            <i className={`ph ${d.icon}`} aria-hidden />
            {d.text}
          </span>
          <span style={caption}>
            {fmt(ctx, k.previous ?? 0)} <i className="ph ph-arrow-right" aria-hidden /> {fmt(ctx, k.value)} {ctx.t("charts.vsPrevious")}
          </span>
        </>
      ) : (
        <span style={caption}>{ctx.t("charts.noPrevious")}</span>
      )}
    </div>
  );
}

// 23. Gauge (ECharts)
export function gauge(ctx: BuildCtx): Opt {
  const { value, target } = ctx.input.kpi;
  const isPercent = ctx.input.meta.measure.unit === "percent";
  const max = isPercent ? 100 : niceMax(Math.max(value, target) * 1.25);
  const p = ctx.input.meta.measure.polarity;
  const ok = p === "lowerBetter" ? value <= target : value >= target;
  const color = p === "neutral" ? ctx.tokens.accent : ok ? ctx.tokens.good : ctx.tokens.bad;
  return {
    ...base(ctx),
    series: [
      {
        type: "gauge",
        min: 0,
        max,
        startAngle: 210,
        endAngle: -30,
        radius: "92%",
        center: ["50%", ctx.compact ? "62%" : "58%"],
        progress: { show: true, width: ctx.compact ? 12 : 16, itemStyle: { color } },
        axisLine: { lineStyle: { width: ctx.compact ? 12 : 16, color: [[1, ctx.tokens.sunken]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: !ctx.compact, distance: -34, color: ctx.tokens.muted, fontSize: 10, formatter: (v: number) => (v === 0 || v === max ? plain(ctx, v, 0) : "") },
        anchor: { show: false },
        title: { show: !ctx.compact, offsetCenter: [0, "34%"], color: ctx.tokens.muted, fontSize: 12 },
        detail: { valueAnimation: true, offsetCenter: [0, ctx.compact ? "8%" : "4%"], fontSize: ctx.compact ? 16 : 32, fontWeight: 600, color: ctx.tokens.text, formatter: (v: number) => fmt(ctx, v) },
        data: [{ value, name: ctx.input.kpi.targetSource === "none" ? "" : `${targetName(ctx)} ${fmt(ctx, target)}` }],
      },
    ],
  };
}

// 43. Correlation matrix: the coefficients themselves, as a table
export function corrMatrix(ctx: BuildCtx): ReactNode {
  const names = variableNames(ctx);
  const m = correlationMatrix(columns(ctx));
  const cell = (r: number, i: number, j: number): CSSProperties => Number.isNaN(r) ? { padding: "8px 10px", textAlign: "center", color: "var(--color-neutral-500)", border: "2px solid var(--color-surface)" } : ({
    padding: "8px 10px",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
    fontWeight: i === j ? 400 : 600,
    background: i === j ? "transparent" : r >= 0 ? ramp([ctx.tokens.divMid, ctx.tokens.divHigh], Math.abs(r)) : ramp([ctx.tokens.divMid, ctx.tokens.divLow], Math.abs(r)),
    color: Math.abs(r) > 0.6 && i !== j ? "#ffffff" : "var(--color-text)",
    border: "2px solid var(--color-surface)",
    borderRadius: 4,
  });
  return (
    <div style={{ height: "100%", overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
        <thead>
          <tr>
            <th />
            {names.map((n) => (
              <th key={n} style={{ padding: "4px 8px", fontWeight: 500, color: "var(--color-neutral-500)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={n}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.map((row, i) => (
            <tr key={names[i]}>
              <th style={{ padding: "4px 8px", textAlign: "right", fontWeight: 500, color: "var(--color-neutral-500)", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={names[i]}>
                {names[i]}
              </th>
              {row.map((r, j) => (
                <td key={j} style={cell(r, i, j)} title={Number.isNaN(r) ? ctx.t("charts.noCorrelation") : undefined}>
                  {Number.isNaN(r) ? "-" : plain(ctx, r, 2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

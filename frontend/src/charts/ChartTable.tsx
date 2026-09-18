import { useTranslation } from "../i18n";
import { correlationMatrix } from "./shape.ts";
import { boxStats, mean } from "./shape.ts";
import { columns, variableNames } from "./builders/corr.ts";
import { dateLabel, fmt, fullDateLabel, label, plain, type BuildCtx } from "./builders/common.ts";
import { useTokens } from "./useTokens.ts";
import type { ChartDef } from "./registry.ts";
import type { ChartInput, TreeNode } from "./types.ts";

function flatten(nodes: TreeNode[], path: string[] = []): { path: string; value: number }[] {
  return nodes.flatMap((n) => {
    const p = [...path, n.name];
    return [{ path: p.join(" / "), value: n.value }, ...(n.children ? flatten(n.children, p) : [])];
  });
}

// The data behind a chart, as a table: the accessible alternative to the
// picture (and the only way to read exact values off a dense one).
export function ChartTable({ chart, input }: { chart: ChartDef; input: ChartInput }) {
  const { t, locale } = useTranslation();
  const tokens = useTokens();
  const ctx: BuildCtx = { input, tokens, t, locale, compact: false };
  const m = input.meta;
  const measureName = t(m.measure.labelKey);
  const dimName = t("charts.dims." + m.dim);
  const head = (cols: string[]) => (
    <thead>
      <tr>
        {cols.map((c, i) => (
          <th key={i} style={i > 0 ? { textAlign: "right" } : undefined}>
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
  const num = { textAlign: "right" as const };
  let body: JSX.Element;

  switch (chart.need) {
    case "categories":
      body = (
        <>
          {head([dimName, measureName])}
          <tbody>
            {input.categories.map((c) => (
              <tr key={c.name}>
                <td>{label(ctx, c.name)}</td>
                <td style={num}>{fmt(ctx, c.value)}</td>
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    case "time":
      body = (
        <>
          {head([t("charts.date"), measureName, ...input.time.series.map((s) => label(ctx, s.name))])}
          <tbody>
            {input.time.ts.map((ts, i) => (
              <tr key={ts}>
                <td>{fullDateLabel(ctx, ts)}</td>
                <td style={num}>{fmt(ctx, input.time.total[i])}</td>
                {input.time.series.map((s) => (
                  <td key={s.name} style={num}>
                    {fmt(ctx, s.values[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    case "matrix":
      body = (
        <>
          {head([dimName, ...input.matrix.cols.map((c) => label(ctx, c))])}
          <tbody>
            {input.matrix.rows.map((r, i) => (
              <tr key={r}>
                <td>{label(ctx, r)}</td>
                {input.matrix.cols.map((c, j) => (
                  <td key={c} style={num}>
                    {fmt(ctx, input.matrix.values[i][j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    case "hierarchy":
      body = (
        <>
          {head([t("charts.path"), t("charts.samples")])}
          <tbody>
            {flatten(input.hierarchy).map((r) => (
              <tr key={r.path}>
                <td>{r.path}</td>
                <td style={num}>{plain(ctx, r.value, 0)}</td>
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    case "kpi": {
      const k = input.kpi;
      const rows: [string, string][] = [
        [t("charts.current"), fmt(ctx, k.value)],
        [t("charts.previous"), k.previous === null ? "-" : fmt(ctx, k.previous)],
        [t(k.targetSource === "config" ? "charts.target" : "charts.previousPeriod"), k.targetSource === "none" ? "-" : fmt(ctx, k.target)],
        [t("charts.stats.min"), fmt(ctx, k.min)],
        [t("charts.stats.mean"), fmt(ctx, k.mean)],
        [t("charts.stats.max"), fmt(ctx, k.max)],
      ];
      body = (
        <>
          {head([measureName, ""])}
          <tbody>
            {rows.map(([a, b]) => (
              <tr key={a}>
                <td>{a}</td>
                <td style={num}>{b}</td>
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    }
    case "samples1":
    case "samples3":
    case "pooled3":
    case "pooled5":
      body = (
        <>
          {head([dimName, t("charts.observations"), t("charts.stats.min"), t("charts.stats.median"), t("charts.stats.mean"), t("charts.stats.max")])}
          <tbody>
            {input.samples
              .filter((s) => s.values.length)
              .map((s) => {
                const b = boxStats(s.values);
                return (
                  <tr key={s.name}>
                    <td>{label(ctx, s.name)}</td>
                    <td style={num}>{s.values.length}</td>
                    <td style={num}>{fmt(ctx, Math.min(...s.values))}</td>
                    <td style={num}>{fmt(ctx, b.median)}</td>
                    <td style={num}>{fmt(ctx, mean(s.values))}</td>
                    <td style={num}>{fmt(ctx, Math.max(...s.values))}</td>
                  </tr>
                );
              })}
          </tbody>
        </>
      );
      break;
    case "points": {
      const names = variableNames(ctx);
      body = (
        <>
          {head([t("charts.types.scatterAgent"), t("charts.date"), names[0], names[1], names[2] ?? ""])}
          <tbody>
            {input.points.slice(0, 300).map((p, i) => (
              <tr key={i}>
                <td>{p.group}</td>
                <td>{dateLabel({ ...ctx, input: { ...input, meta: { ...m, bucket: "day" } } }, p.t)}</td>
                <td style={num}>{plain(ctx, p.x)}</td>
                <td style={num}>{plain(ctx, p.y)}</td>
                <td style={num}>{plain(ctx, p.size)}</td>
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    }
    case "heat":
      body = (
        <>
          {head([dimName, ...input.heat.cols.map((c) => label(ctx, c))])}
          <tbody>
            {input.heat.rows.map((r, i) => (
              <tr key={r}>
                <td>{label(ctx, r)}</td>
                {input.heat.cols.map((c, j) => (
                  <td key={c} style={num}>
                    {input.heat.weights[i][j] > 0 || input.meta.measure.additive ? fmt(ctx, input.heat.values[i][j]) : "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    case "hourly": {
      const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((k) => t("charts.weekday." + k));
      const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
      const weight = Array.from({ length: 7 }, () => Array(24).fill(0));
      const additive = input.meta.measure.additive;
      for (const h of input.hourly) {
        const d = new Date(h.t * 1000);
        const wd = (d.getUTCDay() + 6) % 7;
        const hour = d.getUTCHours();
        sum[wd][hour] += additive ? h.value : h.value * h.weight;
        weight[wd][hour] += h.weight;
      }
      body = (
        <>
          {head([t("charts.weekday.label"), ...Array.from({ length: 24 }, (_, h) => `${h}h`)])}
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <td>{d}</td>
                {Array.from({ length: 24 }, (_, h) => (
                  <td key={h} style={num}>
                    {weight[i][h] > 0 ? fmt(ctx, additive ? sum[i][h] : sum[i][h] / weight[i][h]) : "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    }
    case "variables": {
      const names = variableNames(ctx);
      const r = correlationMatrix(columns(ctx));
      body = (
        <>
          {head(["", ...names])}
          <tbody>
            {r.map((row, i) => (
              <tr key={names[i]}>
                <td>{names[i]}</td>
                {row.map((v, j) => (
                  <td key={j} style={num}>
                    {plain(ctx, v, 2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      );
      break;
    }
  }

  return <table className="table">{body}</table>;
}

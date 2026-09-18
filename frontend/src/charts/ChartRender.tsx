import { useMemo, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { EChart } from "./EChart.tsx";
import { hasData, type ChartDef } from "./registry.ts";
import { useTokens } from "./useTokens.ts";
import type { BuildCtx, Opt } from "./builders/common.ts";
import type { ChartInput } from "./types.ts";

function Message({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center", padding: 12, color: "var(--color-neutral-500)", fontSize: 13 }}>
      <i className={`ph ${icon}`} style={{ fontSize: 22 }} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

// Draws one chart type over an already loaded input. A chart that cannot be
// drawn (not enough data, or a builder that throws) says so in place instead
// of leaving an empty frame or taking the page down with it.
export function ChartRender({ chart, input, compact = false, bare = false }: { chart: ChartDef; input: ChartInput; compact?: boolean; bare?: boolean }) {
  const { t, locale } = useTranslation();
  const tokens = useTokens();
  const ctx = useMemo<BuildCtx>(() => ({ input, tokens, t, locale, compact, bare }), [input, tokens, t, locale, compact, bare]);
  const ready = hasData(chart, input);

  const drawn = useMemo((): { option?: Opt; node?: ReactNode; error?: boolean } | null => {
    if (!ready) return null;
    try {
      if (chart.build) return { option: chart.build(ctx) };
      if (chart.render) return { node: chart.render(ctx) };
    } catch (err) {
      console.error(`chart ${chart.id} failed`, err);
      return { error: true };
    }
    return null;
  }, [ready, chart, ctx]);

  if (!ready) return <Message icon="ph-chart-line" text={t(input.empty ? "charts.noData" : "charts.notEnough")} />;
  if (!drawn || drawn.error) return <Message icon="ph-warning" text={t("charts.drawFailed")} />;
  if (drawn.option) return <EChart option={drawn.option} label={t("charts.types." + chart.id)} />;
  return <>{drawn.node}</>;
}

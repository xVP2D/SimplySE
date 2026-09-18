import { useState } from "react";
import { useTranslation } from "../i18n";
import { ChartRender } from "./ChartRender.tsx";
import { ChartTable } from "./ChartTable.tsx";
import { CHART_BY_ID } from "./registry.ts";
import { useChartInput } from "./useChartInput.ts";
import type { ChartConfig } from "./types.ts";

function Message({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center", padding: 12, color: "var(--color-neutral-500)", fontSize: 13 }}>
      <i className={`ph ${icon}`} style={{ fontSize: 22 }} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

// One chart bound to a saved configuration: loads its data (refreshing every
// minute), draws it, and lets the reader flip to the table of the same data.
export function ChartView({ config, compact = false, refreshMs = 60_000 }: { config: ChartConfig; compact?: boolean; refreshMs?: number }) {
  const { t } = useTranslation();
  const { loading, error, input } = useChartInput(config, refreshMs);
  const [table, setTable] = useState(false);
  const chart = CHART_BY_ID.get(config.chart);

  if (!chart) return <Message icon="ph-question" text={t("charts.unknownChart")} />;
  if (!input) return error ? <Message icon="ph-warning" text={t("charts.loadFailed", { error })} /> : loading ? <Message icon="ph-circle-notch" text={t("common.loading")} /> : null;

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      {table ? (
        <div style={{ height: "100%", overflow: "auto" }}>
          <ChartTable chart={chart} input={input} />
        </div>
      ) : (
        <ChartRender chart={chart} input={input} compact={compact} />
      )}
      <button
        type="button"
        className="chart-tool no-drag"
        onClick={() => setTable((v) => !v)}
        aria-pressed={table}
        title={t(table ? "charts.showChart" : "charts.showData")}
        aria-label={t(table ? "charts.showChart" : "charts.showData")}
      >
        <i className={`ph ${table ? "ph-chart-bar" : "ph-table"}`} />
      </button>
      {error && (
        <span style={{ position: "absolute", left: 4, bottom: 2, fontSize: 11, color: "var(--color-danger)" }} title={error}>
          <i className="ph ph-warning" /> {t("charts.refreshFailed")}
        </span>
      )}
    </div>
  );
}

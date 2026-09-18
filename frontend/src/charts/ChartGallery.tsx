import { useState } from "react";
import { useTranslation } from "../i18n";
import { ChartRender } from "./ChartRender.tsx";
import { DATASETS, DATASET_IDS, PERIODS, resolveConfig } from "./datasets.ts";
import { CATEGORIES, chartsIn, type ChartCategory } from "./registry.ts";
import { useChartInput } from "./useChartInput.ts";
import type { ChartConfig, DatasetId } from "./types.ts";

// Every chart type over the same data, grouped by family, each drawn live in a
// small tile: pick the dataset, the dimension and the period once, then
// choose the picture. Used as a full page and inside the widget's dialog.
export function ChartGallery({
  config,
  onChange,
  onPick,
  pickLabel,
}: {
  config: ChartConfig;
  onChange: (cfg: ChartConfig) => void;
  onPick: (chartId: string) => void;
  pickLabel: string;
}) {
  const { t } = useTranslation();
  const { loading, error, input } = useChartInput(config);
  const [category, setCategory] = useState<ChartCategory>("classic");
  const { def, dim, measure } = resolveConfig(config);

  const setDataset = (id: DatasetId) => {
    const d = DATASETS[id];
    onChange({ ...config, dataset: id, dim: d.defaultDim, measure: d.measures[0].id });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="chart-controls">
        <label className="field">
          <span>{t("charts.ui.dataset")}</span>
          <select className="input" value={config.dataset} onChange={(e) => setDataset(e.target.value as DatasetId)}>
            {DATASET_IDS.map((id) => (
              <option key={id} value={id}>
                {t(DATASETS[id].labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("charts.ui.dimension")}</span>
          <select className="input" value={dim} onChange={(e) => onChange({ ...config, dim: e.target.value })}>
            {def.dims.map((d) => (
              <option key={d} value={d}>
                {t("charts.dims." + d)}
              </option>
            ))}
          </select>
        </label>
        {def.measures.length > 1 && (
          <label className="field">
            <span>{t("charts.ui.measure")}</span>
            <select className="input" value={measure.id} onChange={(e) => onChange({ ...config, measure: e.target.value })}>
              {def.measures.map((m) => (
                <option key={m.id} value={m.id}>
                  {t(m.labelKey)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t("charts.ui.target")}</span>
          <input
            className="input"
            type="number"
            min={0}
            style={{ width: 150 }}
            placeholder={t("charts.ui.targetHint")}
            value={config.target ?? ""}
            onChange={(e) => onChange({ ...config, target: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
          />
        </label>
        <div className="field">
          <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, marginBottom: 5, color: "var(--color-neutral-400)" }}>{t("charts.ui.period")}</span>
          <div className="seg" role="radiogroup" aria-label={t("charts.ui.period")}>
            {PERIODS.map((d) => (
              <label key={d} className="seg-opt">
                <input type="radio" name="chart-period" checked={config.days === d} onChange={() => onChange({ ...config, days: d })} />
                {t("charts.periods." + d)}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-tabs" role="tablist" aria-label={t("charts.ui.families")}>
        {CATEGORIES.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} className={"btn " + (category === c ? "btn-primary" : "btn-secondary")} onClick={() => setCategory(c)}>
            {t("charts.categories." + c)}
          </button>
        ))}
      </div>

      {error && !input && <p style={{ color: "var(--color-danger)", margin: 0 }}>{t("charts.loadFailed", { error })}</p>}
      {loading && !input && <p style={{ color: "var(--color-neutral-500)", margin: 0 }}>{t("common.loading")}</p>}
      {input?.meta.truncated && <p style={{ color: "var(--color-amber)", margin: 0, fontSize: 13 }}>{t("charts.truncated")}</p>}

      {input && (
        <div className="chart-grid">
          {chartsIn(category).map((chart) => (
            <article key={chart.id} className={"chart-card" + (config.chart === chart.id ? " is-selected" : "")}>
              <header>
                <strong>{t("charts.types." + chart.id)}</strong>
                <button type="button" className="btn btn-secondary" style={{ minHeight: 28, padding: "3px 10px", fontSize: 12.5 }} onClick={() => onPick(chart.id)}>
                  {pickLabel}
                </button>
              </header>
              <div className="chart-card-body">
                <ChartRender chart={chart} input={input} compact />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

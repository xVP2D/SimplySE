import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { ChartGallery } from "./ChartGallery.tsx";
import type { ChartConfig } from "./types.ts";

// The widget's settings: the same gallery as the Charts page, opened over the
// dashboard. Picking a chart applies the current dataset, dimension and period.
export function ChartConfigDialog({ config, onApply, onClose }: { config: ChartConfig; onApply: (cfg: ChartConfig) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState(config);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog chart-dialog" role="dialog" aria-modal="true" aria-label={t("charts.ui.configure")} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h4 className="dialog-title">{t("charts.ui.configure")}</h4>
          <button type="button" className="btn btn-icon btn-secondary" onClick={onClose} aria-label={t("common.cancel")}>
            <i className="ph ph-x" />
          </button>
        </div>
        <ChartGallery config={cfg} onChange={setCfg} onPick={(chart) => onApply({ ...cfg, chart })} pickLabel={t("charts.ui.use")} />
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { useTranslation } from "../i18n";
import { GRID_COLS } from "../lib/dashboardGrid.ts";
import { BASE_ROWS, DASHBOARD_TEMPLATES, type DashboardTemplate, type TemplateCell } from "../lib/dashboardTemplates.ts";

// A template drawn as its own floor plan: one block per widget, tinted by
// kind so the rhythm of numbers, charts and lists reads at thumbnail size.
const KIND: Record<string, { icon: string; tone: string }> = {
  stat: { icon: "ph-hash", tone: "var(--color-accent-soft)" },
  chart: { icon: "ph-chart-line-up", tone: "color-mix(in srgb, var(--color-accent) 22%, var(--color-surface))" },
  list: { icon: "ph-list-bullets", tone: "var(--color-sunken)" },
  panel: { icon: "ph-squares-four", tone: "color-mix(in srgb, var(--color-accent) 10%, var(--color-sunken))" },
};

function kindOf(cell: TemplateCell): keyof typeof KIND {
  if (cell.type.startsWith("stat-")) return "stat";
  if (cell.type === "chart" || cell.type === "denial-trend") return "chart";
  if (["top-signatures", "recent-deployments", "open-alerts", "agents-vignettes"].includes(cell.type)) return "list";
  return "panel";
}

function Thumb({ template }: { template: DashboardTemplate }) {
  return (
    <div className="tpl-thumb" aria-hidden="true" style={{ aspectRatio: `${GRID_COLS} / ${BASE_ROWS * 0.42}` }}>
      {template.cells.map((c, i) => {
        const k = KIND[kindOf(c)];
        return (
          <div
            key={i}
            className="tpl-block"
            style={{
              left: `${(c.x / GRID_COLS) * 100}%`,
              top: `${(c.y / BASE_ROWS) * 100}%`,
              width: `${(c.w / GRID_COLS) * 100}%`,
              height: `${(c.h / BASE_ROWS) * 100}%`,
              background: k.tone,
            }}
          >
            {c.w * c.h >= 12 && <i className={`ph ${k.icon}`} />}
          </div>
        );
      })}
    </div>
  );
}

export function TemplatePicker({ onPick, onClose }: { onPick: (template: DashboardTemplate) => void; onClose: () => void }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tpl-dialog" role="dialog" aria-modal="true" aria-label={t("dashboard.template.title")} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h4 className="dialog-title">{t("dashboard.template.title")}</h4>
          <button type="button" className="btn btn-icon btn-secondary" onClick={onClose} aria-label={t("common.cancel")}>
            <i className="ph ph-x" />
          </button>
        </div>
        <p className="dialog-body" style={{ margin: 0 }}>
          {t("dashboard.template.intro")}
        </p>
        <div className="tpl-grid">
          {DASHBOARD_TEMPLATES.map((tpl) => (
            <article key={tpl.id} className="tpl-card">
              <Thumb template={tpl} />
              <div className="tpl-text">
                <h5>
                  <i className={`ph ${tpl.icon}`} /> {t(`dashboard.template.${tpl.id}.name`)}
                </h5>
                <p>{t(`dashboard.template.${tpl.id}.desc`)}</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => onPick(tpl)}>
                {t("dashboard.template.apply")}
              </button>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

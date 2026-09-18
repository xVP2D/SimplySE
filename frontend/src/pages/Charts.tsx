import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useTranslation } from "../i18n";
import { randomUUID } from "../lib/uuid";
import { DEFAULT_WIDGETS } from "../lib/dashboardWidgets";
import { ChartGallery } from "../charts/ChartGallery";
import { DEFAULT_CHART } from "../charts/datasets";
import { fetchHistoryStatus, type HistoryStatus } from "../charts/history";
import type { ChartConfig } from "../charts/types";

// The chart explorer: every chart type over one dataset, with the history
// each is built on. A chart can be sent to the dashboard as a tile.
export function Charts() {
  const { t, locale } = useTranslation();
  const [config, setConfig] = useState<ChartConfig>(DEFAULT_CHART);
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetchHistoryStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const since = status?.datasets.find((d) => d.dataset === config.dataset)?.since ?? null;

  const addToDashboard = async (chart: string) => {
    setMessage(null);
    try {
      const current = await api.getDashboardLayout();
      // An empty saved layout means "the default one": start from it, or the
      // dashboard would suddenly show this single chart and nothing else.
      const widgets = current.widgets && current.widgets.length > 0 ? current.widgets : DEFAULT_WIDGETS;
      const bottom = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
      await api.saveDashboardLayout([...widgets, { id: randomUUID(), type: "chart", x: 0, y: bottom, w: 6, h: 8, config: { ...config, chart } }]);
      setMessage({ ok: true, text: t("charts.ui.added") });
    } catch (err) {
      setMessage({ ok: false, text: t("charts.ui.addFailed", { error: (err as Error).message }) });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, color: "var(--color-neutral-500)", maxWidth: "78ch" }}>
        {t("charts.ui.explain")}{" "}
        {since ? t("charts.ui.historySince", { date: new Date(since).toLocaleDateString(locale, { dateStyle: "medium" }) }) + "." : status ? t("charts.ui.noHistory") : ""}
        {status && status.retention_days > 0 ? ` ${t("charts.ui.historyKept", { days: status.retention_days })}.` : ""}
      </p>
      {message && (
        <p role="status" style={{ margin: 0, color: message.ok ? "var(--color-accent)" : "var(--color-danger)" }}>
          {message.text}{" "}
          {message.ok && (
            <Link to="/" style={{ marginLeft: 6 }}>
              {t("nav.dashboard")}
            </Link>
          )}
        </p>
      )}
      <ChartGallery config={config} onChange={setConfig} onPick={addToDashboard} pickLabel={t("charts.ui.add")} />
    </div>
  );
}

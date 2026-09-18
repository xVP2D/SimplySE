import { useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { api, type Agent, type Alert, type Command, type TopSignature, type TrendPoint } from "../lib/api";
import { evaluateFleet, fleetScore } from "../lib/compliance";
import { useTranslation } from "../i18n";
import { randomUUID } from "../lib/uuid";
import {
  DEFAULT_WIDGETS,
  WIDGET_CATALOG,
  WIDGET_DEFS,
  renderWidgetContent,
  type DashboardData,
  type WidgetInstance,
  type WidgetType,
} from "../lib/dashboardWidgets";

const GRID_COLS = 12;
const ROW_HEIGHT = 32;
const MARGIN: readonly [number, number] = [11, 11];
const SAVE_DEBOUNCE_MS = 800;

function WidgetFrame({
  editMode,
  title,
  headerAction,
  limit,
  onLimitChange,
  onRemove,
  scrollable,
  children,
}: {
  editMode: boolean;
  title?: string;
  headerAction?: React.ReactNode;
  limit?: number;
  onLimitChange?: (n: number) => void;
  onRemove: () => void;
  scrollable?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 8.4,
        padding: 14,
        borderRadius: 8,
        background: "var(--color-surface)",
        boxShadow: editMode ? "var(--shadow-md)" : "var(--shadow-sm)",
        overflow: "hidden",
      }}
    >
      {(title || headerAction || editMode) && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8.4, minWidth: 0 }}>
          {title ? (
            <h5
              style={{ margin: 0, fontSize: 15, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              title={title}
            >
              {title}
            </h5>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8.4, flex: "none" }}>
            {!editMode && headerAction}
            {editMode && onLimitChange && (
              <input
                type="number"
                min={1}
                max={50}
                className="input no-drag"
                value={limit}
                onChange={(e) => onLimitChange(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                style={{ width: 56, minHeight: 26, padding: "2px 6px", fontSize: 12 }}
                title={t("dashboard.widgetLimitLabel")}
              />
            )}
            {editMode && (
              <button
                type="button"
                className="btn btn-icon btn-secondary no-drag"
                style={{ width: 26, height: 26 }}
                onClick={onRemove}
                title={t("dashboard.removeWidget")}
              >
                <i className="ph ph-x" style={{ fontSize: 13 }} />
              </button>
            )}
          </div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: scrollable ? "auto" : "hidden" }}>{children}</div>
    </div>
  );
}

export function Dashboard() {
  const { t, locale } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [topSignatures, setTopSignatures] = useState<TopSignature[]>([]);
  const [recentCommands, setRecentCommands] = useState<Command[]>([]);
  const [allOpenAlerts, setAllOpenAlerts] = useState<Alert[]>([]);
  const [openAlertsTotal, setOpenAlertsTotal] = useState(0);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [widgets, setWidgets] = useState<WidgetInstance[]>(DEFAULT_WIDGETS);
  const [editMode, setEditMode] = useState(false);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [showCatalog, setShowCatalog] = useState(false);

  const { width, containerRef, mounted } = useContainerWidth();

  // Load the saved layout once; an empty result means nothing has been
  // customized yet, so the fixed default layout (mirrors the dashboard as
  // it looked before it became a widget grid) stays in place.
  useEffect(() => {
    let cancelled = false;
    api
      .getDashboardLayout()
      .then((res) => {
        if (cancelled) return;
        if (res.widgets && res.widgets.length > 0) {
          setWidgets(res.widgets.map((w) => ({ ...w, type: w.type as WidgetType })));
        }
      })
      .catch(() => {
        // Master unreachable at load time — the poller below will surface
        // the error banner; keep the default layout for now.
      })
      .finally(() => setLayoutLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, s, c, al, tr] = await Promise.all([
          api.listAgents(),
          api.topSignatures(50),
          api.recentCommands({ limit: 50 }),
          api.listAlerts({ status: "open", limit: 500 }),
          api.denialTrend({ days: 14 }),
        ]);
        if (cancelled) return;
        setAgents(a ?? []);
        setTopSignatures(s ?? []);
        setRecentCommands(c.commands ?? []);
        setAllOpenAlerts(al.alerts ?? []);
        setOpenAlertsTotal(al.total);
        setTrend(tr ?? []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const complianceResults = evaluateFleet(agents, allOpenAlerts);
  const complianceScore = fleetScore(complianceResults);
  const data: DashboardData = {
    agents,
    topSignatures,
    recentCommands,
    openAlerts: allOpenAlerts,
    openAlertsTotal,
    complianceScore,
    complianceResults,
    trend,
  };

  // Debounced autosave: any add/remove/move/resize/setting change lands
  // here shortly after, so dragging or resizing doesn't fire a PUT per
  // pixel. Skipped until the initial GET has resolved so it can never
  // overwrite a saved layout with the still-default one.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!layoutLoaded) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api
        .saveDashboardLayout(widgets)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("idle"));
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, layoutLoaded]);

  const layout: Layout = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: WIDGET_DEFS[w.type].minSize.w,
        minH: WIDGET_DEFS[w.type].minSize.h,
      })),
    [widgets],
  );

  const handleLayoutChange = (next: Layout) => {
    setWidgets((prev) =>
      prev.map((w) => {
        const item = next.find((n) => n.i === w.id);
        return item ? { ...w, x: item.x, y: item.y, w: item.w, h: item.h } : w;
      }),
    );
  };

  const addWidget = (type: WidgetType) => {
    const def = WIDGET_DEFS[type];
    const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    setWidgets((prev) => [
      ...prev,
      {
        id: randomUUID(),
        type,
        x: 0,
        y: maxY,
        w: def.defaultSize.w,
        h: def.defaultSize.h,
        limit: def.hasLimit ? def.defaultLimit : undefined,
      },
    ]);
    setShowCatalog(false);
  };

  // A random dashboard: a random subset of the catalog in random order,
  // each with a random size around its default, packed left-to-right in
  // rows (wrapping when a widget no longer fits in the 12 columns) so no
  // two widgets can overlap.
  const randomizeLayout = () => {
    const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
    const shuffled = [...WIDGET_CATALOG];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const chosen = shuffled.slice(0, randomInt(5, WIDGET_CATALOG.length));

    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    const next: WidgetInstance[] = chosen.map((type) => {
      const def = WIDGET_DEFS[type];
      const w = Math.min(GRID_COLS, randomInt(def.minSize.w, Math.max(def.minSize.w, def.defaultSize.w + 2)));
      const h = randomInt(def.minSize.h, def.defaultSize.h + 2);
      if (cursorX + w > GRID_COLS) {
        cursorX = 0;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      const widget: WidgetInstance = {
        id: randomUUID(),
        type,
        x: cursorX,
        y: cursorY,
        w,
        h,
        limit: def.hasLimit ? randomInt(3, 20) : undefined,
      };
      cursorX += w;
      rowHeight = Math.max(rowHeight, h);
      return widget;
    });

    setWidgets(next);
    setShowCatalog(false);
  };

  const removeWidget = (id: string) => setWidgets((prev) => prev.filter((w) => w.id !== id));

  const setWidgetLimit = (id: string, limit: number) =>
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, limit } : w)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      {error && (
        <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>
          {t("dashboard.masterUnreachable", { error })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8.4 }}>
        {editMode && (
          <>
            <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
              {saveState === "saving" ? t("dashboard.savingLayout") : saveState === "saved" ? t("dashboard.layoutSaved") : ""}
            </span>
            <button type="button" className="btn btn-secondary" onClick={randomizeLayout} title={t("dashboard.randomizeHint")}>
              <i className="ph ph-shuffle" /> {t("dashboard.randomize")}
            </button>
            <div style={{ position: "relative" }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowCatalog((v) => !v)}>
                <i className="ph ph-plus" /> {t("dashboard.addWidget")}
              </button>
              {showCatalog && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    right: 0,
                    zIndex: 10,
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 220,
                    padding: 6,
                    borderRadius: 8,
                    background: "var(--color-surface)",
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  {WIDGET_CATALOG.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className="btn btn-ghost"
                      style={{ justifyContent: "flex-start" }}
                      onClick={() => addWidget(type)}
                    >
                      {t(WIDGET_DEFS[type].labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <button
          type="button"
          className={editMode ? "btn btn-primary" : "btn btn-secondary"}
          onClick={() => {
            setEditMode((v) => !v);
            setShowCatalog(false);
          }}
        >
          <i className={`ph ${editMode ? "ph-check" : "ph-sliders-horizontal"}`} />
          {editMode ? t("dashboard.doneCustomizing") : t("dashboard.customize")}
        </button>
      </div>

      <div ref={containerRef as React.RefObject<HTMLDivElement>}>
        {mounted && (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: MARGIN }}
            dragConfig={{ enabled: editMode, cancel: "button, input, select, a, .no-drag" }}
            resizeConfig={{ enabled: editMode }}
            onLayoutChange={handleLayoutChange}
            autoSize
          >
            {widgets.map((w) => {
              const { title, body, headerAction, scrollable } = renderWidgetContent(w, data, t, locale);
              const def = WIDGET_DEFS[w.type];
              return (
                <div key={w.id}>
                  <WidgetFrame
                    editMode={editMode}
                    title={title}
                    headerAction={headerAction}
                    limit={def.hasLimit ? w.limit ?? def.defaultLimit : undefined}
                    onLimitChange={def.hasLimit ? (n) => setWidgetLimit(w.id, n) : undefined}
                    onRemove={() => removeWidget(w.id)}
                    scrollable={scrollable}
                  >
                    {body}
                  </WidgetFrame>
                </div>
              );
            })}
          </GridLayout>
        )}
      </div>
    </div>
  );
}

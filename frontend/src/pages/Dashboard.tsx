import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { api, type Agent, type Alert, type Collection, type Command, type SuggestedModule, type TopSignature, type TrendPoint } from "../lib/api";
import { evaluateFleet, fleetScore } from "../lib/compliance";
import { useTranslation } from "../i18n";
import { randomUUID } from "../lib/uuid";
import { HeaderActions } from "../components/PageActions";
import { TemplatePicker } from "../components/TemplatePicker";
import { GRID_COLS, MARGIN, ROW_HEIGHT, fitLimit } from "../lib/dashboardGrid.ts";
import { placeTemplate, rowsForViewport, type DashboardTemplate } from "../lib/dashboardTemplates.ts";
const ChartConfigDialog = lazy(() => import("../charts/ChartConfigDialog").then((m) => ({ default: m.ChartConfigDialog })));
import { DEFAULT_CHART, randomChartConfig } from "../charts/datasets";
import { ALL_CHART_IDS, isTileSized } from "../charts/ids";
import {
  DEFAULT_WIDGETS,
  WIDGET_CATALOG,
  WIDGET_DEFS,
  renderWidgetContent,
  type DashboardData,
  type WidgetInstance,
  type WidgetType,
} from "../lib/dashboardWidgets";

const SAVE_DEBOUNCE_MS = 800;

function WidgetFrame({
  editMode,
  title,
  headerAction,
  limit,
  onLimitChange,
  onRemove,
  onConfigure,
  scrollable,
  children,
}: {
  editMode: boolean;
  title?: string;
  headerAction?: React.ReactNode;
  limit?: number;
  onLimitChange?: (n: number) => void;
  onRemove: () => void;
  onConfigure?: () => void;
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
        padding: 16,
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
              style={{ margin: 0, fontSize: 14.5, fontWeight: 600, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
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
            {editMode && onConfigure && (
              <button
                type="button"
                className="btn btn-icon btn-secondary no-drag"
                style={{ width: 26, height: 26 }}
                onClick={onConfigure}
                title={t("dashboard.configureChart")}
                aria-label={t("dashboard.configureChart")}
              >
                <i className="ph ph-sliders" style={{ fontSize: 13 }} />
              </button>
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
  const [pendingSuggestions, setPendingSuggestions] = useState<SuggestedModule[]>([]);
  const [activeCollections, setActiveCollections] = useState<Collection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [widgets, setWidgets] = useState<WidgetInstance[]>(DEFAULT_WIDGETS);
  const [editMode, setEditMode] = useState(false);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [showCatalog, setShowCatalog] = useState(false);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  // The layout a template or the random button just replaced, so one click
  // brings it back.
  const [previousLayout, setPreviousLayout] = useState<WidgetInstance[] | null>(null);

  const { width, containerRef, mounted } = useContainerWidth();
  // The layout as last loaded from / saved to the master. Autosave compares
  // against it, so merely opening the dashboard never writes anything.
  const syncedLayout = useRef<string | null>(null);

  // Load the saved layout once; an empty result means nothing has been
  // customized yet, so the fixed default layout (mirrors the dashboard as
  // it looked before it became a widget grid) stays in place.
  useEffect(() => {
    let cancelled = false;
    api
      .getDashboardLayout()
      .then((res) => {
        if (cancelled) return;
        const loaded =
          res.widgets && res.widgets.length > 0
            ? res.widgets.map((w) => ({ ...w, type: w.type as WidgetType }))
            : DEFAULT_WIDGETS;
        syncedLayout.current = JSON.stringify(loaded);
        setWidgets(loaded);
      })
      .catch(() => {
        // Master unreachable at load time — the poller below will surface
        // the error banner; keep the default layout for now.
        syncedLayout.current = JSON.stringify(DEFAULT_WIDGETS);
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
        const [a, s, c, al, tr, sug, col] = await Promise.all([
          api.listAgents(),
          api.topSignatures(50),
          api.recentCommands({ limit: 50 }),
          api.listAlerts({ status: "open", limit: 500 }),
          api.denialTrend({ days: 14 }),
          api.listSuggestedModules({ status: "pending", limit: 50 }),
          api.listCollections({ limit: 50 }),
        ]);
        if (cancelled) return;
        setAgents(a ?? []);
        setTopSignatures(s ?? []);
        setRecentCommands(c.commands ?? []);
        setAllOpenAlerts(al.alerts ?? []);
        setOpenAlertsTotal(al.total);
        setTrend(tr ?? []);
        setPendingSuggestions(sug.modules ?? []);
        setActiveCollections(col ?? []);
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
    pendingSuggestions,
    activeCollections,
  };

  // Debounced autosave: any add/remove/move/resize/setting change lands
  // here shortly after, so dragging or resizing doesn't fire a PUT per
  // pixel. Skipped until the initial GET has resolved so it can never
  // overwrite a saved layout with the still-default one.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!layoutLoaded) return;
    const serialized = JSON.stringify(widgets);
    if (serialized === syncedLayout.current) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api
        .saveDashboardLayout(widgets)
        .then(() => {
          syncedLayout.current = serialized;
          setSaveState("saved");
        })
        .catch(() => setSaveState("idle"));
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets, layoutLoaded]);

  // On a phone the 12-column grid squeezes every widget unreadably narrow:
  // below this width the widgets stack in one column, in reading order, and
  // layout editing (drag / resize) is unavailable.
  const stacked = mounted && width < 720;
  const stackedWidgets = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);

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
    const id = randomUUID();
    setWidgets((prev) => [
      ...prev,
      {
        id,
        type,
        x: 0,
        y: maxY,
        w: def.defaultSize.w,
        h: def.defaultSize.h,
        limit: def.hasLimit ? def.defaultLimit : undefined,
        config: type === "chart" ? DEFAULT_CHART : undefined,
      },
    ]);
    setShowCatalog(false);
    // a new chart tile opens straight on the gallery: an empty default would
    // be the least useful thing to show
    if (type === "chart") setConfiguringId(id);
  };

  // Rows of the grid that fit between its top and the bottom of the window.
  const viewportRows = () => {
    const gridTop = containerRef.current?.getBoundingClientRect().top ?? 180;
    const available = window.innerHeight - gridTop - 56;
    return Math.floor((available + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1]));
  };

  const replaceLayout = (next: WidgetInstance[]) => {
    setPreviousLayout(widgets);
    setWidgets(next);
    setShowCatalog(false);
  };

  const applyTemplate = (template: DashboardTemplate) => {
    window.scrollTo({ top: 0 });
    replaceLayout(placeTemplate(template, rowsForViewport(viewportRows())).map((p) => ({ id: randomUUID(), ...p })));
    setShowTemplates(false);
  };

  // A random dashboard that fills exactly one screen: the rows that fit
  // between the top of the grid and the bottom of the window are split, at
  // random, into cells that tile the whole 12-column area with no gap or
  // overlap; each cell then gets a widget that fits its size (small cells
  // get number tiles, large ones lists and charts), preferring types not
  // already used.
  const randomizeLayout = () => {
    const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
    const shuffle = <T,>(items: T[]): T[] => {
      const a = [...items];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    window.scrollTo({ top: 0 });
    const rows = clamp(viewportRows(), 9, 28);

    type Cell = { x: number; y: number; w: number; h: number };
    const MIN = 3;
    const cells: Cell[] = [{ x: 0, y: 0, w: GRID_COLS, h: rows }];
    const target = randomInt(6, 9);
    const middle = (size: number) => Math.round((randomInt(MIN, size - MIN) + randomInt(MIN, size - MIN)) / 2);
    while (cells.length < target) {
      const splittable = cells.filter((c) => c.w >= 2 * MIN || c.h >= 2 * MIN);
      if (splittable.length === 0) break;
      splittable.sort((a, b) => b.w * b.h - a.w * a.h);
      const cell = Math.random() < 0.7 ? splittable[0] : splittable[randomInt(0, splittable.length - 1)];
      const canCutWidth = cell.w >= 2 * MIN;
      const canCutHeight = cell.h >= 2 * MIN;
      // Cut the visually longer side (a column is ~100px wide, a row ~43px tall).
      const longerIsWidth = cell.w * 100 >= cell.h * (ROW_HEIGHT + MARGIN[1]);
      const cutWidth = canCutWidth && (!canCutHeight || (longerIsWidth ? Math.random() < 0.8 : Math.random() < 0.2));
      cells.splice(cells.indexOf(cell), 1);
      if (cutWidth) {
        const a = middle(cell.w);
        cells.push({ ...cell, w: a }, { ...cell, x: cell.x + a, w: cell.w - a });
      } else {
        const a = middle(cell.h);
        cells.push({ ...cell, h: a }, { ...cell, y: cell.y + a, h: cell.h - a });
      }
    }

    const statTypes = shuffle(WIDGET_CATALOG.filter((type) => type.startsWith("stat-")));
    const panelTypes = shuffle(WIDGET_CATALOG.filter((type) => !type.startsWith("stat-") && type !== "chart"));
    const used = new Set<WidgetType>();
    const fits = (type: WidgetType, c: Cell) => c.w >= WIDGET_DEFS[type].minSize.w && c.h >= WIDGET_DEFS[type].minSize.h;
    const pick = (pools: WidgetType[][], c: Cell): WidgetType => {
      for (const pool of pools) {
        const type = pool.find((t) => !used.has(t) && fits(t, c));
        if (type) return type;
      }
      return shuffle(WIDGET_CATALOG).find((t) => fits(t, c)) ?? "stat-agents";
    };
    // About half the cells become a chart tile: KPI-style types for the
    // small ones, any other family for the larger ones.
    const kpiCharts = ALL_CHART_IDS.filter((id) => isTileSized(id));
    const bigCharts = ALL_CHART_IDS.filter((id) => !isTileSized(id));
    const assigned = new Map<Cell, WidgetType>();
    const chartConfigs = new Map<Cell, ReturnType<typeof randomChartConfig>>();
    for (const cell of [...cells].sort((a, b) => b.w * b.h - a.w * a.h)) {
      if (Math.random() < 0.5) {
        const small = cell.h <= 4 || cell.w <= 3;
        const pool = small ? kpiCharts : bigCharts;
        assigned.set(cell, "chart");
        chartConfigs.set(cell, randomChartConfig(pool[randomInt(0, pool.length - 1)]));
        continue;
      }
      const preferTile = cell.h <= 4 || cell.w * cell.h <= 18 || Math.random() < 0.15;
      const type = pick(preferTile ? [statTypes, panelTypes] : [panelTypes, statTypes], cell);
      used.add(type);
      assigned.set(cell, type);
    }

    replaceLayout(
      cells.map((cell) => {
        const type = assigned.get(cell) as WidgetType;
        return { id: randomUUID(), type, x: cell.x, y: cell.y, w: cell.w, h: cell.h, limit: fitLimit(type, cell.w, cell.h), config: chartConfigs.get(cell) };
      }),
    );
  };

  const removeWidget = (id: string) => setWidgets((prev) => prev.filter((w) => w.id !== id));

  const setWidgetLimit = (id: string, limit: number) =>
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, limit } : w)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      {error && (
        <div style={{ color: "var(--color-danger)", fontSize: 13 }}>
          {t("dashboard.masterUnreachable", { error })}
        </div>
      )}

      {!stacked && (
      <HeaderActions>
        {editMode && (
          <>
            <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
              {saveState === "saving" ? t("dashboard.savingLayout") : saveState === "saved" ? t("dashboard.layoutSaved") : ""}
            </span>
            {previousLayout && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setWidgets(previousLayout);
                  setPreviousLayout(null);
                }}
                title={t("dashboard.undoLayoutHint")}
              >
                <i className="ph ph-arrow-counter-clockwise" /> {t("dashboard.undoLayout")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setShowTemplates(true);
                setShowCatalog(false);
              }}
              title={t("dashboard.templatesHint")}
            >
              <i className="ph ph-layout" /> {t("dashboard.templatesButton")}
            </button>
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
                    minWidth: 240,
                    maxHeight: "60vh",
                    overflowY: "auto",
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
      </HeaderActions>
      )}

      <div ref={containerRef as React.RefObject<HTMLDivElement>}>
        {stacked && (
          <div style={{ display: "flex", flexDirection: "column", gap: MARGIN[1] }}>
            {stackedWidgets.map((w) => {
              const { title, body, headerAction, scrollable } = renderWidgetContent(w, data, t, locale);
              const rows = Math.max(WIDGET_DEFS[w.type].minSize.h, w.h);
              return (
                <div key={w.id} style={{ height: rows * ROW_HEIGHT + (rows - 1) * MARGIN[1] }}>
                  <WidgetFrame editMode={false} title={title} headerAction={headerAction} onRemove={() => undefined} scrollable={scrollable}>
                    {body}
                  </WidgetFrame>
                </div>
              );
            })}
          </div>
        )}
        {mounted && !stacked && (
          <GridLayout
            width={width}
            layout={layout}
            gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: MARGIN, containerPadding: [0, 0] }}
            dragConfig={{ enabled: editMode, cancel: "button, input, select, a, .no-drag" }}
            resizeConfig={{ enabled: editMode }}
            onLayoutChange={handleLayoutChange}
            autoSize
          >
            {widgets.map((w) => {
              const { title, body, headerAction, scrollable } = renderWidgetContent(w, data, t, locale, editMode);
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
                    onConfigure={w.type === "chart" ? () => setConfiguringId(w.id) : undefined}
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

      {showTemplates && <TemplatePicker onPick={applyTemplate} onClose={() => setShowTemplates(false)} />}

      {configuringId &&
        (() => {
          const target = widgets.find((x) => x.id === configuringId);
          if (!target) return null;
          return (
            <Suspense fallback={null}>
              <ChartConfigDialog
                config={target.config ?? DEFAULT_CHART}
                onApply={(cfg) => {
                  setWidgets((prev) => prev.map((x) => (x.id === target.id ? { ...x, config: cfg } : x)));
                  setConfiguringId(null);
                }}
                onClose={() => setConfiguringId(null)}
              />
            </Suspense>
          );
        })()}
    </div>
  );
}

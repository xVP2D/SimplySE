import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { NAV, findCurrent, isPageActive } from "../lib/nav";
import { useTheme } from "../lib/theme";
import { locales, localeLabels, useTranslation, type Locale } from "../i18n";
import { PageActionsContext } from "./PageActions";

interface FleetStatus {
  online: number;
  total: number;
  openAlerts: number;
}

// Feeds the top bar's fleet pill and the alert badge. Polled slowly and only
// while the tab is visible: it's ambient context, not the page's own data.
function useFleetStatus(): FleetStatus | null {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const [agents, alerts] = await Promise.all([api.listAgents(), api.listAlerts({ status: "open", limit: 1 })]);
        if (cancelled) return;
        const list = agents ?? [];
        setStatus({ online: list.filter((a) => a.connected).length, total: list.length, openAlerts: alerts.total });
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    load();
    const timer = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return status;
}

function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export function Layout() {
  const { t, locale, setLocale } = useTranslation();
  const { theme, toggle: toggleTheme } = useTheme();
  const location = useLocation();
  const status = useFleetStatus();

  const [openId, setOpenId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = findCurrent(location.pathname);
  const openAlerts = status?.openAlerts ?? 0;

  useEffect(() => {
    setOpenId(null);
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenId(null);
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    document.title = current ? `${t(current.page.key)} · SimplySE` : "SimplySE";
  }, [current, t, locale]);

  const canHover = () => window.matchMedia?.("(hover: hover)").matches ?? false;
  const hoverOpen = (id: string) => {
    if (!canHover()) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setOpenId(id);
  };
  const hoverClose = () => {
    if (!canHover()) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setOpenId(null), 150);
  };

  const fleetHealthy = status !== null && status.total > 0 && status.online === status.total;

  return (
    <PageActionsContext.Provider value={actionsEl}>
      <div className="app">
        <div className="topbar">
          <div className="topbar-inner">
            <Link to="/" className="brand" aria-label="SimplySE">
              <span className="brand-mark">
                <i className="ph ph-shield-checkered" />
              </span>
              <span className="brand-name">
                Simply<b>SE</b>
              </span>
            </Link>

            <nav className="nav" ref={navRef} aria-label={t("topbar.mainNav")}>
              {NAV.map((cat) => {
                const active = current?.category.id === cat.id;

                if (cat.pages.length === 1) {
                  const page = cat.pages[0];
                  return (
                    <Link
                      key={cat.id}
                      to={page.to}
                      className={`nav-item${active ? " is-active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      {t(cat.labelKey)}
                    </Link>
                  );
                }

                const open = openId === cat.id;
                const hasAlertPage = cat.pages.some((p) => p.badge === "openAlerts");
                return (
                  <div
                    key={cat.id}
                    className={`nav-group${open ? " is-open" : ""}`}
                    onMouseEnter={() => hoverOpen(cat.id)}
                    onMouseLeave={hoverClose}
                  >
                    <button
                      type="button"
                      className={`nav-item${active ? " is-active" : ""}`}
                      aria-haspopup="true"
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : cat.id)}
                    >
                      {t(cat.labelKey)}
                      {hasAlertPage && openAlerts > 0 && <span className="nav-badge">{badgeText(openAlerts)}</span>}
                      <i className="ph ph-caret-down caret" />
                    </button>
                    {open && (
                      <div className="nav-menu">
                        {cat.pages.map((page) => (
                          <Link
                            key={page.to}
                            to={page.to}
                            className={`nav-menu-item${isPageActive(page, location.pathname) ? " is-active" : ""}`}
                            aria-current={isPageActive(page, location.pathname) ? "page" : undefined}
                            onClick={() => setOpenId(null)}
                          >
                            <span className="nav-menu-icon">
                              <i className={`ph ${page.icon}`} />
                            </span>
                            <span className="nav-menu-text">
                              <span className="nav-menu-title">
                                {t(page.key)}
                                {page.badge === "openAlerts" && openAlerts > 0 && (
                                  <span className="nav-badge">{badgeText(openAlerts)}</span>
                                )}
                              </span>
                              <span className="nav-menu-desc">{t(page.descKey)}</span>
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>

            <div className="topbar-tools">
              {status && (
                <Link to="/agents" className="fleet-pill" title={t("topbar.fleetOnline", { online: status.online, total: status.total })}>
                  <span className={`dot ${fleetHealthy ? "dot-ok" : "dot-warn"}`} />
                  <span className="fleet-pill-text">{t("topbar.fleetOnline", { online: status.online, total: status.total })}</span>
                </Link>
              )}
              <select
                className="topbar-select"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                aria-label={t("topbar.language")}
              >
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {localeLabels[l]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="topbar-btn"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}
                title={theme === "dark" ? t("theme.toLight") : t("theme.toDark")}
              >
                <i className={`ph ${theme === "dark" ? "ph-sun" : "ph-moon"}`} />
              </button>
              <button
                type="button"
                className="topbar-btn menu-toggle"
                onClick={() => setMobileOpen((v) => !v)}
                aria-label={mobileOpen ? t("topbar.closeMenu") : t("topbar.openMenu")}
                aria-expanded={mobileOpen}
              >
                <i className={`ph ${mobileOpen ? "ph-x" : "ph-list"}`} />
              </button>
            </div>
          </div>
        </div>

        <div className={`mobile-nav${mobileOpen ? " is-open" : ""}`}>
          {NAV.map((cat) => (
            <div key={cat.id}>
              {cat.pages.length > 1 && <div className="mobile-nav-cat">{t(cat.labelKey)}</div>}
              {cat.pages.map((page) => (
                <Link key={page.to} to={page.to} className={isPageActive(page, location.pathname) ? "is-active" : undefined}>
                  <i className={`ph ${page.icon}`} style={{ fontSize: 18 }} />
                  <span style={{ flex: 1 }}>{t(page.key)}</span>
                  {page.badge === "openAlerts" && openAlerts > 0 && <span className="nav-badge">{badgeText(openAlerts)}</span>}
                </Link>
              ))}
            </div>
          ))}
          <select
            className="input"
            style={{ marginTop: 20 }}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            aria-label={t("topbar.language")}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {localeLabels[l]}
              </option>
            ))}
          </select>
        </div>

        {current && (
          <div className="page-header">
            <div>
              {current.category.pages.length > 1 && (
                <div className="crumbs">
                  <span>{t(current.category.labelKey)}</span>
                  <i className="ph ph-caret-right" />
                  <span>{t(current.page.key)}</span>
                </div>
              )}
              <h1 className="page-title">{t(current.page.key)}</h1>
              <p className="page-desc">{t(current.page.descKey)}</p>
            </div>
            <div className="page-actions" ref={setActionsEl} />
          </div>
        )}

        <main className="page-body">
          <Outlet />
        </main>
      </div>
    </PageActionsContext.Provider>
  );
}

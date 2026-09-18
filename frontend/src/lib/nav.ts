// The single source of truth for navigation: the top bar, its dropdown
// menus, the mobile drawer and every page header are all generated from this
// list, so a page is added (or moved to another category) in exactly one place.

export interface NavPage {
  to: string;
  icon: string; // Phosphor icon class
  key: string; // i18n key of the page name
  descKey: string; // i18n key of the one-line description shown in the menu and page header
  end?: boolean;
  badge?: "openAlerts";
}

export interface NavCategory {
  id: string;
  labelKey: string;
  pages: NavPage[];
}

export const NAV: NavCategory[] = [
  {
    id: "overview",
    labelKey: "nav.cat.overview",
    pages: [
      { to: "/", icon: "ph-gauge", key: "nav.dashboard", descKey: "navDesc.dashboard", end: true },
      { to: "/charts", icon: "ph-chart-line-up", key: "nav.charts", descKey: "navDesc.charts" },
    ],
  },
  {
    id: "fleet",
    labelKey: "nav.cat.fleet",
    pages: [
      { to: "/agents", icon: "ph-desktop-tower", key: "nav.agents", descKey: "navDesc.agents" },
      { to: "/compliance", icon: "ph-shield-check", key: "nav.compliance", descKey: "navDesc.compliance" },
    ],
  },
  {
    id: "detection",
    labelKey: "nav.cat.detection",
    pages: [
      { to: "/denials", icon: "ph-warning-octagon", key: "nav.denials", descKey: "navDesc.denials" },
      { to: "/matrix", icon: "ph-grid-nine", key: "nav.matrix", descKey: "navDesc.matrix" },
      { to: "/alerts", icon: "ph-bell", key: "nav.alerts", descKey: "navDesc.alerts", badge: "openAlerts" },
      { to: "/quarantine", icon: "ph-prohibit", key: "nav.quarantine", descKey: "navDesc.quarantine" },
    ],
  },
  {
    id: "remediation",
    labelKey: "nav.cat.remediation",
    pages: [
      { to: "/suggestions", icon: "ph-magic-wand", key: "nav.suggestions", descKey: "navDesc.suggestions" },
      { to: "/collections", icon: "ph-funnel", key: "nav.collections", descKey: "navDesc.collections" },
      { to: "/deployments", icon: "ph-upload-simple", key: "nav.deployments", descKey: "navDesc.deployments" },
    ],
  },
  {
    id: "resources",
    labelKey: "nav.cat.resources",
    pages: [
      { to: "/wiki", icon: "ph-book-open", key: "nav.wiki", descKey: "navDesc.wiki" },
      { to: "/settings", icon: "ph-gear", key: "nav.settings", descKey: "navDesc.settings" },
    ],
  },
];

export function isPageActive(page: NavPage, pathname: string): boolean {
  if (page.end) return pathname === page.to;
  return pathname === page.to || pathname.startsWith(page.to + "/");
}

export function findCurrent(pathname: string): { category: NavCategory; page: NavPage } | null {
  for (const category of NAV) {
    for (const page of category.pages) {
      if (isPageActive(page, pathname)) return { category, page };
    }
  }
  return null;
}

import { NavLink, Outlet } from "react-router-dom";
import { locales, localeLabels, useTranslation, type Locale } from "../i18n";

const navItems = [
  { to: "/", icon: "ph-gauge", key: "nav.dashboard", end: true },
  { to: "/agents", icon: "ph-desktop-tower", key: "nav.agents" },
  { to: "/denials", icon: "ph-warning-octagon", key: "nav.denials" },
  { to: "/matrix", icon: "ph-grid-nine", key: "nav.matrix" },
  { to: "/deployments", icon: "ph-upload-simple", key: "nav.deployments" },
  { to: "/compliance", icon: "ph-shield-check", key: "nav.compliance" },
  { to: "/alerts", icon: "ph-bell", key: "nav.alerts" },
  { to: "/quarantine", icon: "ph-prohibit", key: "nav.quarantine" },
  { to: "/suggestions", icon: "ph-magic-wand", key: "nav.suggestions" },
  { to: "/wiki", icon: "ph-book-open", key: "nav.wiki" },
  { to: "/settings", icon: "ph-gear", key: "nav.settings" },
];

export function Layout() {
  const { t, locale, setLocale } = useTranslation();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "232px minmax(0,1fr)",
        minHeight: "100vh",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "var(--font-body)",
        fontSize: 14,
      }}
    >
      <aside
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16.8,
          padding: "16.8px 11.2px",
          borderRight: "1px solid var(--color-divider)",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8.4, padding: "0 8.4px 8.4px" }}>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 8,
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              fontSize: 15,
            }}
          >
            <i className="ph ph-shield-checkered" />
          </span>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <strong style={{ fontWeight: 500, fontSize: 15, letterSpacing: "-0.01em" }}>Console SELinux</strong>
            <span
              style={{
                fontSize: 10,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--color-neutral-500)",
              }}
            >
              {t("brand.subtitle")}
            </span>
          </span>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2.8 }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => "btn " + (isActive ? "btn-primary" : "btn-ghost")}
              style={{ justifyContent: "flex-start", gap: 8.4 }}
            >
              <i className={`ph ${item.icon}`} style={{ fontSize: 16 }} />
              <span style={{ flex: 1, textAlign: "left" }}>{t(item.key)}</span>
            </NavLink>
          ))}
        </nav>

        <select
          className="input"
          style={{ marginTop: "auto" }}
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          aria-label="Language"
        >
          {locales.map((l) => (
            <option key={l} value={l}>
              {localeLabels[l]}
            </option>
          ))}
        </select>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22.4px 44px" }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/", icon: "ph-gauge", label: "Dashboard", end: true },
  { to: "/agents", icon: "ph-desktop-tower", label: "Agents" },
  { to: "/denials", icon: "ph-warning-octagon", label: "Denials" },
  { to: "/deployments", icon: "ph-upload-simple", label: "Déploiements" },
  { to: "/compliance", icon: "ph-shield-check", label: "Conformité" },
  { to: "/alerts", icon: "ph-bell", label: "Alertes" },
];

export function Layout() {
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
              Fleet control
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
              <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22.4px 44px" }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Agent } from "../lib/api";
import { DeployRuleDialog } from "../components/DeployRuleDialog";

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingPermissive, setSettingPermissive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setAgents((await api.listAgents()) ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = agents.length > 0 && agents.every((a) => selected.has(a.id));
  const toggleAllVisible = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(agents.map((a) => a.id)));
  };

  const setPermissiveSelection = async () => {
    setSettingPermissive(true);
    try {
      await api.deployRule(
        {
          name: "Passer en permissive",
          type: "set_mode",
          payload_json: JSON.stringify({ mode: "permissive" }),
          agent_ids: Array.from(selected),
        },
        crypto.randomUUID(),
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSettingPermissive(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
      {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11.2,
          padding: "8.4px 11.2px",
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--color-neutral-400)" }}>
          {selected.size === 0 ? "Aucune sélection" : `${selected.size} sélectionné(s)`}
        </span>
        <button type="button" className="btn btn-secondary" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          Vider
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={selected.size === 0 || settingPermissive}
          onClick={setPermissiveSelection}
        >
          <i className="ph ph-eye" style={{ fontSize: 14 }} />
          {settingPermissive ? "…" : "Passer en permissive"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={selected.size === 0}
          style={{ marginLeft: "auto" }}
          onClick={() => setDialogOpen(true)}
        >
          <i className="ph ph-upload-simple" style={{ fontSize: 14 }} />
          Déployer une règle
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 34 }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
            </th>
            <th>Hôte</th>
            <th>Mode</th>
            <th>OS / noyau</th>
            <th>Politique</th>
            <th>Vu</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
              </td>
              <td>
                <Link to={`/agents/${a.id}`} style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: a.connected ? "var(--color-accent)" : "var(--color-neutral-700)",
                    }}
                  />
                  <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
                    <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13 }}>{a.hostname}</span>
                    <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>{a.ip}</span>
                  </span>
                </Link>
              </td>
              <td>
                <span className={modeTagClass(a.mode)}>{a.mode}</span>
              </td>
              <td style={{ fontSize: 12.5, color: "var(--color-neutral-400)" }}>
                {a.os_release} / {a.kernel_version}
              </td>
              <td style={{ fontSize: 12.5 }}>
                {a.policy_name}
                {a.policy_version ? ` (${a.policy_version})` : ""}
              </td>
              <td style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
                {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "jamais"}
              </td>
              <td style={{ textAlign: "right" }}>
                <Link to={`/agents/${a.id}`} className="btn btn-ghost">
                  Ouvrir
                </Link>
              </td>
            </tr>
          ))}
          {agents.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "var(--color-neutral-500)" }}>
                Aucun agent enrôlé pour l'instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>

      {dialogOpen && (
        <DeployRuleDialog
          agentIds={Array.from(selected)}
          onClose={() => setDialogOpen(false)}
          onDeployed={async () => {
            setDialogOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function modeTagClass(mode: string): string {
  switch (mode) {
    case "enforcing":
      return "tag tag-accent";
    case "permissive":
      return "tag tag-outline";
    default:
      return "tag tag-neutral";
  }
}

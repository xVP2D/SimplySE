import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Agent, type AvcEventHit } from "../lib/api";
import { DeployRuleDialog } from "../components/DeployRuleDialog";

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [denials, setDenials] = useState<AvcEventHit[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!id) return;
    try {
      const [detail, denialsResult] = await Promise.all([api.getAgent(id), api.listDenials({ agentId: id, limit: 50 })]);
      setAgent({ ...detail.agent, connected: detail.connected });
      setDenials(denialsResult.events ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <div style={{ color: "var(--color-accent-300)" }}>{error}</div>;
  if (!agent) return <p style={{ color: "var(--color-neutral-500)" }}>Chargement…</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16.8 }}>
      <Link to="/agents" className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>
        <i className="ph ph-arrow-left" style={{ fontSize: 14 }} />
        Inventaire
      </Link>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 11.2,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: agent.connected ? "var(--color-accent)" : "var(--color-neutral-700)",
            }}
          />
          <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 16 }}>{agent.hostname}</span>
          <span className="tag tag-neutral" style={{ marginLeft: "auto" }}>
            agent {agent.agent_version || "?"}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8.4, fontSize: 12.5 }}>
          <Field label="Adresse" value={agent.ip} />
          <Field label="Statut" value={agent.status} />
          <Field label="OS / noyau" value={`${agent.os_release} / ${agent.kernel_version}`} />
          <Field label="Mode" value={agent.mode} />
          <Field label="Politique" value={`${agent.policy_name} ${agent.policy_version}`.trim()} />
          <Field label="Vu la dernière fois" value={agent.last_seen_at ? new Date(agent.last_seen_at).toLocaleString() : "jamais"} />
        </div>
        <button type="button" className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={() => setDialogOpen(true)}>
          <i className="ph ph-upload-simple" style={{ fontSize: 14 }} />
          Déployer une règle sur cet agent
        </button>
      </section>

      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8.4,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h5 style={{ margin: 0, fontSize: 15 }}>Denials récents</h5>
          <Link to={`/denials?agent=${agent.id}`} className="btn btn-ghost">
            Tout voir
          </Link>
        </div>
        <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Horodatage</th>
              <th>Source → cible</th>
              <th>Classe / perm</th>
              <th>Commande</th>
              <th>Chemin</th>
            </tr>
          </thead>
          <tbody>
            {denials.map((d, i) => (
              <tr key={i}>
                <td style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{new Date(d.timestamp).toLocaleTimeString()}</td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 }}>
                  {d.scontext} → {d.tcontext}
                </td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-neutral-400)" }}>
                  {d.tclass} · {d.perms.join(",")}
                </td>
                <td style={{ fontSize: 12.5 }}>{d.comm}</td>
                <td style={{ fontSize: 12.5, color: "var(--color-neutral-400)" }}>{d.path}</td>
              </tr>
            ))}
            {denials.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--color-neutral-500)" }}>
                  Aucun denial observé pour cet agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </section>

      {dialogOpen && (
        <DeployRuleDialog
          agentIds={[agent.id]}
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ color: "var(--color-neutral-600)", fontSize: 11 }}>{label}</span>
      {value}
    </span>
  );
}

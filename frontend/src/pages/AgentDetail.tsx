import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Agent, type AvcEventHit, type Command, type SelinuxState } from "../lib/api";
import { DeployRuleDialog } from "../components/DeployRuleDialog";
import { formatPayload, statusTagClass } from "../lib/commandFormat";
import { randomUUID } from "../lib/uuid";

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [denials, setDenials] = useState<AvcEventHit[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [selinuxState, setSelinuxState] = useState<SelinuxState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedDenial, setExpandedDenial] = useState<number | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [switchingBoolean, setSwitchingBoolean] = useState<string | null>(null);
  const [booleanFilter, setBooleanFilter] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!id) return;
    try {
      const [detail, denialsResult, commandsResult, selinuxResult] = await Promise.all([
        api.getAgent(id),
        api.listDenials({ agentId: id, limit: 50 }),
        api.recentCommands({ agentId: id, limit: 20 }),
        api.getAgentSelinux(id),
      ]);
      setAgent({ ...detail.agent, connected: detail.connected });
      setDenials(denialsResult.events ?? []);
      setCommands(commandsResult.commands ?? []);
      setSelinuxState(selinuxResult);
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

  const switchMode = async (mode: "enforcing" | "permissive") => {
    if (!agent || mode === agent.mode) return;
    if (!window.confirm(`Passer ${agent.hostname} en mode ${mode} ?`)) return;
    setSwitchingMode(true);
    try {
      await api.deployRule(
        { name: `Passer en ${mode}`, type: "set_mode", payload_json: JSON.stringify({ mode }), agent_ids: [agent.id] },
        randomUUID(),
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSwitchingMode(false);
    }
  };

  const toggleBoolean = async (b: { name: string; value: boolean }) => {
    if (!agent) return;
    const newValue = !b.value;
    if (!window.confirm(`Passer le booléen ${b.name} à ${newValue ? "on" : "off"} sur ${agent.hostname} ?`)) return;
    setSwitchingBoolean(b.name);
    try {
      await api.deployRule(
        {
          name: `Booléen ${b.name} = ${newValue}`,
          type: "set_boolean",
          payload_json: JSON.stringify({ name: b.name, value: newValue }),
          agent_ids: [agent.id],
        },
        randomUUID(),
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSwitchingBoolean(null);
    }
  };

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
          <span style={{ display: "flex", flexDirection: "column", gap: 3.5 }}>
            <span style={{ color: "var(--color-neutral-600)", fontSize: 11 }}>Mode</span>
            <div className="seg" style={{ width: "fit-content" }}>
              <label
                className="seg-opt"
                style={agent.mode === "enforcing" ? { color: "var(--color-accent)" } : undefined}
              >
                <input
                  type="radio"
                  name="agent-mode"
                  disabled={switchingMode}
                  checked={agent.mode === "enforcing"}
                  onChange={() => switchMode("enforcing")}
                />
                enforcing
              </label>
              <label
                className="seg-opt"
                style={agent.mode === "permissive" ? { color: "var(--color-accent)" } : undefined}
              >
                <input
                  type="radio"
                  name="agent-mode"
                  disabled={switchingMode}
                  checked={agent.mode === "permissive"}
                  onChange={() => switchMode("permissive")}
                />
                permissive
              </label>
            </div>
          </span>
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
          <h5 style={{ margin: 0, fontSize: 15 }}>Règles appliquées</h5>
          <Link to={`/deployments?agent=${agent.id}`} className="btn btn-ghost">
            Tout voir
          </Link>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Paramètres</th>
                <th>Statut</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontSize: 12, color: "var(--color-neutral-500)", whiteSpace: "nowrap" }}>
                    {new Date(c.created_at).toLocaleString()}
                  </td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, whiteSpace: "nowrap" }}>{c.type}</td>
                  <td
                    style={{
                      fontFamily: "ui-monospace,Menlo,monospace",
                      fontSize: 12,
                      color: "var(--color-neutral-400)",
                      maxWidth: 260,
                      wordBreak: "break-word",
                    }}
                  >
                    {formatPayload(c.payload_json)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className={statusTagClass(c.status)}>{c.status}</span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--color-neutral-500)", maxWidth: 260, wordBreak: "break-word" }}>
                    {c.result_message}
                  </td>
                </tr>
              ))}
              {commands.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: "var(--color-neutral-500)" }}>
                    Aucune règle déployée sur cet agent pour l'instant.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8.4 }}>
          <h5 style={{ margin: 0, fontSize: 15 }}>
            Booléens SELinux{" "}
            <span className="tag tag-neutral" style={{ marginLeft: 4.2 }}>
              {selinuxState?.booleans.length ?? 0}
            </span>
          </h5>
          <div style={{ display: "flex", alignItems: "center", gap: 8.4 }}>
            {selinuxState?.collected_at && (
              <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
                relevé {new Date(selinuxState.collected_at).toLocaleString()}
              </span>
            )}
            <input
              className="input"
              placeholder="Filtrer…"
              style={{ width: 180 }}
              value={booleanFilter}
              onChange={(e) => setBooleanFilter(e.target.value)}
            />
          </div>
        </div>
        <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Valeur</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(selinuxState?.booleans ?? [])
                .filter((b) => b.name.toLowerCase().includes(booleanFilter.toLowerCase()))
                .map((b) => (
                  <tr key={b.name}>
                    <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{b.name}</td>
                    <td>
                      <span className={b.value ? "tag tag-accent" : "tag tag-neutral"}>{b.value ? "on" : "off"}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={switchingBoolean === b.name}
                        onClick={() => toggleBoolean(b)}
                      >
                        Basculer
                      </button>
                    </td>
                  </tr>
                ))}
              {selinuxState && selinuxState.booleans.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--color-neutral-500)" }}>
                    Aucune donnée pour l'instant — envoyée automatiquement par l'agent après connexion.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8.4 }}>
          <h5 style={{ margin: 0, fontSize: 15 }}>
            Modules de policy{" "}
            <span className="tag tag-neutral" style={{ marginLeft: 4.2 }}>
              {selinuxState?.modules.length ?? 0}
            </span>
          </h5>
          <input
            className="input"
            placeholder="Filtrer…"
            style={{ width: 180 }}
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
          />
        </div>
        <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Version</th>
              </tr>
            </thead>
            <tbody>
              {(selinuxState?.modules ?? [])
                .filter((m) => m.name.toLowerCase().includes(moduleFilter.toLowerCase()))
                .map((m) => (
                  <tr key={m.name}>
                    <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{m.name}</td>
                    <td style={{ fontSize: 12, color: "var(--color-neutral-400)" }}>{m.version || "—"}</td>
                  </tr>
                ))}
              {selinuxState && selinuxState.modules.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ color: "var(--color-neutral-500)" }}>
                    Aucune donnée pour l'instant — envoyée automatiquement par l'agent après connexion.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
          <h5 style={{ margin: 0, fontSize: 15 }}>Logs / denials récents</h5>
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
              <th>PID</th>
              <th>Chemin</th>
            </tr>
          </thead>
          <tbody>
            {denials.map((d, i) => (
              <>
                <tr
                  key={i}
                  style={{ cursor: "pointer" }}
                  onClick={() => setExpandedDenial(expandedDenial === i ? null : i)}
                >
                  <td style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{new Date(d.timestamp).toLocaleTimeString()}</td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 }}>
                    {d.scontext} → {d.tcontext}
                  </td>
                  <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-neutral-400)" }}>
                    {d.tclass} · {d.perms.join(",")}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{d.comm}</td>
                  <td style={{ fontSize: 12, color: "var(--color-neutral-400)" }}>{d.pid}</td>
                  <td style={{ fontSize: 12.5, color: "var(--color-neutral-400)" }}>{d.path}</td>
                </tr>
                {expandedDenial === i && (
                  <tr key={`${i}-raw`}>
                    <td
                      colSpan={6}
                      style={{
                        fontFamily: "ui-monospace,Menlo,monospace",
                        fontSize: 11.5,
                        color: "var(--color-neutral-400)",
                        background: "var(--color-neutral-900, rgba(0,0,0,0.15))",
                        wordBreak: "break-all",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {d.raw_line}
                    </td>
                  </tr>
                )}
              </>
            ))}
            {denials.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--color-neutral-500)" }}>
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

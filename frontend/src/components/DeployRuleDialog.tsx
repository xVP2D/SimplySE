import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { randomUUID } from "../lib/uuid";

type RuleKind = "set_mode" | "set_boolean" | "chcon";

export function DeployRuleDialog({
  agentIds,
  onClose,
  onDeployed,
}: {
  agentIds: string[];
  onClose: () => void;
  onDeployed: () => void;
}) {
  const [kind, setKind] = useState<RuleKind>("set_mode");
  const [mode, setMode] = useState<"enforcing" | "permissive">("permissive");
  const [boolName, setBoolName] = useState("");
  const [boolValue, setBoolValue] = useState(true);
  const [chconPath, setChconPath] = useState("");
  const [chconType, setChconType] = useState("");
  const [chconRecursive, setChconRecursive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable across retries of the *same* configured request (e.g. the user
  // clicking "Déployer" again after a network timeout left the first
  // attempt's outcome ambiguous), but regenerated as soon as they change
  // any field — that's a genuinely different request.
  const idempotencyKey = useMemo(
    () => randomUUID(),
    [kind, mode, boolName, boolValue, chconPath, chconType, chconRecursive, agentIds.join(",")],
  );

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      let payloadJson: string;
      let name: string;
      if (kind === "set_mode") {
        payloadJson = JSON.stringify({ mode });
        name = `Passer en ${mode}`;
      } else if (kind === "set_boolean") {
        payloadJson = JSON.stringify({ name: boolName, value: boolValue });
        name = `Booléen ${boolName} = ${boolValue}`;
      } else {
        payloadJson = JSON.stringify({ path: chconPath, type: chconType, recursive: chconRecursive });
        name = `chcon ${chconType} sur ${chconPath}`;
      }
      await api.deployRule({ name, type: kind, payload_json: payloadJson, agent_ids: agentIds }, idempotencyKey);
      onDeployed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center" }}
      onClick={onClose}
    >
      <div className="dialog" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h4 className="dialog-title">Déployer une règle</h4>
        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
          <p style={{ margin: 0 }}>
            Cible : <strong>{agentIds.length}</strong> agent{agentIds.length > 1 ? "s" : ""}
          </p>

          <div className="seg">
            <label className="seg-opt" style={kind === "set_mode" ? { color: "var(--color-accent)" } : undefined}>
              <input type="radio" name="kind" checked={kind === "set_mode"} onChange={() => setKind("set_mode")} />
              Mode SELinux
            </label>
            <label className="seg-opt" style={kind === "set_boolean" ? { color: "var(--color-accent)" } : undefined}>
              <input
                type="radio"
                name="kind"
                checked={kind === "set_boolean"}
                onChange={() => setKind("set_boolean")}
              />
              Booléen
            </label>
            <label className="seg-opt" style={kind === "chcon" ? { color: "var(--color-accent)" } : undefined}>
              <input type="radio" name="kind" checked={kind === "chcon"} onChange={() => setKind("chcon")} />
              Contexte fichier
            </label>
          </div>

          {kind === "set_mode" && (
            <div className="seg">
              <label className="seg-opt">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "enforcing"}
                  onChange={() => setMode("enforcing")}
                />
                enforcing
              </label>
              <label className="seg-opt">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "permissive"}
                  onChange={() => setMode("permissive")}
                />
                permissive
              </label>
            </div>
          )}

          {kind === "set_boolean" && (
            <>
              <div className="field">
                <label>Nom du booléen</label>
                <input
                  className="input"
                  placeholder="httpd_can_network_connect"
                  value={boolName}
                  onChange={(e) => setBoolName(e.target.value)}
                />
              </div>
              <div className="seg">
                <label className="seg-opt">
                  <input type="radio" name="boolvalue" checked={boolValue} onChange={() => setBoolValue(true)} />
                  on
                </label>
                <label className="seg-opt">
                  <input type="radio" name="boolvalue" checked={!boolValue} onChange={() => setBoolValue(false)} />
                  off
                </label>
              </div>
            </>
          )}

          {kind === "chcon" && (
            <>
              <div className="field">
                <label>Chemin du fichier</label>
                <input
                  className="input"
                  placeholder="/var/www/html/index.html"
                  value={chconPath}
                  onChange={(e) => setChconPath(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Type de contexte</label>
                <input
                  className="input"
                  placeholder="httpd_sys_content_t"
                  value={chconType}
                  onChange={(e) => setChconType(e.target.value)}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8.4, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={chconRecursive}
                  onChange={(e) => setChconRecursive(e.target.checked)}
                />
                Récursif (-R)
              </label>
            </>
          )}

          {error && <p style={{ color: "var(--color-accent-300)", margin: 0 }}>{error}</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              submitting ||
              (kind === "set_boolean" && boolName.trim() === "") ||
              (kind === "chcon" && (chconPath.trim() === "" || chconType.trim() === ""))
            }
            onClick={submit}
          >
            {submitting ? "Déploiement…" : "Déployer"}
          </button>
        </div>
      </div>
    </div>
  );
}

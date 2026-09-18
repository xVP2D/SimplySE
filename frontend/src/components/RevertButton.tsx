import { useState } from "react";
import { api, type Command } from "../lib/api";
import { useTranslation } from "../i18n";

// The Delete button on an applied rule. What it does depends on the server's
// verdict for that command (see master/internal/server/revert.go):
//   machine -> really undoes the rule on the agent, entry leaves once it confirms
//   record  -> nothing was applied (failed/pending), just removes the entry
//   none    -> disabled, with the reason as tooltip
export function RevertButton({ command, host, onChanged }: { command: Command; host: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (command.revert_pending) {
    return <span className="tag tag-accent-2">{t("revert.inProgress")}</span>;
  }

  if (command.revert === "none") {
    return (
      <button type="button" className="btn btn-ghost" disabled title={t(`revert.reason.${command.revert_reason ?? "unknown_previous"}`)}>
        {t("revert.delete")}
      </button>
    );
  }

  const click = async () => {
    const question =
      command.revert === "machine"
        ? t("revert.confirmMachine", { host, action: command.revert_action ?? "" })
        : t("revert.confirmRecord");
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api.revertCommand(command.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2.8 }}>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={click}>
        {busy ? "…" : t("revert.delete")}
      </button>
      {error && <span style={{ fontSize: 11, color: "var(--color-accent-300)", maxWidth: 220, textAlign: "right" }}>{error}</span>}
    </div>
  );
}

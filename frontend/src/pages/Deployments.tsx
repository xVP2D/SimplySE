import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Agent, type Command } from "../lib/api";
import { formatPayload, statusTagClass } from "../lib/commandFormat";
import { useTranslation } from "../i18n";

const PAGE_SIZE = 20;

const STATUSES = ["pending", "sent", "acked", "failed"];

export function Deployments() {
  const { t, locale } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agent") ?? "";
  const status = searchParams.get("status") ?? "";

  const [offset, setOffset] = useState(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsByID = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    setOffset(0);
  }, [agentId, status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .recentCommands({ agentId: agentId || undefined, status: status || undefined, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setCommands(result.commands ?? []);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, status, offset]);

  const setFilter = (key: "agent" | "status", value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11.2,
          flexWrap: "wrap",
          padding: "8.4px 11.2px",
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <select className="input" style={{ width: 220 }} value={agentId} onChange={(e) => setFilter("agent", e.target.value)}>
          <option value="">{t("common.allAgents")}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname || a.id}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 160 }} value={status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">{t("deployments.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>
          {loading ? t("common.loading") : total > 0 ? t("common.resultsRange", { from, to, total }) : t("common.noResults")}
        </span>
      </div>

      {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

      <div style={{ overflowX: "auto", borderRadius: 8, background: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t("common.columns.date")}</th>
              <th>{t("common.columns.agent")}</th>
              <th>{t("common.columns.type")}</th>
              <th>{t("common.columns.parameters")}</th>
              <th>{t("common.columns.status")}</th>
              <th>{t("common.columns.message")}</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((c) => (
              <tr key={c.id}>
                <td style={{ fontSize: 12, color: "var(--color-neutral-500)", whiteSpace: "nowrap" }}>
                  {new Date(c.created_at).toLocaleString(locale)}
                </td>
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                  <Link to={`/agents/${c.agent_id}`}>{agentsByID.get(c.agent_id)?.hostname || c.agent_id}</Link>
                </td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, whiteSpace: "nowrap" }}>{c.type}</td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-neutral-400)", maxWidth: 260 }}>
                  <div style={{ maxHeight: 90, overflowY: "auto", wordBreak: "break-all" }}>{formatPayload(c.payload_json)}</div>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className={statusTagClass(c.status)}>{c.status}</span>
                </td>
                <td style={{ fontSize: 12, color: "var(--color-neutral-500)", maxWidth: 320 }}>
                  <div style={{ maxHeight: 90, overflowY: "auto", wordBreak: "break-all" }}>{c.result_message}</div>
                </td>
              </tr>
            ))}
            {commands.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ color: "var(--color-neutral-500)" }}>
                  {t("deployments.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8.4 }}>
        <button type="button" className="btn btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          {t("common.previous")}
        </button>
        <button type="button" className="btn btn-secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
          {t("common.next")}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Agent, type AvcEventHit } from "../lib/api";
import { useTranslation } from "../i18n";
import { explainDenial } from "../lib/explainDenial";

const PAGE_SIZE = 25;

export function Denials() {
  const { t, locale } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agent") ?? "";
  const queryParam = searchParams.get("q") ?? "";

  const [queryInput, setQueryInput] = useState(queryParam);
  const [offset, setOffset] = useState(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [events, setEvents] = useState<AvcEventHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsByID = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    setOffset(0);
  }, [agentId, queryParam]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listDenials({ agentId: agentId || undefined, query: queryParam || undefined, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setEvents(result.events ?? []);
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
  }, [agentId, queryParam, offset]);

  // Debounce the free-text search before it becomes a URL param / API call.
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const onQueryInputChange = (value: string) => {
    setQueryInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      });
    }, 300);
  };

  const onAgentFilterChange = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("agent", value);
      else next.delete("agent");
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
        <input
          className="input"
          style={{ minWidth: 220 }}
          placeholder={t("denials.searchPlaceholder")}
          value={queryInput}
          onChange={(e) => onQueryInputChange(e.target.value)}
        />
        <select className="input" style={{ width: 220 }} value={agentId} onChange={(e) => onAgentFilterChange(e.target.value)}>
          <option value="">{t("common.allAgents")}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname || a.id}
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
              <th>{t("common.columns.timestamp")}</th>
              <th>{t("common.columns.agent")}</th>
              <th>{t("common.columns.sourceTarget")}</th>
              <th>{t("common.columns.classPerm")}</th>
              <th>{t("common.columns.command")}</th>
              <th>{t("common.columns.path")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((d, i) => (
              <tr key={i}>
                <td style={{ fontSize: 12, color: "var(--color-neutral-500)", whiteSpace: "nowrap" }}>
                  {new Date(d.timestamp).toLocaleString(locale)}
                </td>
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                  <Link to={`/agents/${d.agent_id}`}>{agentsByID.get(d.agent_id)?.hostname || d.agent_id}</Link>
                </td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, maxWidth: 280, wordBreak: "break-word" }}>
                  <div>
                    {d.scontext} → {d.tcontext}
                  </div>
                  <div style={{ fontFamily: "var(--font-body, inherit)", fontSize: 11, color: "var(--color-neutral-500)", marginTop: 2 }}>
                    {explainDenial(d, locale)}
                  </div>
                </td>
                <td style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "var(--color-neutral-400)" }}>
                  {d.tclass} · {d.perms.join(",")}
                </td>
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{d.comm}</td>
                <td style={{ fontSize: 12.5, color: "var(--color-neutral-400)", maxWidth: 300, wordBreak: "break-word" }}>
                  {d.path}
                </td>
              </tr>
            ))}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={6} style={{ color: "var(--color-neutral-500)" }}>
                  {t("denials.empty")}
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

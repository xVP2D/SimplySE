import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Agent, type SuggestedModule } from "../lib/api";
import { useTranslation } from "../i18n";

const PAGE_SIZE = 20;
const STATUSES = ["pending", "approved", "rejected", "failed", "generating"];

function statusTagClass(status: string): string {
  switch (status) {
    case "approved":
      return "tag tag-accent";
    case "rejected":
      return "tag tag-outline";
    case "failed":
      return "tag tag-outline";
    case "pending":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}

export function Suggestions() {
  const { t, locale } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "pending";

  const [offset, setOffset] = useState(0);
  const [modules, setModules] = useState<SuggestedModule[]>([]);
  const [total, setTotal] = useState(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<SuggestedModule | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    setOffset(0);
  }, [status]);

  const load = () => {
    setLoading(true);
    api
      .listSuggestedModules({ status: status || undefined, offset, limit: PAGE_SIZE })
      .then((result) => {
        setModules(result.modules ?? []);
        setTotal(result.total);
        setError(null);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, offset]);

  const setStatusFilter = (value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("status", value);
      else next.delete("status");
      return next;
    });
  };

  const toggleExpand = async (m: SuggestedModule) => {
    if (expanded === m.id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(m.id);
    setSelectedAgents(new Set([m.agent_id]));
    try {
      setDetail(await api.getSuggestedModule(m.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleAgent = (id: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const approve = async (id: string) => {
    if (selectedAgents.size === 0) return;
    if (
      !window.confirm(
        t("suggestions.confirmApprove", { count: selectedAgents.size }),
      )
    )
      return;
    setBusy(true);
    try {
      await api.approveSuggestedModule(id, Array.from(selectedAgents));
      setExpanded(null);
      setDetail(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    if (!window.confirm(t("suggestions.confirmReject"))) return;
    setBusy(true);
    try {
      await api.rejectSuggestedModule(id);
      setExpanded(null);
      setDetail(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("suggestions.explainer")}</p>

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
        <select className="input" style={{ width: 180 }} value={status} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t("suggestions.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`suggestions.status.${s}`)}
            </option>
          ))}
        </select>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>
          {loading ? t("common.loading") : total > 0 ? t("common.resultsRange", { from, to, total }) : t("common.noResults")}
        </span>
      </div>

      {error && <div style={{ color: "var(--color-accent-300)", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8.4 }}>
        {modules.map((m) => (
          <div
            key={m.id}
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
            <div style={{ display: "flex", alignItems: "center", gap: 11.2, cursor: "pointer" }} onClick={() => toggleExpand(m)}>
              <span className={statusTagClass(m.status)}>{t(`suggestions.status.${m.status}`)}</span>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 }}>{m.module_name}</span>
              <span style={{ fontSize: 12, color: "var(--color-neutral-500)", flex: 1 }}>
                {m.scontext} → {m.tcontext} ({m.tclass})
              </span>
              <Link to={`/agents/${m.agent_id}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 12 }}>
                {m.agent_id}
              </Link>
              <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>{new Date(m.created_at).toLocaleString(locale)}</span>
            </div>

            {expanded === m.id && detail && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8.4, borderTop: "1px solid var(--color-divider)", paddingTop: 8.4 }}>
                {detail.status === "failed" && (
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-accent-300)" }}>{detail.error_message}</p>
                )}
                {detail.te_text && (
                  <pre
                    style={{
                      margin: 0,
                      fontFamily: "ui-monospace,Menlo,monospace",
                      fontSize: 12,
                      color: "var(--color-neutral-300)",
                      background: "var(--color-neutral-900, rgba(0,0,0,0.15))",
                      padding: 11.2,
                      borderRadius: 6,
                      maxHeight: 300,
                      overflow: "auto",
                      whiteSpace: "pre",
                    }}
                  >
                    {detail.te_text}
                  </pre>
                )}

                {detail.status === "pending" && (
                  <>
                    <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{t("suggestions.pickAgents")}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8.4 }}>
                      {agents.map((a) => (
                        <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 4.2, fontSize: 12.5 }}>
                          <input type="checkbox" checked={selectedAgents.has(a.id)} onChange={() => toggleAgent(a.id)} />
                          {a.hostname || a.id}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8.4 }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy || selectedAgents.size === 0}
                        onClick={() => approve(m.id)}
                      >
                        {t("suggestions.approveAndDeploy")}
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => reject(m.id)}>
                        {t("suggestions.reject")}
                      </button>
                    </div>
                  </>
                )}

                {(detail.status === "approved" || detail.status === "rejected") && (
                  <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
                    {t("suggestions.reviewedMeta", {
                      date: detail.reviewed_at ? new Date(detail.reviewed_at).toLocaleString(locale) : "",
                      by: detail.reviewed_by,
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
        {modules.length === 0 && !loading && (
          <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("suggestions.empty")}</p>
        )}
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

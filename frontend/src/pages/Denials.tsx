import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Agent, type AvcEventHit } from "../lib/api";
import { useTranslation } from "../i18n";
import { explainDenial, typeFromContext } from "../lib/explainDenial";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { CollectDomainButton } from "../components/CollectDomainButton";

const PAGE_SIZE = 25;

// Same underlying rule (same agent, same scontext/tcontext/tclass/perms) is
// often hit by many raw events in a row — each retry of the same blocked
// operation logs its own AVC line. Grouping those under one row, with the
// individual occurrences tucked into a scrollable sub-list, keeps a page of
// 25 rows from being dominated by near-duplicates.
function groupKey(d: AvcEventHit): string {
  return `${d.agent_id}|${d.scontext}|${d.tcontext}|${d.tclass}|${[...d.perms].sort().join(",")}`;
}

interface DenialGroup {
  key: string;
  events: AvcEventHit[];
}

function groupEvents(events: AvcEventHit[]): DenialGroup[] {
  const byKey = new Map<string, DenialGroup>();
  const order: DenialGroup[] = [];
  for (const d of events) {
    const key = groupKey(d);
    let group = byKey.get(key);
    if (!group) {
      group = { key, events: [] };
      byKey.set(key, group);
      order.push(group);
    }
    group.events.push(d);
  }
  return order;
}

// quarantine=true renders the Quarantine page: the same table, but listing
// quarantined denials, with Restore instead of Fix/Quarantine.
export function Denials({ quarantine = false }: { quarantine?: boolean }) {
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
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Set<string>>(new Set());
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);
  const autoTick = useAutoRefresh(5000);
  const lastQuery = useRef("");
  // "agent_id|domain" of collections currently running or awaiting a
  // generate click, across every agent — disables that combo's Collect
  // button so a second run can't be started on top of it.
  const [activeCollections, setActiveCollections] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .listCollections({ limit: 100 })
      .then((list) =>
        setActiveCollections(new Set(list.filter((c) => c.status !== "done" && c.status !== "failed").map((c) => `${c.agent_id}|${c.domain}`))),
      )
      .catch(() => {});
  }, [reloadTick, autoTick]);

  const groups = useMemo(() => groupEvents(events), [events]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runGroupAction = async (key: string, evs: AvcEventHit[], action: (d: AvcEventHit) => Promise<unknown>) => {
    setBusyGroup(key);
    try {
      await Promise.all(evs.map(action));
      setReloadTick((n) => n + 1);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyGroup(null);
    }
  };

  const removeGroup = (group: DenialGroup) => {
    if (!window.confirm(t("denials.confirmDelete", { count: group.events.length }))) return;
    runGroupAction(group.key, group.events, (d) => api.deleteDenial(d));
  };

  const requestFix = async (group: DenialGroup) => {
    const d = group.events[0];
    if (!window.confirm(t("denials.confirmFix"))) return;
    setSuggesting(group.key);
    try {
      await api.suggestModuleForDenial({
        agentId: d.agent_id,
        scontext: d.scontext,
        tcontext: d.tcontext,
        tclass: d.tclass,
        rawLine: d.raw_line,
      });
      setSuggested((prev) => new Set(prev).add(group.key));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(null);
    }
  };

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
    // Only show "Loading…" when the query changed; a background refresh
    // (same query) swaps the rows in silently instead of flickering.
    const query = `${agentId}|${queryParam}|${offset}|${quarantine}`;
    if (lastQuery.current !== query) setLoading(true);
    lastQuery.current = query;
    api
      .listDenials({ agentId: agentId || undefined, query: queryParam || undefined, quarantined: quarantine, offset, limit: PAGE_SIZE })
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
  }, [agentId, queryParam, offset, quarantine, reloadTick, autoTick]);

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
      {quarantine && <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("denials.quarantineExplainer")}</p>}
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

      {error && <div style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</div>}

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
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const d = group.events[0];
              const isOpen = expanded.has(group.key);
              const busy = busyGroup === group.key;
              return (
                <Fragment key={group.key}>
                  <tr>
                    <td style={{ fontSize: 12, color: "var(--color-neutral-500)", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {group.events.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: "1px 6px", fontSize: 11 }}
                            onClick={() => toggleExpanded(group.key)}
                            title={t("denials.occurrenceCount", { count: group.events.length })}
                          >
                            {isOpen ? "▾" : "▸"} {t("denials.occurrenceCount", { count: group.events.length })}
                          </button>
                        )}
                        <span>{new Date(d.timestamp).toLocaleString(locale)}</span>
                      </div>
                    </td>
                    <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                      <Link to={`/agents/${d.agent_id}`}>{agentsByID.get(d.agent_id)?.hostname || d.agent_id}</Link>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12, maxWidth: 280, wordBreak: "break-word" }}>
                      <div>
                        {d.scontext} → {d.tcontext}
                      </div>
                      <div style={{ fontFamily: "var(--font-body, inherit)", fontSize: 11, color: "var(--color-neutral-500)", marginTop: 2 }}>
                        {explainDenial(d, locale)}
                      </div>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-neutral-400)" }}>
                      {d.tclass} · {d.perms.join(",")}
                    </td>
                    <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{d.comm}</td>
                    <td style={{ fontSize: 12.5, color: "var(--color-neutral-400)", maxWidth: 300, wordBreak: "break-word" }}>
                      {d.path}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                      {quarantine ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => runGroupAction(group.key, group.events, (e) => api.restoreDenial(e))}
                        >
                          {busy ? "…" : t("denials.restore")}
                        </button>
                      ) : (
                        <>
                          {suggested.has(group.key) ? (
                            <Link to="/suggestions" className="tag tag-accent">
                              {t("denials.fixRequested")}
                            </Link>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={suggesting === group.key}
                              onClick={() => requestFix(group)}
                            >
                              {suggesting === group.key ? "…" : t("denials.fixButton")}
                            </button>
                          )}
                          <CollectDomainButton
                            agentId={d.agent_id}
                            domain={typeFromContext(d.scontext)}
                            host={agentsByID.get(d.agent_id)?.hostname || d.agent_id}
                            disabledReason={
                              activeCollections.has(`${d.agent_id}|${typeFromContext(d.scontext)}`) ? t("collect.alreadyRunning") : undefined
                            }
                            onStarted={() => setReloadTick((n) => n + 1)}
                          />
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => runGroupAction(group.key, group.events, (e) => api.quarantineDenial(e))}
                          >
                            {busy ? "…" : t("denials.quarantine")}
                          </button>
                        </>
                      )}
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => removeGroup(group)}>
                        {busy ? "…" : t("denials.delete")}
                      </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && group.events.length > 1 && (
                    <tr>
                      <td colSpan={7} style={{ padding: 0, background: "var(--color-sunken)" }}>
                        <div style={{ maxHeight: 180, overflowY: "auto", padding: "6px 11.2px", display: "flex", flexDirection: "column", gap: 4 }}>
                          {group.events.map((e) => (
                            <div
                              key={e.id}
                              style={{
                                display: "flex",
                                gap: 11.2,
                                fontSize: 11.5,
                                color: "var(--color-neutral-500)",
                                flexWrap: "wrap",
                                borderBottom: "1px solid var(--color-divider)",
                                paddingBottom: 4,
                              }}
                            >
                              <span style={{ whiteSpace: "nowrap" }}>{new Date(e.timestamp).toLocaleString(locale)}</span>
                              <span style={{ fontFamily: "var(--font-mono)" }}>{e.comm}</span>
                              <span style={{ wordBreak: "break-word", flex: 1 }}>{e.path}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={7} style={{ color: "var(--color-neutral-500)" }}>
                  {quarantine ? t("denials.quarantineEmpty") : t("denials.empty")}
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

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Agent, type Collection, type SelinuxState } from "../lib/api";
import { useTranslation } from "../i18n";
import { ScanMachineButton } from "../components/ScanMachineButton";

const ACTIVE = new Set(["starting", "collecting", "stopping"]);

function statusTag(status: string): string {
  switch (status) {
    case "done":
      return "tag tag-accent";
    case "failed":
      return "tag tag-outline";
    case "collecting":
    case "collected":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// A full-page, live view of every "collect every denial of a domain" run
// (see CollectDomainButton) and every "scan the whole machine" run (see
// ScanMachineButton): a progress bar and countdown ticking client-side
// every second, and a distinct-denial count refreshed from the server every
// couple of seconds while a run is actually collecting.
export function Collections() {
  const { t, locale } = useTranslation();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Agent picked in the "collect everything on one agent" control below —
  // separate from any per-row filtering, this page always shows every run.
  const [scanAgentId, setScanAgentId] = useState("");
  const [scanAgentState, setScanAgentState] = useState<SelinuxState | null>(null);

  const agentsByID = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const hasActive = collections.some((c) => ACTIVE.has(c.status));
  const isCollecting = collections.some((c) => c.status === "collecting");

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (!scanAgentId) {
      setScanAgentState(null);
      return;
    }
    let cancelled = false;
    api
      .getAgentSelinux(scanAgentId)
      .then((s) => {
        if (!cancelled) setScanAgentState(s);
      })
      .catch(() => {
        if (!cancelled) setScanAgentState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scanAgentId]);

  const load = () => {
    api
      .listCollections({ limit: 50 })
      .then((list) => {
        setCollections(list);
        setError(null);
      })
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, hasActive ? 2000 : 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  // Countdown/progress bar tick independently of the server poll above, so
  // the bar moves smoothly every second instead of jumping every 2-8s.
  useEffect(() => {
    if (!isCollecting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isCollecting]);

  const stop = async (id: string) => {
    setBusyId(id);
    try {
      await api.stopCollection(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const generate = async (id: string) => {
    setBusyId(id);
    try {
      await api.generateCollectionSuggestion(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const stopAll = async (scanId: string) => {
    setBusyId(scanId);
    try {
      await api.stopScan(scanId);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const generateAll = async (ids: string[]) => {
    setBusyId(ids[0]);
    try {
      await Promise.allSettled(ids.map((id) => api.generateCollectionSuggestion(id)));
      load();
    } finally {
      setBusyId(null);
    }
  };

  // One block per scan_id (in first-seen order), everything else standalone.
  type Block = { key: string; scanId?: string; rows: Collection[] };
  const blocks = useMemo(() => {
    const list: Block[] = [];
    const byKey = new Map<string, Block>();
    for (const c of collections) {
      const key = c.scan_id ? `scan:${c.scan_id}` : `solo:${c.id}`;
      let block = byKey.get(key);
      if (!block) {
        block = { key, scanId: c.scan_id, rows: [] };
        byKey.set(key, block);
        list.push(block);
      }
      block.rows.push(c);
    }
    return list;
  }, [collections]);

  const renderRow = (c: Collection) => {
    const durationMs = c.duration_secs * 1000;
    const startedMs = c.collecting_since ? new Date(c.collecting_since).getTime() : NaN;
    const elapsedMs = c.status === "collecting" && !Number.isNaN(startedMs) ? Math.max(0, now - startedMs) : durationMs;
    const pct = durationMs > 0 ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;
    const remainingSecs = Math.max(0, (durationMs - elapsedMs) / 1000);

    return (
      <div
        key={c.id}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 14,
          borderRadius: 8,
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11.2, flexWrap: "wrap" }}>
          <span className={statusTag(c.status)}>{t(`collect.status.${c.status}`)}</span>
          <Link to={`/agents/${c.agent_id}`} style={{ fontSize: 12.5 }}>
            {agentsByID.get(c.agent_id)?.hostname || c.agent_id}
          </Link>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{c.domain}</span>
          <span style={{ fontSize: 11, color: "var(--color-neutral-600)" }}>
            {new Date(c.started_at).toLocaleString(locale)} · {c.created_by}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8.4 }}>
            {ACTIVE.has(c.status) && (
              <button type="button" className="btn btn-ghost" disabled={busyId === c.id} onClick={() => stop(c.id)}>
                {busyId === c.id ? "…" : t("collect.stopButton")}
              </button>
            )}
            {c.status === "collected" && (
              <button type="button" className="btn btn-primary" disabled={busyId === c.id} onClick={() => generate(c.id)}>
                {busyId === c.id ? "…" : t("collect.generateButton")}
              </button>
            )}
            {c.status === "done" && c.suggestion_id && (
              <Link to="/suggestions" className="tag tag-accent">
                {t("collect.viewSuggestion")}
              </Link>
            )}
          </div>
        </div>

        {c.status === "collecting" && (
          <>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "var(--color-sunken)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: "var(--color-accent)",
                  transition: "width 1s linear",
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
              {t("collect.remaining", { time: formatMMSS(remainingSecs) })} · {t("collect.liveCount", { count: c.lines_count })}
            </span>
          </>
        )}
        {c.status === "starting" && <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{t("collect.starting")}</span>}
        {c.status === "stopping" && <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{t("collect.stoppingNote")}</span>}
        {(c.status === "collected" || c.status === "done") && (
          <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{t("collect.linesCollected", { count: c.lines_count })}</span>
        )}
        {c.status === "failed" && c.message && <span style={{ fontSize: 12, color: "var(--color-danger)" }}>{c.message}</span>}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11.2 }}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("collect.pageExplainer")}</p>

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
        <span style={{ fontSize: 12.5, color: "var(--color-neutral-500)" }}>{t("collect.scanSectionLabel")}</span>
        <select className="input" style={{ width: 220 }} value={scanAgentId} onChange={(e) => setScanAgentId(e.target.value)}>
          <option value="">{t("collect.chooseAgent")}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.hostname || a.id}
            </option>
          ))}
        </select>
        {scanAgentId && (
          <ScanMachineButton
            agentId={scanAgentId}
            host={agentsByID.get(scanAgentId)?.hostname || scanAgentId}
            domainCount={scanAgentState?.domains.length ?? 0}
            onStarted={load}
          />
        )}
      </div>

      {error && <div style={{ color: "var(--color-danger)", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8.4 }}>
        {blocks.map((b) => {
          if (!b.scanId) return renderRow(b.rows[0]);
          const scanId = b.scanId;
          const hasActiveMember = b.rows.some((c) => ACTIVE.has(c.status));
          const readyIds = b.rows.filter((c) => c.status === "collected").map((c) => c.id);
          const busyGroup = busyId === scanId;
          return (
            <div
              key={b.key}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 8.4,
                borderRadius: 8,
                background: "var(--color-sunken)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8.4, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                  <i className="ph ph-radar" /> {t("scan.groupTitle", { count: b.rows.length })}
                </span>
                <span style={{ display: "flex", gap: 6.4 }}>
                  {hasActiveMember && (
                    <button type="button" className="btn btn-ghost" disabled={busyGroup} onClick={() => stopAll(scanId)}>
                      {busyGroup ? "…" : t("scan.stopAllButton")}
                    </button>
                  )}
                  {readyIds.length > 0 && (
                    <button type="button" className="btn btn-ghost" disabled={busyGroup} onClick={() => generateAll(readyIds)}>
                      {busyGroup ? "…" : t("scan.generateAllButton", { count: readyIds.length })}
                    </button>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8.4, paddingLeft: 4.8 }}>{b.rows.map(renderRow)}</div>
            </div>
          );
        })}
        {collections.length === 0 && <p style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>{t("collect.pageEmpty")}</p>}
      </div>
    </div>
  );
}

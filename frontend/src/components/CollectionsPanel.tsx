import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, type Collection } from "../lib/api";
import { useTranslation } from "../i18n";

const ACTIVE = new Set(["starting", "collecting", "stopping"]);

function statusTag(status: string): string {
  switch (status) {
    case "done":
      return "tag tag-accent";
    case "failed":
      return "tag tag-outline";
    case "collecting":
      return "tag tag-accent-2";
    case "collected":
      return "tag tag-accent-2";
    default:
      return "tag tag-neutral";
  }
}

// Shows this agent's "collect every denial of a domain" runs (see
// CollectDomainButton) so an operator can see one in progress (and stop it
// early) and find the suggestion it produced.
export function CollectionsPanel({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const { t, locale } = useTranslation();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    api
      .listCollections({ agentId, limit: 10 })
      .then(setCollections)
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const hasActive = collections.some((c) => ACTIVE.has(c.status));
    const interval = setInterval(load, hasActive ? 3000 : 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, refreshKey, collections.some((c) => ACTIVE.has(c.status))]);

  const stop = async (id: string) => {
    setBusyId(id);
    try {
      await api.stopCollection(id);
      load();
    } finally {
      setBusyId(null);
    }
  };

  const generate = async (id: string) => {
    setBusyId(id);
    try {
      await api.generateCollectionSuggestion(id);
      load();
    } finally {
      setBusyId(null);
    }
  };

  if (collections.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8.4px 0",
        borderTop: "1px solid var(--color-divider)",
        borderBottom: "1px solid var(--color-divider)",
      }}
    >
      <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-neutral-500)" }}>
        {t("collect.panelTitle")}
      </strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {collections.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8.4, fontSize: 12.5, flexWrap: "wrap" }}>
            <span className={statusTag(c.status)}>{t(`collect.status.${c.status}`)}</span>
            <span style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{c.domain}</span>
            <span style={{ color: "var(--color-neutral-500)" }}>{new Date(c.started_at).toLocaleString(locale)}</span>
            {c.status === "collecting" && c.ends_at && (
              <span style={{ color: "var(--color-neutral-500)" }}>
                {t("collect.until", { time: new Date(c.ends_at).toLocaleTimeString(locale) })}
              </span>
            )}
            {(c.status === "collected" || c.status === "done") && (
              <span style={{ color: "var(--color-neutral-500)" }}>
                {t("collect.linesCollected", { count: c.lines_count })}
              </span>
            )}
            {c.status === "done" && c.suggestion_id && (
              <Link to="/suggestions" className="tag tag-accent">
                {t("collect.viewSuggestion")}
              </Link>
            )}
            {c.status === "failed" && c.message && (
              <span style={{ color: "var(--color-accent-300)" }}>{c.message}</span>
            )}
            {ACTIVE.has(c.status) && (
              <button type="button" className="btn btn-ghost" disabled={busyId === c.id} onClick={() => stop(c.id)}>
                {busyId === c.id ? "…" : t("collect.stopButton")}
              </button>
            )}
            {c.status === "collected" && (
              <button type="button" className="btn btn-ghost" disabled={busyId === c.id} onClick={() => generate(c.id)}>
                {busyId === c.id ? "…" : t("collect.generateButton")}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

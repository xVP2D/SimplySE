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

// One run's row, shared by a standalone collection and a scan's members.
function CollectionRow({
  c,
  busy,
  onStop,
  onGenerate,
}: {
  c: Collection;
  busy: boolean;
  onStop: () => void;
  onGenerate: () => void;
}) {
  const { t, locale } = useTranslation();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8.4, fontSize: 12.5, flexWrap: "wrap" }}>
      <span className={statusTag(c.status)}>{t(`collect.status.${c.status}`)}</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{c.domain}</span>
      <span style={{ color: "var(--color-neutral-500)" }}>{new Date(c.started_at).toLocaleString(locale)}</span>
      {c.status === "collecting" && c.ends_at && (
        <span style={{ color: "var(--color-neutral-500)" }}>{t("collect.until", { time: new Date(c.ends_at).toLocaleTimeString(locale) })}</span>
      )}
      {(c.status === "collected" || c.status === "done") && (
        <span style={{ color: "var(--color-neutral-500)" }}>{t("collect.linesCollected", { count: c.lines_count })}</span>
      )}
      {c.status === "done" && c.suggestion_id && (
        <Link to={`/suggestions?id=${c.suggestion_id}`} className="tag tag-accent">
          {t("collect.viewSuggestion")}
        </Link>
      )}
      {c.status === "failed" && c.message && <span style={{ color: "var(--color-danger)" }}>{c.message}</span>}
      {ACTIVE.has(c.status) && (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onStop}>
          {busy ? "…" : t("collect.stopButton")}
        </button>
      )}
      {c.status === "collected" && (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onGenerate}>
          {busy ? "…" : t("collect.generateButton")}
        </button>
      )}
    </div>
  );
}

// A block of collections started together by one "scan every rule on this
// machine" run (see ScanMachineButton): one domain per row, plus a stop-all
// and a generate-all action for the group as a whole.
function ScanGroup({
  scanId,
  members,
  busyId,
  onStop,
  onGenerate,
  onStopAll,
  onGenerateAll,
}: {
  scanId: string;
  members: Collection[];
  busyId: string | null;
  onStop: (id: string) => void;
  onGenerate: (id: string) => void;
  onStopAll: (scanId: string) => void;
  onGenerateAll: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const hasActive = members.some((c) => ACTIVE.has(c.status));
  const readyIds = members.filter((c) => c.status === "collected").map((c) => c.id);
  const busyGroup = busyId === scanId;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8.4,
        borderRadius: 6,
        background: "var(--color-sunken)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8.4, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          <i className="ph ph-radar" /> {t("scan.groupTitle", { count: members.length })}
        </span>
        <span style={{ display: "flex", gap: 6.4 }}>
          {hasActive && (
            <button type="button" className="btn btn-ghost" disabled={busyGroup} onClick={() => onStopAll(scanId)}>
              {busyGroup ? "…" : t("scan.stopAllButton")}
            </button>
          )}
          {readyIds.length > 0 && (
            <button type="button" className="btn btn-ghost" disabled={busyGroup} onClick={() => onGenerateAll(readyIds)}>
              {busyGroup ? "…" : t("scan.generateAllButton", { count: readyIds.length })}
            </button>
          )}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4.8, paddingLeft: 4.8 }}>
        {members.map((c) => (
          <CollectionRow key={c.id} c={c} busy={busyId === c.id} onStop={() => onStop(c.id)} onGenerate={() => onGenerate(c.id)} />
        ))}
      </div>
    </div>
  );
}

// Shows this agent's "collect every denial of a domain" runs (see
// CollectDomainButton and ScanMachineButton) so an operator can see one in
// progress (and stop it early) and find the suggestion it produced. Runs a
// "scan every rule" started together group under one heading.
export function CollectionsPanel({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const { t } = useTranslation();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    api
      .listCollections({ agentId, limit: 40 })
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

  const stopAll = async (scanId: string) => {
    setBusyId(scanId);
    try {
      await api.stopScan(scanId);
      load();
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

  if (collections.length === 0) return null;

  // One block per scan_id (in first-seen order), everything else standalone —
  // the list itself already comes back active-first, most-recent-first.
  type Block = { key: string; scanId?: string; rows: Collection[] };
  const blocks: Block[] = [];
  const blockOf = new Map<string, Block>();
  for (const c of collections) {
    const key = c.scan_id ? `scan:${c.scan_id}` : `solo:${c.id}`;
    let block = blockOf.get(key);
    if (!block) {
      block = { key, scanId: c.scan_id, rows: [] };
      blockOf.set(key, block);
      blocks.push(block);
    }
    block.rows.push(c);
  }

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
      <strong style={{ fontSize: 13, fontWeight: 600, color: "var(--color-neutral-400)" }}>{t("collect.panelTitle")}</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {blocks.map((b) =>
          b.scanId ? (
            <ScanGroup key={b.key} scanId={b.scanId} members={b.rows} busyId={busyId} onStop={stop} onGenerate={generate} onStopAll={stopAll} onGenerateAll={generateAll} />
          ) : (
            <CollectionRow key={b.key} c={b.rows[0]} busy={busyId === b.rows[0].id} onStop={() => stop(b.rows[0].id)} onGenerate={() => generate(b.rows[0].id)} />
          ),
        )}
      </div>
    </div>
  );
}

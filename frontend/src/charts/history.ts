import type { HistoryResponse, MeasureDef, Row } from "./types.ts";

// Every chart of a page (and every tile of the gallery) asks for the same few
// slices of history; a short-lived cache of the in-flight or finished request
// keeps that to one round trip each.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<HistoryResponse> }>();

export interface HistoryParams {
  days: number;
  bucket: string;
  group: string[];
}

export function fetchHistory(dataset: string, p: HistoryParams): Promise<HistoryResponse> {
  const qs = new URLSearchParams({ days: String(p.days), bucket: p.bucket });
  if (p.group.length) qs.set("group", p.group.join(","));
  const key = `${dataset}?${qs.toString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetch(`/api/history/${dataset}?${qs.toString()}`).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `history request failed with ${res.status}`);
    }
    return (await res.json()) as HistoryResponse;
  });
  cache.set(key, { at: Date.now(), promise });
  // a failed request must not be served from the cache for the next minute
  promise.catch(() => cache.delete(key));
  return promise;
}

export interface HistoryStatus {
  retention_days: number;
  datasets: { dataset: string; since: string | null; rows: number; total: number }[];
}

export async function fetchHistoryStatus(): Promise<HistoryStatus> {
  const res = await fetch("/api/history");
  if (!res.ok) throw new Error(`history status failed with ${res.status}`);
  return (await res.json()) as HistoryStatus;
}

// Normalises API rows for shaping. `value` is the chosen measure; `weight` is
// what averaging weights it by (the sample count for the fleet).
export function toRows(resp: HistoryResponse, measure: MeasureDef): Row[] {
  const group = resp.group;
  return resp.rows.map((r) => {
    const raw: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) if (typeof v === "number" && k !== "t") raw[k] = v;
    const dims: Record<string, string> = {};
    for (const g of group) dims[g] = String(r[g] ?? "");
    const value = Number(r[measure.field] ?? 0) * (measure.scale ?? 1);
    const weight = measure.additive ? value : Number(r.samples ?? 1);
    return { t: typeof r.t === "number" ? r.t : null, dims, value, weight, raw };
  });
}
